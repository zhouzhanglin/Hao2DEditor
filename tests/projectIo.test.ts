import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_EXTENSION, projectNameFromPath, serializeDocument, serializeProject } from '@core/codec/projectJson'
import { createEmptyDocument } from '@core/model/authoring'
import { createSampleDocument } from '@core/sample'
import { DEFAULT_PROJECT_NAME, useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'

/**
 * 假平台：只实现工程读写用到的部分。
 * 用 vi.hoisted 保证 Mock 工厂（会被提升到文件顶部）能拿到同一份状态。
 */
const env = vi.hoisted(() => ({
  files: new Map<string, string>(),
  recents: [] as string[],
  savePath: null as string | null,
  saveOptions: null as { defaultPath?: string } | null,
  /** 被登记为资源根的目录（缩略图走 hao2d-file:// 协议读文件的前提） */
  assetRoots: [] as string[],
  /** 图片 URL 缓存被释放的次数（新建项目 / 导入资源会顺带清掉上一份图片） */
  imageCacheReleases: 0
}))

vi.mock('@editor/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editor/platform')>()
  return {
    ...actual,
    getPlatform: () => ({
      isElectron: true,
      platform: 'test',
      readText: async (p: string) => env.files.get(p) ?? '',
      writeText: async (p: string, text: string) => {
        env.files.set(p, text)
      },
      exists: async (p: string) => env.files.has(p),
      recentList: async () => [...env.recents],
      recentAdd: async (p: string) => {
        env.recents = [p, ...env.recents.filter((v) => v !== p)]
      },
      pickSavePath: async (options?: { defaultPath?: string }) => {
        env.saveOptions = options ?? null
        return env.savePath
      },
      registerAssetRoot: async (dir: string) => {
        env.assetRoots.push(dir)
      },
      pickFiles: async () => [],
      /** AI 连接信息：openProjectAt / saveProject 写 server.json 前会问主进程（这里返回「没在跑」） */
      aiMcpInfo: async () => ({ ok: true, data: { running: false } }),
      /** 新建项目 / 导入时会释放图片 URL 缓存（这里没有真的 URL 缓存，记个次数就够） */
      releaseImageCache: () => {
        env.imageCacheReleases++
      }
    })
  }
})

const { createProjectAt, lastProject, newProject, openProjectAt, saveProject } = await import(
  '@editor/services/projectIo'
)

describe('工程文件后缀', () => {
  it('使用 .hao2d.proj', () => {
    expect(PROJECT_EXTENSION).toBe('hao2d.proj')
  })
})

describe('启动时恢复上次工程', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.savePath = null
    env.saveOptions = null
  })

  it('没有历史记录时返回 null（保持空白工程）', async () => {
    expect(await lastProject()).toBeNull()
  })

  it('上次的工程已被删除 / 移动时返回 null', async () => {
    env.recents = ['/proj/moved.hao2d.proj']
    expect(await lastProject()).toBeNull()
  })

  it('上次的工程仍在时返回该路径', async () => {
    env.files.set('/proj/hero.hao2d.proj', serializeDocument(createSampleDocument()))
    env.recents = ['/proj/hero.hao2d.proj']
    expect(await lastProject()).toBe('/proj/hero.hao2d.proj')
  })
})

describe('打开工程', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.assetRoots = []
    newProject()
  })

  it('解析失败时不动当前文档，并给出可读错误', async () => {
    useProjectStore.getState().setDocument(createSampleDocument(), null, false)
    const before = useProjectStore.getState().document.bones.length
    env.files.set('/proj/broken.hao2d.proj', '{ this is not json')

    const result = await openProjectAt('/proj/broken.hao2d.proj')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('解析失败')
    expect(useProjectStore.getState().document.bones.length).toBe(before)
  })

  it('成功后替换文档并写入最近列表', async () => {
    const sample = createSampleDocument()
    env.files.set('/proj/hero.hao2d.proj', serializeDocument(sample))

    const result = await openProjectAt('/proj/hero.hao2d.proj')

    expect(result.ok).toBe(true)
    expect(useProjectStore.getState().projectPath).toBe('/proj/hero.hao2d.proj')
    expect(useProjectStore.getState().document.bones.length).toBe(sample.bones.length)
    expect(env.recents[0]).toBe('/proj/hero.hao2d.proj')
  })

  it('打开工程后把 AI 陪伴文件写进工程 ai/ 子目录（文档 + 手册；服务没跑则不写 server.json）', async () => {
    const sample = createSampleDocument()
    env.files.set('/proj/hero.hao2d.proj', serializeDocument(sample))

    const result = await openProjectAt('/proj/hero.hao2d.proj')

    expect(result.ok).toBe(true)
    // 文档与手册来自 docs/*.md 的构建期内联（@shared/aiGuides），断言真实内容的特征串
    expect(env.files.get('/proj/ai/hao2d-ai-command-api.md')).toContain('Hao2DEditor')
    expect(env.files.get('/proj/ai/hao2d-ai-playbook.md')).toContain('动画制作手册')
    // 命令服务没在跑（aiMcpInfo running=false）：连接信息不写，避免留下失效 token
    expect(env.files.has('/proj/ai/hao2d-ai-server.json')).toBe(false)
  })

  it('打开工程时登记工程目录与图片目录（资源面板缩略图靠它才能读文件）', async () => {
    const sample = createEmptyDocument()
    env.files.set(
      '/proj/hero.hao2d.proj',
      serializeDocument({
        ...sample,
        images: [
          { name: 'bg', path: 'images/bg.png', width: 10, height: 10, loose: true },
          // 老工程可能引用工程目录之外的图片（绝对路径）
          { name: 'icon', path: '/shared/icon.png', width: 8, height: 8, loose: false }
        ]
      })
    )
    env.assetRoots = []

    const result = await openProjectAt('/proj/hero.hao2d.proj')

    expect(result.ok).toBe(true)
    expect(env.assetRoots).toContain('/proj')
    expect(env.assetRoots).toContain('/proj/images')
    expect(env.assetRoots).toContain('/shared')
    // 相对路径在打开时就解析成绝对路径
    expect(useProjectStore.getState().document.images[0].path).toBe('/proj/images/bg.png')
  })
})

describe('保存工程', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.savePath = null
    env.saveOptions = null
    newProject()
  })

  it('默认文件名用骨架名 + .hao2d.proj', async () => {
    useProjectStore.getState().setDocument(createSampleDocument(), null, false)
    env.savePath = '/proj/out.hao2d.proj'

    await saveProject(true)

    expect(env.saveOptions?.defaultPath).toBe('sample-hero.hao2d.proj')
  })

  it('骨架名为空时退回 project.hao2d.proj', async () => {
    // createEmptyDocument 默认叫 armature，这里显式清空来验证兜底
    useProjectStore.getState().setDocument({ ...createEmptyDocument(), armatureName: '  ' }, null, false)
    env.savePath = '/proj/out.hao2d.proj'

    await saveProject(true)

    expect(env.saveOptions?.defaultPath).toBe('project.hao2d.proj')
  })

  it('用户没写后缀时自动补上 .hao2d.proj', async () => {
    env.savePath = '/proj/noext'

    const result = await saveProject(true)

    expect(result.ok).toBe(true)
    expect(env.files.has('/proj/noext.hao2d.proj')).toBe(true)
    expect(useProjectStore.getState().projectPath).toBe('/proj/noext.hao2d.proj')
  })

  it('写了别的后缀时替换成 .hao2d.proj（.json 除外，兼容老工程）', async () => {
    env.savePath = '/proj/foo.hao2d'
    await saveProject(true)
    expect(useProjectStore.getState().projectPath).toBe('/proj/foo.hao2d.proj')

    env.savePath = '/proj/legacy.json'
    await saveProject(true)
    expect(useProjectStore.getState().projectPath).toBe('/proj/legacy.json')
  })
})

describe('多骨架工程的保存 / 打开', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.savePath = null
    env.saveOptions = null
  })

  it('保存写出全部骨架与共享图片池，重新打开能逐个还原', async () => {
    const pool = [{ name: 'tex', path: '/img/tex.png', width: 8, height: 8, loose: false }]
    useProjectStore.getState().setDocument({ ...createEmptyDocument('骨架A'), images: pool }, '/proj/multi.hao2d.proj', false)

    // 第二个骨架：改帧率，验证「各自的动画 / 数据互相独立」
    useProjectStore.getState().addSkeleton('骨架B')
    useProjectStore.getState().update('改帧率', (draft) => {
      draft.frameRate = 60
    })
    useProjectStore.getState().addSkeleton('骨架C')

    const before = useProjectStore.getState()
    expect(before.skeletons.length).toBe(3)
    // 图片池共享：三个骨架指向同一个数组
    expect(before.skeletons[0].images).toBe(before.skeletons[2].images)

    const saved = await saveProject(false)
    expect(saved.ok).toBe(true)
    const raw = JSON.parse(env.files.get('/proj/multi.hao2d.proj') ?? '{}') as Record<string, unknown>
    expect(raw.activeSkeleton).toBe(2)
    expect((raw.skeletons as unknown[]).length).toBe(3)

    const opened = await openProjectAt('/proj/multi.hao2d.proj')
    expect(opened.ok).toBe(true)
    const after = useProjectStore.getState()
    expect(after.skeletons.map((skeleton) => skeleton.armatureName)).toEqual(['骨架A', '骨架B', '骨架C'])
    expect(after.activeSkeleton).toBe(2)
    expect(after.skeletons[1].frameRate).toBe(60)
    expect(after.skeletons[0].frameRate).toBe(30)
    // 打开后图片池仍然只有一个（同一个数组）
    expect(after.skeletons[0].images).toBe(after.skeletons[1].images)
    expect(after.skeletons[0].images[0]?.name).toBe('tex')
  })
})

describe('皮肤随工程文件走', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.savePath = null
    env.saveOptions = null
  })

  it('切换皮肤 → 保存 → 重新打开，恢复上次的皮肤', async () => {
    useProjectStore.getState().setDocument(createEmptyDocument('角色'), '/proj/skin.hao2d.proj', false)
    useProjectStore.getState().update('新建皮肤', (draft) => {
      draft.skins.push({ name: 'skin1', slots: draft.slots.map((slot) => ({ slot: slot.name, attachments: [] })) })
    })
    useProjectStore.getState().setActiveSkin('skin1')
    expect(useSelectionStore.getState().skin).toBe('skin1')

    expect((await saveProject(false)).ok).toBe(true)
    // 单骨架工程：骨架字段平铺在顶层，`editorMeta.activeSkin` 直接写在文件里
    const raw = JSON.parse(env.files.get('/proj/skin.hao2d.proj') ?? '{}') as {
      editorMeta: { activeSkin: string }
    }
    expect(raw.editorMeta.activeSkin).toBe('skin1')

    // 模拟重开工程：先把选中态改回默认，打开后必须回到工程里记的那个皮肤
    useSelectionStore.getState().select({ skin: '' })
    expect((await openProjectAt('/proj/skin.hao2d.proj')).ok).toBe(true)
    expect(useSelectionStore.getState().skin).toBe('skin1')
  })

  it('文件里的皮肤已经不存在（被删 / 改名）时退回默认皮肤', async () => {
    const doc = createEmptyDocument('角色')
    doc.editorMeta.activeSkin = 'gone'
    env.files.set('/proj/stale.hao2d.proj', serializeProject([doc], 0, 'stale'))

    expect((await openProjectAt('/proj/stale.hao2d.proj')).ok).toBe(true)
    expect(useSelectionStore.getState().skin).toBe('')
  })
})

describe('新建项目（弹窗确认后）', () => {
  beforeEach(() => {
    env.files.clear()
    env.recents = []
    env.savePath = null
    env.saveOptions = null
    env.imageCacheReleases = 0
  })

  it('默认项目名 hao2dProject + 默认一根 root（快捷新建与弹窗流程一致）', () => {
    useProjectStore.getState().setProjectInfo({ projectName: 'x', projectPath: '/tmp/x.hao2d.proj' })
    newProject()
    const state = useProjectStore.getState()
    expect(state.projectName).toBe(DEFAULT_PROJECT_NAME)
    expect(state.projectPath).toBeNull()
    expect(state.document.bones.map((bone) => bone.name)).toEqual(['root'])
    // 换项目要把上一份的图片 / 图集内存一起放掉
    expect(env.imageCacheReleases).toBe(1)
  })

  it('项目名 / 保存位置都不能为空；成功后立刻写出工程文件', async () => {
    expect((await createProjectAt('   ', '/proj')).ok).toBe(false)
    expect((await createProjectAt('dragon', '')).ok).toBe(false)
    // 参数不合法时什么都没动（包括图片缓存）
    expect(env.imageCacheReleases).toBe(0)

    const result = await createProjectAt('dragon', '/proj')
    expect(result.ok).toBe(true)
    expect(env.imageCacheReleases).toBe(1)
    const state = useProjectStore.getState()
    expect(state.projectName).toBe('dragon')
    expect(state.projectPath).toBe('/proj/dragon.hao2d.proj')
    expect(state.skeletons).toHaveLength(1)
    // 新项目默认带一根 root，且是共享图片池的单骨架项目
    expect(state.skeletons[0].bones.map((bone) => bone.name)).toEqual(['root'])
    expect(state.skeletons[0].images).toEqual([])
    const raw = JSON.parse(env.files.get('/proj/dragon.hao2d.proj') ?? '{}') as Record<string, unknown>
    expect(raw.projectName).toBe('dragon')
  })

  it('项目名里的非法文件名字符会被替换成下划线', async () => {
    const result = await createProjectAt('a/b:c', '/proj')
    expect(result.ok).toBe(true)
    expect(useProjectStore.getState().projectPath).toBe('/proj/a_b_c.hao2d.proj')
  })
})

describe('项目名（导出目录 / 图集名 / 图集页名都跟它走）', () => {
  it('已命名的工程：导入资源（setDocument）不会把项目名换成骨架名', () => {
    const store = useProjectStore.getState()
    store.setProjectInfo({ projectName: 'MyGame', projectPath: '/proj/MyGame.hao2d.proj' })
    store.setDocument({ ...createEmptyDocument('Rooster'), images: [] }, null, false)
    expect(useProjectStore.getState().projectName).toBe('MyGame')
  })

  it('还没起名的会话：先按骨架名兜底（导入流程随后会用被导入文件的名字覆盖）', () => {
    useProjectStore.getState().reset()
    useProjectStore.getState().setDocument({ ...createEmptyDocument('Rooster'), images: [] }, null, false)
    expect(useProjectStore.getState().projectName).toBe('Rooster')
  })

  it('老工程没有 projectName 字段时，用工程文件名兜底', () => {
    expect(projectNameFromPath('/proj/My.Game.hao2d.proj')).toBe('My.Game')
    expect(projectNameFromPath('C:\\proj\\legacy.hao2dproj')).toBe('legacy')
    expect(projectNameFromPath('mem:/x.json')).toBe('x')
    expect(projectNameFromPath('/proj/noext')).toBe('noext')
  })
})
