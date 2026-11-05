import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { compileDocument } from '@core/codec/compile'
import { serializeRuntimeAtlas, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import { createSampleDocument } from '@core/sample'
import { AttachmentType } from '@core/model/types'
import type { RuntimeAsset } from '@core/model/asset'
import { prepareRuntimeExport, THREEJS_DEMO_FILE, THREEJS_RUNTIME_FILE, writeThreejsExport } from '@editor/services/exportService'
import { useProjectStore } from '@editor/store/projectStore'
import type { EditorDocument } from '@core/model/authoring'
import { createView } from '../src/main/preview/threejsRuntime'
import type { Hao2dView } from '../src/main/preview/threejsRuntime'

/** three.js 运行库直接吃编辑器的 ske/atlas 文本；node 环境没有 Image，自动回落到 1×1 白图 */
const atlasText = serializeRuntimeAtlas({ format: 'hao2d-atlas', version: 1, pages: [], regions: [] })

function sampleAsset(): RuntimeAsset {
  return compileDocument(createSampleDocument()).asset
}

interface Fixture {
  skeText: string
  asset: RuntimeAsset
  slotName: string
  extraName: string
}

/** 示例工程 + 一个额外附件，用来验证「按名字 / 按下标」两种换装 */
function fixture(): Fixture {
  const asset = sampleAsset()
  const slot = asset.skins[0].slots[0]
  const base = slot.attachments[0]
  const extraName = 'extra-attachment'
  slot.attachments.push({ ...base, name: extraName })
  return {
    skeText: serializeRuntimeSke(asset, { atlasFileName: 'hero_atlas.json' }),
    asset,
    slotName: slot.slotName,
    extraName
  }
}

async function makeView(skeText: string, nested: Array<{ armatureName: string; skeText: string }> = []): Promise<Hao2dView> {
  return createView({ pages: [], skeText, atlasText, nested })
}

describe('three.js 运行库：IHao2DView 换装 / 显隐 / 显示下标', () => {
  it('皮肤 / 插槽 / 附件都能按名字或下标查询', async () => {
    const data = fixture()
    const view = await makeView(data.skeText)
    try {
      const si = view.findSlotIndex(data.slotName)
      expect(si).toBeGreaterThanOrEqual(0)
      expect(view.findSlotIndex('不存在的插槽')).toBe(-1)
      expect(view.slotNames).toContain(data.slotName)
      expect(view.attachmentNames(si)).toContain(data.extraName)
      expect(view.findAttachmentIndex(si, data.extraName)).toBeGreaterThanOrEqual(0)
      expect(view.findAttachmentIndex(si, '不存在的附件')).toBe(-1)
      expect(view.findAttachmentIndex(9999, data.extraName)).toBe(-1)
      expect(view.skins.length).toBeGreaterThan(0)
      expect(view.animations.length).toBeGreaterThan(0)
      // 骨架对象是只读引用，但可以直接读内部状态做调试
      expect(view.skeleton.slotCount).toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })

  it('SetSkin：名字不存在返回 false 并保持现状；空名 = 基底皮肤', async () => {
    const data = fixture()
    const view = await makeView(data.skeText)
    try {
      const before = view.activeSkin
      expect(view.setSkin('没有这个皮肤')).toBe(false)
      expect(view.activeSkin).toBe(before)
      expect(view.setSkin('')).toBe(true)
      expect(view.activeSkin).toBe('')
    } finally {
      view.destroy()
    }
  })

  it('SetSlotAttachment / SetSlotVisible / SetSlotDisplayIndex 与状态读回一致', async () => {
    const data = fixture()
    const view = await makeView(data.skeText)
    try {
      const si = view.findSlotIndex(data.slotName)
      const names = view.attachmentNames(si)
      const extraIndex = view.findAttachmentIndex(si, data.extraName)

      expect(view.setSlotAttachment(data.slotName, data.extraName)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      expect(view.setSlotAttachment(si, '不存在的附件')).toBe(false)
      expect(view.setSlotAttachment(9999, data.extraName)).toBe(false)
      expect(view.setSlotAttachment(si, -1)).toBe(false)

      // 按名字 / 按下标换装等价
      expect(view.setSlotAttachment(si, extraIndex)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      expect(view.setSlotAttachment(si, names[0])).toBe(true)

      expect(view.setSlotVisible(data.slotName, false)).toBe(true)
      expect(view.skeleton.slotVisible[si]).toBe(0)
      expect(view.setSlotVisible(si, true)).toBe(true)
      expect(view.skeleton.slotVisible[si]).toBe(1)
      expect(view.setSlotVisible('不存在的插槽', false)).toBe(false)

      expect(view.setSlotDisplayIndex(si, -1)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(-1)
      expect(view.setSlotDisplayIndex(si, extraIndex, true)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      // 与 Unity 端一致：displayIndex 不做上界校验，越界只是该插槽不画
      expect(view.setSlotDisplayIndex(si, names.length, true)).toBe(true)
      expect(view.setSlotDisplayIndex('不存在的插槽', 0)).toBe(false)

      // 换肤后按名字重放换装：装备不会被皮肤切换悄悄还原
      expect(view.clearSlotDisplayOverride(si)).toBe(true)
      expect(view.setSlotAttachment(si, data.extraName)).toBe(true)
      expect(view.setSkin('')).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)

      expect(view.setSlotDisplayIndex(si, extraIndex, true)).toBe(true)
      expect(view.clearSlotDisplayOverride(si)).toBe(true)
      expect(view.clearSlotAttachmentOverride(si)).toBe(true)
      expect(view.clearSlotVisibleOverride(si)).toBe(true)
      expect(view.clearSlotDisplayOverride(9999)).toBe(false)

      // 每帧推进不抛错（node 里只更新几何 / 渲染顺序，不创建 WebGLRenderer）
      view.update(0.016)
      expect(Number.isFinite(view.time)).toBe(true)
      expect(view.duration).toBeGreaterThanOrEqual(0)
    } finally {
      view.destroy()
    }
  })

  it('播放控制：play / pause / seek / speed 都能驱动', async () => {
    const data = fixture()
    const view = await makeView(data.skeText)
    try {
      expect(view.playing).toBe(true)
      expect(view.play(view.defaultAnimation, true)).toBe(true)
      view.pause()
      expect(view.playing).toBe(false)
      view.resume()
      expect(view.playing).toBe(true)
      view.setSpeed(0.5)
      view.setLoop(false)
      view.seek(0.1)
      view.update(0.1)
      expect(view.time).toBeGreaterThan(0)
      view.setProgress(0.5)
      view.stop()
      expect(view.playing).toBe(false)
    } finally {
      view.destroy()
    }
  })

  it('无嵌套时 GetNested / HasNested / nestedCount / 扩展方法都安全返回空', async () => {
    const data = fixture()
    const view = await makeView(data.skeText)
    try {
      expect(view.nestedSlotNames).toEqual([])
      expect(view.nestedCount).toBe(0)
      expect(view.getNested(data.slotName)).toBeNull()
      expect(view.hasNested(data.slotName)).toBe(false)
      expect(view.setNestedSkin(data.slotName, '')).toBe(false)
      expect(view.setNestedSlotVisible(data.slotName, 0, false)).toBe(false)
      expect(view.setNestedSlotDisplayIndex(data.slotName, 0, -1)).toBe(false)
      expect(view.setNestedSlotAttachment(data.slotName, 0, data.extraName)).toBe(false)
    } finally {
      view.destroy()
    }
  })

  it('GetNested：Armature 附件被显示时拿到子骨架视图，可直接操作内部插槽', async () => {
    const parent = sampleAsset()
    const child = sampleAsset()
    child.armatureName = 'child-armature'

    const skinSlot = parent.skins[0].slots[0]
    const base = skinSlot.attachments[0]
    const armatureIndex = skinSlot.attachments.length
    skinSlot.attachments.push({
      ...base,
      name: 'nested',
      type: AttachmentType.Armature,
      subArmature: 'child-armature',
      subAnimation: '',
      subPlayTimes: 0,
      subOffset: 0,
      subSpeed: 1
    })

    const view = await makeView(
      serializeRuntimeSke(parent, { atlasFileName: 'hero_atlas.json' }),
      [{ armatureName: 'child-armature', skeText: serializeRuntimeSke(child, { atlasFileName: 'hero_atlas.json' }) }]
    )
    try {
      expect(view.nestedSlotNames).toContain(skinSlot.slotName)
      expect(view.setSlotDisplayIndex(skinSlot.slotName, armatureIndex, true)).toBe(true)
      view.update(0)

      const nested = view.getNested(skinSlot.slotName)
      expect(nested).not.toBeNull()
      expect(view.hasNested(skinSlot.slotName)).toBe(true)
      expect(view.nestedCount).toBe(1)
      expect(nested!.slotNames.length).toBeGreaterThan(0)
      expect(nested!.skeleton.slotCount).toBeGreaterThan(0)
      // Hao2DViewExtensions 的对等实现：直接操作子骨架内部
      expect(view.setNestedSlotVisible(skinSlot.slotName, nested!.slotNames[0], false)).toBe(true)
      expect(view.setNestedSlotDisplayIndex(skinSlot.slotName, 0, -1, true)).toBe(true)
      expect(view.setNestedSkin(skinSlot.slotName, '')).toBe(true)

      // 隐藏该插槽 → 子骨架不再暴露
      expect(view.setSlotVisible(skinSlot.slotName, false)).toBe(true)
      expect(view.getNested(skinSlot.slotName)).toBeNull()
    } finally {
      view.destroy()
    }
  })
})

/**
 * 「导出 Three.js」= 「导出运行时数据」+ 单文件运行库 + 示例页。
 * 平台层在这里换成内存写入，避免真的往磁盘写东西。
 */
const written = vi.hoisted(() => ({ files: [] as Array<{ path: string; text?: string; bytes?: Uint8Array }> }))
vi.mock('@editor/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editor/platform')>()
  // 基于真实的内存平台，只替换写盘那两个方法：别的方法保持可用，避免影响其它模块的初始化
  const base = actual.getPlatform()
  Object.assign(base, {
    revealInFolder: async () => undefined,
    writeBatch: async (files: Array<{ path: string; text?: string; bytes?: Uint8Array }>) => {
      written.files.push(...files)
    }
  })
  return { ...actual, getPlatform: () => base }
})

function documentWithImages(): EditorDocument {
  const doc = createSampleDocument()
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) attachment.image = `${attachment.name}.png`
    }
  }
  doc.images = [{ name: 'head.png', path: '/art/head.png', width: 64, height: 64, loose: true }]
  return doc
}

describe('导出 Three.js：产物里带可运行库', () => {
  it('writeThreejsExport 在原有数据之外追加 hao2d-three.js 与 demo.html', async () => {
    written.files.length = 0
    useProjectStore.getState().setDocument(documentWithImages(), null, false)
    useProjectStore.getState().setProjectInfo({ projectName: 'three-demo' })
    const plan = prepareRuntimeExport({ scale: 1, maxSize: 512 })

    const result = await writeThreejsExport('/export', plan)
    expect(result.ok).toBe(true)
    const paths = written.files.map((file) => file.path)
    expect(paths.some((path) => path.endsWith(`/${THREEJS_RUNTIME_FILE}`))).toBe(true)
    expect(paths.some((path) => path.endsWith(`/${THREEJS_DEMO_FILE}`))).toBe(true)
    expect(paths.some((path) => path.endsWith(plan.skeletons[0].fileName))).toBe(true)
    expect(paths.some((path) => path.endsWith(plan.atlasName))).toBe(true)

    const library = written.files.find((file) => file.path.endsWith(`/${THREEJS_RUNTIME_FILE}`))?.text ?? ''
    expect(library).toContain('Hao2dThreeRuntime')
    expect(library.length).toBeGreaterThan(1000)
    // 只含 hao2d 功能：three 不打进运行库（宿主的全局 THREE 提供）
    expect(library.length).toBeLessThan(200_000)
    expect(library).toContain('THREE NOT bundled')
    // 导出包里的运行库 = 随 App 分发的 resources/runtimes/hao2d-three.js（同一份文本，不许漂移）
    const distributed = readFileSync(new URL('../resources/runtimes/hao2d-three.js', import.meta.url), 'utf8')
    expect(library).toBe(distributed)
    const demo = written.files.find((file) => file.path.endsWith(`/${THREEJS_DEMO_FILE}`))?.text ?? ''
    expect(demo).toContain(THREEJS_RUNTIME_FILE)
    expect(demo).toContain('Hao2dThreeRuntime.createStage')
    expect(demo).toContain(plan.skeletons[0].fileName)
    // 示例页需要自己提供 three：优先 window.THREE，没有才从 CDN 取
    expect(demo).toContain('window.THREE')
    expect(demo).toContain("import('three')")
  })
})
