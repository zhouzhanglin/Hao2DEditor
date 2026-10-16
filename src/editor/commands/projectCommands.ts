import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useSettingsStore } from '../store/settingsStore'
import { useTimelineStore } from '../store/timelineStore'
import { useToolStore } from '../store/toolStore'
import { dirName } from '../platform'
import {
  createProjectAt,
  importDragonBonesFlow,
  importImagesFlow,
  importSpineFlow,
  newProject,
  openProjectAt,
  saveProject
} from '../services/projectIo'
import { prepareRuntimeExport, writeHao2dExport, writeRuntimeExport } from '../services/exportService'
import { writeSpineExport } from '../services/spineExport'
import { requireAnimation } from './animOps'
import { changed, defineAction, defineWrite, unchanged } from './registry'
import { need, needNum, optBool, optNum, optNumList, optText, optTextList, rawText } from './args'
import { syncDuration } from '../timeline/model'
import type { AuthoringAnimData } from '@core/model/authoring'
import type { EventKeyframe } from '@core/model/animation'

/**
 * 补齐「编辑器有、AI 没有」的那批操作：工程文件生命周期、多骨架管理、皮肤、播放头 /
 * 事件帧、导出、撤销重做。
 *
 * 这些能力原先只存在于 UI / 服务层（菜单、弹窗、面板按钮），这里给 AI 第二条入口：
 * - 工程级操作用 `defineAction`（自己调 store 与服务，且**不弹任何原生对话框**）；
 * - 纯文档编辑（皮肤、事件帧）用 `defineWrite`，复用「草稿上改、成功才记账」的历史语义；
 * - 切换骨架 / 皮肤、播放头、导出这类**非文档编辑**显式回报 `changed: false`，不留撤销记录。
 */

/**
 * 切换骨架后的收尾：选中项、待绑定状态、时间轴动画名都还指向**旧骨架**里的对象或名字，
 * 不清会留下「选中的骨骼已经不存在」这类幽灵状态（与 App 的 resetForSkeletonChange 一致）。
 */
function resetForSkeletonChange(): void {
  useSelectionStore.getState().clear()
  useToolStore.getState().setPendingWeightBone(null)
  useTimelineStore.getState().setAnimation(null)
  getActiveScene()?.fit()
}

/** 事件名默认取 `event`、`event2`…（避开已用过的名字，与时间轴的取法一致） */
function nextEventName(events: readonly EventKeyframe[]): string {
  const used = new Set(events.map((event) => event.name))
  if (!used.has('event')) return 'event'
  for (let i = 2; i < 10000; i++) {
    const candidate = `event${i}`
    if (!used.has(candidate)) return candidate
  }
  return `event${events.length + 1}`
}

/** 按时间点找事件帧（时间用 4 位小数舍入，与打帧口径一致） */
function findEvent(animation: AuthoringAnimData, time: number, name?: string): EventKeyframe | undefined {
  return animation.events.find(
    (event) => Math.abs(event.time - time) < 1e-4 && (name === undefined || event.name === name)
  )
}

export function registerProjectCommands(): void {
  // ---------------- 工程文件生命周期 ----------------

  defineAction(
    {
      name: 'newProject',
      title: '新建工程',
      description:
        '新建一个**空白**工程（默认项目名 + 一根根骨骼 root），但不写盘、不留保存路径；要落盘请接着调 saveProject，或直接用 createProject',
      args: {},
      returns: '{ projectName, path }'
    },
    async () => {
      const result = newProject()
      if (!result.ok) throw new Error(result.message)
      const store = useProjectStore.getState()
      return changed({ projectName: store.projectName, path: store.projectPath }, result.message)
    }
  )

  defineAction(
    {
      name: 'createProject',
      title: '新建并存盘工程',
      description:
        '新建工程并**立刻写出**工程文件到 dir 目录下（文件名为 <name>.hao2d.proj）。新工程图片池是空的，随后的图片靠 importImage / splitAtlas 等补',
      args: {
        name: { type: 'string', description: '项目名（不能为空，也用于工程文件名）', required: true },
        dir: { type: 'string', description: '保存目录（绝对路径）', required: true },
        frameRate: { type: 'number', description: '帧率 24 / 30 / 60；不传用 30' }
      },
      returns: '{ projectName, path }'
    },
    async (args) => {
      const name = need(args, 'name')
      const dir = need(args, 'dir')
      const frameRate = optNum(args, 'frameRate')
      const result = await createProjectAt(name, dir, frameRate)
      if (!result.ok) throw new Error(result.message)
      const store = useProjectStore.getState()
      return changed({ projectName: store.projectName, path: store.projectPath }, result.message)
    }
  )

  defineAction(
    {
      name: 'openProject',
      title: '打开工程',
      description: '打开指定路径的工程文件（按内容解析，不看后缀）。失败时不会动当前文档',
      args: { path: { type: 'string', description: '工程文件绝对路径', required: true } },
      returns: '{ path, skeletons }'
    },
    async (args) => {
      const path = need(args, 'path')
      const result = await openProjectAt(path)
      if (!result.ok) throw new Error(result.message)
      return changed({ path, skeletons: useProjectStore.getState().skeletons.length }, result.message)
    }
  )

  defineAction(
    {
      name: 'saveProject',
      title: '保存工程',
      description:
        '把工程写到磁盘（图片会一并复制到 <工程目录>/images/）。工程已有保存路径时直接写回；否则用 path 指定目标文件。**不会弹保存对话框**',
      args: {
        path: { type: 'string', description: '另存到的文件路径；不传则写回当前工程路径' }
      },
      returns: '{ path, warnings }'
    },
    async (args) => {
      const store = useProjectStore.getState()
      const explicit = optText(args, 'path')
      if (explicit && explicit !== store.projectPath) store.setProjectInfo({ projectPath: explicit })
      if (!explicit && !store.projectPath) {
        throw new Error('工程还没有保存路径：先调 createProject 指定 dir，或给 saveProject 传 path')
      }
      const result = await saveProject(false)
      if (!result.ok) throw new Error(result.message)
      return {
        changed: false,
        data: { path: useProjectStore.getState().projectPath, warnings: result.warnings },
        message: result.message
      }
    }
  )

  // ---------------- 导入外部资源（按路径，不弹对话框） ----------------

  defineAction(
    {
      name: 'importSpine',
      title: '导入 Spine',
      description:
        '按路径导入 Spine 骨骼 JSON（**整份替换**当前文档）。同目录需有 .atlas 图集文件，会被自动读取',
      args: { jsonPath: { type: 'string', description: 'Spine 骨骼 JSON 的绝对路径', required: true } },
      returns: '{ bones, slots, animations }'
    },
    async (args) => {
      const jsonPath = need(args, 'jsonPath')
      const result = await importSpineFlow(jsonPath)
      if (!result.ok) throw new Error(result.message)
      const doc = useProjectStore.getState().document
      return changed(
        { bones: doc.bones.length, slots: doc.slots.length, animations: doc.animations.length },
        result.message
      )
    }
  )

  defineAction(
    {
      name: 'importDragonBones',
      title: '导入 DragonBones',
      description:
        '按路径导入 DragonBones 骨骼 JSON（**整份替换**当前文档）。同目录的 texture_*.json 图集会被自动收集',
      args: { jsonPath: { type: 'string', description: 'DragonBones 骨骼 JSON 的绝对路径', required: true } },
      returns: '{ bones, slots, animations }'
    },
    async (args) => {
      const jsonPath = need(args, 'jsonPath')
      const result = await importDragonBonesFlow(jsonPath)
      if (!result.ok) throw new Error(result.message)
      const doc = useProjectStore.getState().document
      return changed(
        { bones: doc.bones.length, slots: doc.slots.length, animations: doc.animations.length },
        result.message
      )
    }
  )

  defineAction(
    {
      name: 'importImages',
      title: '导入图片',
      description:
        '把多张外部图片按路径登记进图片池（自动去重）。要单张带内容导入用 importImage（支持 dataURL / base64）',
      args: {
        paths: { type: 'array', description: '图片绝对路径数组（png / jpg / webp / gif / bmp）', required: true }
      },
      returns: '{ added, total }'
    },
    async (args) => {
      const paths = optTextList(args, 'paths')
      if (!paths || paths.length === 0) throw new Error('缺少参数 paths（图片绝对路径数组，不能为空）')
      const before = useProjectStore.getState().document.images.length
      const result = await importImagesFlow(paths)
      if (!result.ok) throw new Error(result.message)
      const total = useProjectStore.getState().document.images.length
      return changed({ added: total - before, total }, result.message)
    }
  )

  // ---------------- 多骨架管理 ----------------

  defineAction(
    {
      name: 'addSkeleton',
      title: '新建骨架',
      description: '新建一个空骨架（含根骨骼 root）并切过去。图片池与其它骨架共享',
      args: { name: { type: 'string', description: '骨架名；不传用「骨架 N」' } },
      returns: '{ name, activeSkeleton, count }'
    },
    async (args) => {
      useProjectStore.getState().addSkeleton(optText(args, 'name'))
      resetForSkeletonChange()
      const store = useProjectStore.getState()
      return changed(
        { name: store.document.armatureName, activeSkeleton: store.activeSkeleton, count: store.skeletons.length },
        `已新建骨架「${store.document.armatureName}」`
      )
    }
  )

  defineAction(
    {
      name: 'removeSkeleton',
      title: '删除骨架',
      description: '删除指定下标的骨架（至少保留一个）。不传 index 则删当前骨架',
      args: { index: { type: 'number', description: '骨架下标；不传 = 当前骨架' } },
      returns: '{ count, activeSkeleton }'
    },
    async (args) => {
      const store = useProjectStore.getState()
      if (store.skeletons.length <= 1) throw new Error('项目里至少保留一个骨架')
      const index = optNum(args, 'index') ?? store.activeSkeleton
      if (index < 0 || index >= store.skeletons.length) {
        throw new Error(`骨架下标越界：${index}（现有 ${store.skeletons.length} 个，用 getProjectState 查）`)
      }
      const name = store.skeletons[index]?.armatureName ?? String(index)
      store.removeSkeleton(index)
      resetForSkeletonChange()
      const after = useProjectStore.getState()
      return changed(
        { count: after.skeletons.length, activeSkeleton: after.activeSkeleton },
        `已删除骨架「${name}」`
      )
    }
  )

  defineAction(
    {
      name: 'renameSkeleton',
      title: '重命名骨架',
      description: '改某个骨架的 armatureName（不影响项目名 / 导出目录名）。不传 index 则改当前骨架',
      args: {
        index: { type: 'number', description: '骨架下标；不传 = 当前骨架' },
        name: { type: 'string', description: '新名字', required: true }
      },
      returns: '{ index, name }'
    },
    async (args) => {
      const name = need(args, 'name')
      const store = useProjectStore.getState()
      const index = optNum(args, 'index') ?? store.activeSkeleton
      if (index < 0 || index >= store.skeletons.length) {
        throw new Error(`骨架下标越界：${index}（现有 ${store.skeletons.length} 个）`)
      }
      store.renameSkeleton(index, name)
      return changed({ index, name }, `骨架已重命名为「${name}」`)
    }
  )

  defineAction(
    {
      name: 'setActiveSkeleton',
      title: '切换骨架',
      description: '切换当前编辑的骨架（只换引用，不动数据），并清空针对旧骨架的选中 / 时间轴状态',
      args: { index: { type: 'number', description: '骨架下标', required: true } },
      returns: '{ name, activeSkeleton }'
    },
    async (args) => {
      const index = needNum(args, 'index')
      const store = useProjectStore.getState()
      if (index < 0 || index >= store.skeletons.length) {
        throw new Error(`骨架下标越界：${index}（现有 ${store.skeletons.length} 个）`)
      }
      if (index === store.activeSkeleton) {
        return unchanged(`已经在这个骨架上了：${store.document.armatureName}`)
      }
      const name = store.skeletons[index]?.armatureName ?? String(index)
      store.setActiveSkeleton(index)
      resetForSkeletonChange()
      return changed({ name, activeSkeleton: index }, `已切换到骨架「${name}」`)
    }
  )

  // ---------------- 皮肤 ----------------

  defineWrite(
    {
      name: 'addSkin',
      title: '新建皮肤',
      description: '新建一套空皮肤（每个现有插槽都建一条空附件表），可用于后续打换装帧',
      args: { name: { type: 'string', description: '皮肤名；不传用 skinN' } },
      returns: '{ name }'
    },
    (draft, args) => {
      const base = optText(args, 'name') ?? `skin${draft.skins.length}`
      const taken = new Set(draft.skins.map((skin) => skin.name))
      let name = base
      let index = 2
      while (taken.has(name)) name = `${base}${index++}`
      draft.skins.push({ name, slots: draft.slots.map((slot) => ({ slot: slot.name, attachments: [] })) })
      return changed({ name }, `已新建皮肤「${name}」`)
    }
  )

  defineWrite(
    {
      name: 'renameSkin',
      title: '重命名皮肤',
      description: '改皮肤名（名字被动画的 display 帧按皮肤引用，改名后请检查相关打帧）',
      args: {
        name: { type: 'string', description: '原皮肤名', required: true },
        newName: { type: 'string', description: '新皮肤名', required: true }
      },
      returns: '{ name, newName }'
    },
    (draft, args) => {
      const name = need(args, 'name')
      const newName = need(args, 'newName')
      const skin = draft.skins.find((item) => item.name === name)
      if (!skin) throw new Error(`皮肤不存在：${name}（用 listSkins 查现有皮肤名）`)
      if (draft.skins.some((item) => item.name === newName)) throw new Error(`已有同名皮肤：${newName}`)
      skin.name = newName
      if (draft.editorMeta.activeSkin === name) draft.editorMeta.activeSkin = newName
      return changed({ name, newName }, `皮肤已重命名为「${newName}」`)
    }
  )

  defineAction(
    {
      name: 'removeSkin',
      title: '删除皮肤',
      description: '删除某套皮肤（default 不可删）。若删的是当前皮肤，当前皮肤会退回 default',
      args: { name: { type: 'string', description: '皮肤名', required: true } },
      returns: '{ name, count }'
    },
    async (args) => {
      const name = need(args, 'name')
      const before = useProjectStore.getState()
      if (!before.document.skins.some((skin) => skin.name === name)) {
        throw new Error(`皮肤不存在：${name}（用 listSkins 查现有皮肤名）`)
      }
      if (name === 'default') throw new Error('不能删除默认皮肤 default')
      before.update('删除皮肤', (draft) => {
        draft.skins = draft.skins.filter((skin) => skin.name !== name)
        if (draft.editorMeta.activeSkin === name) draft.editorMeta.activeSkin = ''
      })
      if (useSelectionStore.getState().skin === name) useSelectionStore.getState().select({ skin: '' })
      return changed(
        { name, count: useProjectStore.getState().document.skins.length },
        `已删除皮肤「${name}」`
      )
    }
  )

  defineAction(
    {
      name: 'setActiveSkin',
      title: '切换皮肤',
      description: '切换当前皮肤（空串或 default 表示默认皮肤）。只改编辑器状态，不进撤销记录',
      args: { name: { type: 'string', description: '皮肤名；空串 / default = 默认皮肤' } },
      returns: '{ skin }'
    },
    async (args) => {
      const raw = optText(args, 'name') ?? ''
      const skin = raw === 'default' ? '' : raw
      if (skin && !useProjectStore.getState().document.skins.some((item) => item.name === skin)) {
        throw new Error(`皮肤不存在：${skin}（用 listSkins 查现有皮肤名）`)
      }
      useProjectStore.getState().updateSilent((draft) => {
        draft.editorMeta.activeSkin = skin
      })
      useSelectionStore.getState().select({ skin })
      return {
        changed: false,
        data: { skin },
        message: `已切换到皮肤「${skin || 'default'}」`
      }
    }
  )

  // ---------------- 播放头 / 事件帧 ----------------

  defineAction(
    {
      name: 'setTime',
      title: '设置播放头',
      description: '把时间轴播放头移到指定时间（秒），不改变播放状态',
      args: { time: { type: 'number', description: '时间点（秒）', required: true } },
      returns: '{ time }'
    },
    async (args) => {
      const time = needNum(args, 'time')
      if (time < 0) throw new Error(`time 必须不小于 0（秒），收到 ${time}`)
      useTimelineStore.getState().setTime(time)
      return { changed: false, data: { time }, message: `播放头已移到 ${time} 秒` }
    }
  )

  defineAction(
    {
      name: 'setPlaying',
      title: '播放 / 暂停',
      description: '开始或暂停播放当前动画。开始播放时若还没选动画，会自动选第一个（没有动画则报错）',
      args: {
        playing: { type: 'boolean', description: 'true = 播放，false = 暂停', default: true },
        loop: { type: 'boolean', description: '是否循环；不传则保持当前设置' }
      },
      returns: '{ playing, animation }'
    },
    async (args) => {
      const playing = optBool(args, 'playing') ?? true
      const loop = optBool(args, 'loop')
      const timeline = useTimelineStore.getState()
      const store = useProjectStore.getState()
      if (playing && !timeline.currentAnimation) {
        const first = store.document.animations[0]?.name
        if (!first) throw new Error('没有可播放的动画：先用 addAnimation 建一条')
        timeline.setAnimation(first)
      }
      if (loop !== undefined) {
        if (useTimelineStore.getState().loop !== loop) useTimelineStore.getState().toggleLoop()
      }
      useTimelineStore.getState().setPlaying(playing)
      return {
        changed: false,
        data: { playing, animation: useTimelineStore.getState().currentAnimation },
        message: playing ? '开始播放' : '已暂停'
      }
    }
  )

  defineWrite(
    {
      name: 'keyEvent',
      title: '添加事件帧',
      description:
        '在指定时间点插入一个事件帧（时间轴最上面那条事件轨）。不传 time 用当前播放头，不传 name 自动取 event / event2…',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        time: { type: 'number', description: '时间点（秒）；不传用当前播放头' },
        name: { type: 'string', description: '事件名；不传自动取 event / event2…' },
        stringParam: { type: 'string', description: '字符串参数' },
        intParam: { type: 'number', description: '整数参数' },
        floatParam: { type: 'number', description: '浮点参数' }
      },
      returns: '{ animation, time, name }'
    },
    (draft, args) => {
      const animation = requireAnimation(draft, optText(args, 'animation'))
      const at = Math.round((optNum(args, 'time') ?? useTimelineStore.getState().time) * 1e4) / 1e4
      const name = optText(args, 'name') ?? nextEventName(animation.events)
      const stringParam = rawText(args, 'stringParam') ?? ''
      const intParam = optNum(args, 'intParam') ?? 0
      const floatParam = optNum(args, 'floatParam') ?? 0
      animation.events.push({ time: at, name, stringParam, intParam, floatParam })
      animation.events.sort((a, b) => a.time - b.time)
      syncDuration(animation)
      return changed(
        { animation: animation.name, time: at, name },
        `已在 ${at.toFixed(2)}s 添加事件帧「${name}」`
      )
    }
  )

  defineWrite(
    {
      name: 'setEvent',
      title: '编辑事件帧',
      description: '修改某个时间点上事件帧的名字 / 参数（只改给出的字段）',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        time: { type: 'number', description: '事件帧所在时间点（秒）', required: true },
        name: { type: 'string', description: '新事件名' },
        stringParam: { type: 'string', description: '字符串参数（空串 = 清空）' },
        intParam: { type: 'number', description: '整数参数' },
        floatParam: { type: 'number', description: '浮点参数' }
      },
      returns: '{ time, name, stringParam, intParam, floatParam }'
    },
    (draft, args) => {
      const animation = requireAnimation(draft, optText(args, 'animation'))
      const time = needNum(args, 'time')
      const event = findEvent(animation, Math.round(time * 1e4) / 1e4)
      if (!event) {
        return unchanged(`动画「${animation.name}」在 ${time}s 没有事件帧（用 getAnimationKeys 查现有事件）`)
      }
      const name = optText(args, 'name')
      const stringParam = rawText(args, 'stringParam')
      const intParam = optNum(args, 'intParam')
      const floatParam = optNum(args, 'floatParam')
      if (name !== undefined) event.name = name
      if (stringParam !== undefined) event.stringParam = stringParam
      if (intParam !== undefined) event.intParam = intParam
      if (floatParam !== undefined) event.floatParam = floatParam
      return changed({ time: event.time, name: event.name, stringParam: event.stringParam, intParam: event.intParam, floatParam: event.floatParam }, '已更新事件帧')
    }
  )

  defineWrite(
    {
      name: 'removeEvent',
      title: '删除事件帧',
      description: '删掉某个时间点上的事件帧（同名同时间只删一个）',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        time: { type: 'number', description: '事件帧所在时间点（秒）', required: true },
        name: { type: 'string', description: '事件名（同一时间有多个事件时用它区分）' }
      },
      returns: '{ removed, animation, time }'
    },
    (draft, args) => {
      const animation = requireAnimation(draft, optText(args, 'animation'))
      const time = needNum(args, 'time')
      const at = Math.round(time * 1e4) / 1e4
      const index = animation.events.findIndex(
        (event) => Math.abs(event.time - at) < 1e-4 && (optText(args, 'name') === undefined || event.name === optText(args, 'name'))
      )
      if (index < 0) return unchanged(`动画「${animation.name}」在 ${at}s 没有匹配的事件帧`)
      const [removed] = animation.events.splice(index, 1)
      return changed({ removed: removed.name, animation: animation.name, time: at }, `已删除事件帧「${removed.name}」`)
    }
  )

  // ---------------- 导出 ----------------

  defineAction(
    {
      name: 'exportProject',
      title: '导出工程',
      description:
        '把工程导出到磁盘（**不弹对话框**）。runtime = 自定义运行时数据，unity = .hao2d + 图集 + 材质，spine = Spine 4.3 的 json + atlas + 图集页。目录不传则用工程文件所在目录',
      args: {
        mode: {
          type: 'string',
          description: '导出目标',
          values: ['runtime', 'unity', 'spine'],
          default: 'runtime'
        },
        dir: { type: 'string', description: '输出目录（绝对路径）；不传 = 工程文件所在目录' },
        scale: { type: 'number', description: '图集缩放，默认用工程里记的值或 1' },
        maxSize: { type: 'number', description: '单页最大边长，默认 2048' },
        skeletons: { type: 'array', description: '要导出的骨架下标数组；不传 = 当前骨架' },
        atlasScope: {
          type: 'string',
          description: '图集范围：all = 所有骨架用到的图；selected = 只含本次导出的骨架',
          values: ['all', 'selected'],
          default: 'all'
        }
      },
      returns: '{ mode, dir, files, warnings }'
    },
    async (args) => {
      const rawMode = optText(args, 'mode') ?? 'runtime'
      if (rawMode !== 'runtime' && rawMode !== 'unity' && rawMode !== 'spine') {
        throw new Error(`mode 只能是 runtime / unity / spine，收到 ${rawMode}`)
      }
      const mode = rawMode
      const store = useProjectStore.getState()
      const dir = optText(args, 'dir') ?? dirName(store.projectPath ?? '')
      if (!dir) throw new Error('没有导出目录：给 exportProject 传 dir，或先把工程存到磁盘（saveProject）')

      const rawScope = optText(args, 'atlasScope') ?? 'all'
      if (rawScope !== 'all' && rawScope !== 'selected') {
        throw new Error(`atlasScope 只能是 all / selected，收到 ${rawScope}`)
      }
      const scale = optNum(args, 'scale') ?? store.document.editorMeta.exportScale ?? 1
      const maxSize = optNum(args, 'maxSize') ?? 2048
      const selected = optNumList(args, 'skeletons')

      const plan = prepareRuntimeExport({
        scale,
        maxSize,
        skeletons: mode === 'spine' ? (selected ?? [store.activeSkeleton]) : selected,
        atlasScope: rawScope
      })
      if (plan.skeletons.length === 0) throw new Error('没有可导出的骨架')

      const atlasTxt = useSettingsStore.getState().spineAtlasTxt
      const result =
        mode === 'spine'
          ? await writeSpineExport(dir, plan, { atlasTxt })
          : mode === 'unity'
            ? await writeHao2dExport(dir, plan)
            : await writeRuntimeExport(dir, plan)
      if (!result.ok) throw new Error(result.message)
      return {
        changed: false,
        data: { mode, dir, files: result.files, warnings: result.warnings },
        message: result.message
      }
    }
  )

  defineAction(
    {
      name: 'setExportScale',
      title: '设置导出缩放',
      description: '写入导出图集缩放（纯偏好，保存工程时落地）',
      args: { scale: { type: 'number', description: '缩放（0.25 ~ 1，>0）', required: true } },
      returns: '{ scale }'
    },
    async (args) => {
      const scale = needNum(args, 'scale')
      if (scale <= 0) throw new Error(`scale 必须大于 0，收到 ${scale}`)
      useProjectStore.getState().setExportScale(scale)
      return { changed: false, data: { scale }, message: `导出缩放已设为 ${scale}` }
    }
  )

  // ---------------- 撤销 / 重做 ----------------

  defineAction(
    {
      name: 'undo',
      title: '撤销',
      description: '撤销上一步文档编辑（等价于 Cmd/Ctrl+Z）。绘制网格边界中途会先撤销上一个边界点',
      kind: 'read',
      args: {},
      returns: '{ canUndo, canRedo, label }'
    },
    async () => {
      const store = useProjectStore.getState()
      if (!store.canUndo) return unchanged('没有可撤销的操作')
      const label = store.undoLabel
      store.undo()
      const after = useProjectStore.getState()
      return {
        changed: true,
        data: { canUndo: after.canUndo, canRedo: after.canRedo, label },
        message: label ? `已撤销「${label}」` : '已撤销'
      }
    }
  )

  defineAction(
    {
      name: 'redo',
      title: '重做',
      description: '重做上一步被撤销的编辑（等价于 Cmd/Ctrl+Shift+Z）',
      kind: 'read',
      args: {},
      returns: '{ canUndo, canRedo, label }'
    },
    async () => {
      const store = useProjectStore.getState()
      if (!store.canRedo) return unchanged('没有可重做的操作')
      const label = store.redoLabel
      store.redo()
      const after = useProjectStore.getState()
      return {
        changed: true,
        data: { canUndo: after.canUndo, canRedo: after.canRedo, label },
        message: label ? `已重做「${label}」` : '已重做'
      }
    }
  )
}
