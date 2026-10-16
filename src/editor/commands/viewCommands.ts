import { getActiveScene } from '../activeScene'
import { focusNode } from '../focusNode'
import { baseName, dirName, getPlatform } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { stageFilePath } from '../services/projectAssets'
import { PPU } from './authoringCommands'
import { changed, defineAction, unchanged } from './registry'
import { need, needNum, optNum, optText } from './args'
import type { FocusTarget } from '../focusNode'
import type { StageImage } from '@core/model/authoring'

/**
 * 补齐「纯相机操作」与「舞台参考图」这两组只影响视口、不进文档数据的命令。
 *
 * - 相机命令（聚焦 / 平移 / 缩放 / 居中）**只移动视口**，不改任何工程数据，回报 `changed: false`；
 * - 舞台参考图存在 `editorMeta.stage`（图片落到工程目录 `stage/` 下随工程走），
 *   只用于编辑器背景参照，不参与导出 —— 与「舞台」弹窗（StageDialog）同一套实现。
 */

/** 打开参考图时的合法后缀（与 StageDialog 的对话框过滤器一致） */
const STAGE_EXT = ['png', 'jpg', 'jpeg', 'webp']

/** 与 StageDialog 相同的取名策略：同目录同名就加 `_2` / `_3` …… 避免覆盖历史参考图 */
async function uniqueStageFileName(dir: string, sourcePath: string): Promise<string> {
  const platform = getPlatform()
  const origin = baseName(sourcePath)
  let fileName = origin
  let counter = 2
  // eslint-disable-next-line no-await-in-loop
  while (await platform.exists(stageFilePath(dir, fileName))) {
    const dot = origin.lastIndexOf('.')
    const base = dot >= 0 ? origin.slice(0, dot) : origin
    const ext = dot >= 0 ? origin.slice(dot) : ''
    fileName = `${base}_${counter}${ext}`
    counter += 1
  }
  return fileName
}

function clampAlpha(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function registerViewCommands(): void {
  // ---------------- 相机 ----------------

  defineAction(
    {
      name: 'focusNode',
      title: '聚焦节点',
      description:
        '把视口对准某个骨骼 / 插槽 / 附件 / 约束（等同层级树里双击该行）。只移动相机，不改数据',
      args: {
        kind: {
          type: 'string',
          description: '节点类型',
          values: ['bone', 'slot', 'display', 'constraint'],
          required: true
        },
        name: { type: 'string', description: '节点名（display 时为附件名）', required: true },
        slot: { type: 'string', description: 'kind = display 时该附件所在的插槽名' }
      },
      returns: '{ kind, name }'
    },
    async (args) => {
      const rawKind = need(args, 'kind')
      const name = need(args, 'name')
      if (rawKind !== 'bone' && rawKind !== 'slot' && rawKind !== 'display' && rawKind !== 'constraint') {
        throw new Error(`kind 只能是 bone / slot / display / constraint，收到 ${rawKind}`)
      }
      const kind = rawKind as 'bone' | 'slot' | 'display' | 'constraint'
      let target: FocusTarget
      if (kind === 'display') {
        const slot = optText(args, 'slot')
        if (!slot) throw new Error('kind = display 时需要同时给 slot（附件所在的插槽名）')
        target = { kind: 'display', slot, name }
      } else {
        target = { kind, name }
      }
      if (!getActiveScene()) throw new Error('场景未就绪：视口还没挂载好，稍后再试')
      if (!focusNode(useProjectStore.getState().document, target)) {
        throw new Error(`聚焦失败：找不到 ${kind}「${name}」（名字可能不对，或该节点没有可框取的尺寸）`)
      }
      return { changed: false, data: { kind, name }, message: `视口已聚焦到 ${kind}「${name}」` }
    }
  )

  defineAction(
    {
      name: 'panViewport',
      title: '平移视口',
      description:
        '按屏幕像素平移视口（相机拖动）。dx 正值 = 画面内容右移，dy 正值 = 画面内容下移。只动相机，不改数据',
      args: {
        dx: { type: 'number', description: '水平位移（屏幕像素）', required: true },
        dy: { type: 'number', description: '垂直位移（屏幕像素）', required: true }
      },
      returns: '{ offset }'
    },
    async (args) => {
      const scene = getActiveScene()
      if (!scene) throw new Error('场景未就绪：视口还没挂载好，稍后再试')
      scene.viewport.pan(needNum(args, 'dx'), needNum(args, 'dy'))
      scene.viewport.render()
      const offset = scene.viewport.offset
      return {
        changed: false,
        data: { offset },
        message: `视口已平移（dx=${needNum(args, 'dx')}px, dy=${needNum(args, 'dy')}px）`
      }
    }
  )

  defineAction(
    {
      name: 'setViewportZoom',
      title: '设置视口缩放',
      description: '设置视口缩放倍率（以屏幕中心为锚点，画面中心的位置不变）。只动相机，不改数据',
      args: { zoom: { type: 'number', description: '缩放倍率（>0）', required: true } },
      returns: '{ zoom }'
    },
    async (args) => {
      const zoom = needNum(args, 'zoom')
      if (!(zoom > 0)) throw new Error(`zoom 必须大于 0，收到 ${zoom}`)
      const scene = getActiveScene()
      if (!scene) throw new Error('场景未就绪：视口还没挂载好，稍后再试')
      const vp = scene.viewport
      vp.zoomAt(zoom / vp.zoom, vp.width * 0.5, vp.height * 0.5)
      vp.render()
      return { changed: false, data: { zoom: vp.zoom }, message: `视口缩放已设为 ${vp.zoom}` }
    }
  )

  defineAction(
    {
      name: 'centerViewport',
      title: '视口居中到点',
      description: '把某个世界坐标点移到视口正中（保持当前缩放）。只动相机，不改数据',
      args: {
        x: { type: 'number', description: '世界坐标 x', required: true },
        y: { type: 'number', description: '世界坐标 y（上为正）', required: true }
      },
      returns: '{ x, y, zoom }'
    },
    async (args) => {
      const x = needNum(args, 'x')
      const y = needNum(args, 'y')
      const scene = getActiveScene()
      if (!scene) throw new Error('场景未就绪：视口还没挂载好，稍后再试')
      const vp = scene.viewport
      const screen = vp.worldToScreen(x, y)
      vp.pan(vp.width * 0.5 - screen.x, vp.height * 0.5 - screen.y)
      vp.render()
      return {
        changed: false,
        data: { x, y, zoom: vp.zoom },
        message: `视口已居中到世界坐标 (${x}, ${y})`
      }
    }
  )

  // ---------------- 舞台参考图 ----------------

  defineAction(
    {
      name: 'setStage',
      title: '设置舞台参考图',
      description:
        '按路径把一张图铺到视口当背景参照（存到工程 `stage/` 目录，随工程走）。会替换已有参考图；工程需已保存（先 saveProject / createProject）。仅编辑器显示，不参与导出',
      args: {
        imagePath: { type: 'string', description: '参考图文件的绝对路径', required: true },
        x: { type: 'number', description: '位置 x（世界单位，y 向上）；不传 0' },
        y: { type: 'number', description: '位置 y（世界单位）；不传 0' },
        width: { type: 'number', description: '显示宽度（世界单位）；不传按图片像素 / PPU 换算' },
        height: { type: 'number', description: '显示高度（世界单位）；不传按图片像素 / PPU 换算' },
        opacity: { type: 'number', description: '透明度 0–1；不传 0.5' }
      },
      returns: '{ file, x, y, width, height, opacity }'
    },
    async (args) => {
      const imagePath = need(args, 'imagePath')
      const ext = imagePath.slice(imagePath.lastIndexOf('.') + 1).toLowerCase()
      if (!STAGE_EXT.includes(ext)) {
        throw new Error(`参考图后缀不在支持范围（${STAGE_EXT.join(' / ')}），收到 .${ext}`)
      }
      const store = useProjectStore.getState()
      const path = store.projectPath
      if (!path) {
        throw new Error('请先保存工程：参考图要落到工程目录的 stage/ 下（先 createProject 或 saveProject）')
      }
      const platform = getPlatform()
      const bytes = await platform.readBinary(imagePath)
      if (!bytes.length) throw new Error(`读不到图片文件：${imagePath}`)
      const infos = await platform.imageInfo([imagePath])
      const size = infos[0] ?? { width: 0, height: 0 }

      const dir = dirName(path)
      const fileName = await uniqueStageFileName(dir, imagePath)
      await platform.writeBinary(stageFilePath(dir, fileName), bytes)

      const previous = store.document.editorMeta.stage
      const init: StageImage = {
        file: fileName,
        x: optNum(args, 'x') ?? 0,
        y: optNum(args, 'y') ?? 0,
        width: optNum(args, 'width') ?? (size.width ? size.width / PPU : 8),
        height: optNum(args, 'height') ?? (size.height ? size.height / PPU : 8),
        opacity: clampAlpha(optNum(args, 'opacity') ?? 0.5)
      }
      useProjectStore.getState().update(previous ? '更换舞台参考图' : '设置舞台参考图', (draft) => {
        draft.editorMeta.stage = init
      })
      // 换图时删掉旧文件（换名产生的），避免磁盘残留
      if (previous && previous.file !== fileName) {
        await platform.deleteFile(stageFilePath(dir, previous.file))
      }
      const next = [
        '底图已铺好（默认 1:1、图片中心=世界原点）：接下来逐张挂部件——addSlot + addDisplay 后用 getDisplayWorldBounds 读世界包围盒与底图量出的目标框对比、setDisplayTransform 修到重合，对齐一个再挂下一个；captureViewport 截图做视觉复核；全部对齐后 removeStage 删底图'
      ]
      return changed({ ...init, next }, previous ? `已更换舞台参考图「${fileName}」` : `已设置舞台参考图「${fileName}」`)
    }
  )

  defineAction(
    {
      name: 'updateStage',
      title: '调整舞台参考图',
      description: '改已有舞台参考图的位置 / 大小 / 透明度（世界单位；只改给出的字段）',
      args: {
        x: { type: 'number', description: '位置 x（世界单位）' },
        y: { type: 'number', description: '位置 y（世界单位）' },
        width: { type: 'number', description: '显示宽度（世界单位，>0）' },
        height: { type: 'number', description: '显示高度（世界单位，>0）' },
        opacity: { type: 'number', description: '透明度 0–1' }
      },
      returns: '{ x, y, width, height, opacity }'
    },
    async (args) => {
      if (!useProjectStore.getState().document.editorMeta.stage) {
        throw new Error('还没有舞台参考图：先调 setStage，或让用户用「舞台」弹窗选一张')
      }
      const x = optNum(args, 'x')
      const y = optNum(args, 'y')
      const width = optNum(args, 'width')
      const height = optNum(args, 'height')
      const opacity = optNum(args, 'opacity')
      if (width !== undefined && !(width > 0)) throw new Error(`width 必须大于 0，收到 ${width}`)
      if (height !== undefined && !(height > 0)) throw new Error(`height 必须大于 0，收到 ${height}`)
      useProjectStore.getState().update('调整舞台参考图', (draft) => {
        const stage = draft.editorMeta.stage
        if (!stage) return
        if (x !== undefined) stage.x = x
        if (y !== undefined) stage.y = y
        if (width !== undefined) stage.width = width
        if (height !== undefined) stage.height = height
        if (opacity !== undefined) stage.opacity = clampAlpha(opacity)
      })
      const stage = useProjectStore.getState().document.editorMeta.stage
      if (!stage) return unchanged('舞台参考图在调整中消失了')
      return changed(stage, '已调整舞台参考图')
    }
  )

  defineAction(
    {
      name: 'removeStage',
      title: '删除舞台参考图',
      description: '删掉当前舞台参考图（同时删除工程 `stage/` 下的图片文件）',
      args: {},
      returns: '{ removed }'
    },
    async () => {
      const store = useProjectStore.getState()
      const stage = store.document.editorMeta.stage
      if (!stage) return unchanged('本来就没有舞台参考图')
      if (store.projectPath) {
        await getPlatform().deleteFile(stageFilePath(dirName(store.projectPath), stage.file))
      }
      useProjectStore.getState().update('删除舞台参考图', (draft) => {
        draft.editorMeta.stage = null
      })
      return changed({ removed: stage.file }, `已删除舞台参考图「${stage.file}」`)
    }
  )
}
