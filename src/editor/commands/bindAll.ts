import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useModeStore, pickAnimationForAnimate } from '../store/modeStore'
import { useTimelineStore } from '../store/timelineStore'
import {
  addArmatureDisplay,
  applyRename,
  autoGenerateRegionMesh,
  checkRename,
  countImageReferences,
  deleteImage,
  findAttachment,
  replaceImage
} from './authoringCommands'
import { checkNestDrop } from '@core/nesting/nest'
import type { RenameTarget } from './authoringCommands'
import { copyKeyframes, copyNodes, duplicateSelection, pasteKeyframes, pasteNodes } from './clipboardCommands'
import { applySlotOrder, moveDisplay, moveSlot, moveBone } from './hierarchyCommands'
import type { DropZone } from './hierarchyCommands'
import { changed, defineAction, defineRead, defineWrite, unchanged } from './registry'
import { need, needNum, needOneOf, optBool, optNum, optText, optTextList } from './args'
import { getPlatform, joinPath, dirName, baseName, stripExtension } from '../platform'
import { ASSET_DIR } from '../services/projectAssets'
import { splitAtlasImage } from '../services/atlasSplit'
import { useToolStore } from '../store/toolStore'
import { lastKeyTime } from '@core/model/authoring'
import { t } from '@i18n'

/**
 * 把编辑器已有的成熟操作再包一层命令：层级移动、重命名、绘制顺序、图片池、选择。
 *
 * 这些能力原来只存在于 UI 交互里（拖拽 / 右键菜单），这里做的是**同一批纯函数的第二种入口**——
 * 参数显式传递（不读 UI 选择态），AI 与人都能得到一致结果。
 * 需要「保持全局位姿」的移动依赖视口里的世界矩阵：窗口没就绪时降级为普通换父级并如实说明。
 */

// ---------------- 层级移动 ----------------

/** 视口里的骨骼世界矩阵；视口没就绪时返回 null（移动命令会降级：只换父级，不保持全局位姿） */
function worldMatrixOfBone(name: string): Float32Array | null {
  return getActiveScene()?.worldMatrixOf(name) ?? null
}

// ---------------- 图片 / 图集（供 AI 从外部导入资源） ----------------

/** dataURL / 裸 base64 → 字节；若带 dataURL mime 则顺手推断扩展名 */
function decodeImageData(data: string): { bytes: Uint8Array; ext?: string } {
  let raw = data.trim()
  let ext: string | undefined
  const match = raw.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/i)
  if (match) {
    ext = match[1].toLowerCase()
    raw = raw.slice(match[0].length)
  }
  let binary: string
  try {
    binary = atob(raw)
  } catch {
    throw new Error(t('data 不是合法 base64'))
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { bytes, ext }
}

function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : 'png'
}

/** 文件名去文件系统非法字符（前后空白 / 点也清掉），空了兜底成 image */
function sanitizeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '') || 'image'
  )
}

/** 图片名去重（带扩展名），重名自动加序号 */
async function uniqueImageName(base: string, ext: string, images: readonly { name: string }[]): Promise<string> {
  const taken = new Set(images.map((image) => image.name))
  const candidate = `${base}.${ext}`
  if (!taken.has(candidate)) return candidate
  let index = 2
  while (taken.has(`${base}_${index}.${ext}`)) index++
  return `${base}_${index}.${ext}`
}

export function registerBindAllCommands(): void {
  defineWrite(
    {
      name: 'moveBone',
      title: '移动骨骼',
      description:
        '把骨骼挂到另一根骨骼下（inside）或排到它旁边（above / below）。视口就绪时保持全局位姿不变。target 传空串 = 挂回层级根骨骼',
      args: {
        bone: { type: 'string', description: '要移动的骨骼名', required: true },
        target: { type: 'string', description: '目标骨骼名；空串 = 层级根骨骼' },
        zone: {
          type: 'string',
          description: '落点：inside = 成为目标的子级；above / below = 与目标同级并排在它前 / 后',
          values: ['inside', 'above', 'below'],
          default: 'inside'
        }
      },
      returns: '{ bone, target, zone, keptWorldPose }'
    },
    (draft, args) => {
      const bone = need(args, 'bone')
      const target = optText(args, 'target') ?? ''
      const rawZone = optText(args, 'zone') ?? 'inside'
      if (rawZone !== 'inside' && rawZone !== 'above' && rawZone !== 'below') {
        throw new Error(
          t('参数 zone 只能是 inside / above / below，收到 {0}', rawZone)
        )
      }
      const zone: DropZone = rawZone
      const keptWorldPose = getActiveScene() !== null
      const result = moveBone(draft, bone, target, zone, keptWorldPose ? { worldMatrixOf: worldMatrixOfBone } : undefined)
      if (!result.ok) throw new Error(result.message)
      return changed({ bone, target, zone, keptWorldPose }, result.message)
    }
  )

  defineWrite(
    {
      name: 'moveSlot',
      title: '移动插槽',
      description:
        '把插槽挂到另一根骨骼下，并用 anchorSlot / side 指定在目标骨骼插槽列表里的落点（不传 anchorSlot 则排到末尾）。会把附件换算到新骨骼空间，画面位置不变',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        bone: { type: 'string', description: '新的宿主骨骼名', required: true },
        anchorSlot: { type: 'string', description: '排序锚点：插到这个插槽的前 / 后' },
        side: {
          type: 'string',
          description: '相对锚点的位置（只在给了 anchorSlot 时有意义）',
          values: ['before', 'after'],
          default: 'after'
        }
      },
      returns: '{ slot, bone }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const bone = need(args, 'bone')
      const anchorName = optText(args, 'anchorSlot')
      const rawSide = optText(args, 'side')
      let anchor: { name: string; side: 'before' | 'after' } | null = null
      if (anchorName) {
        const side = rawSide ?? 'after'
        if (side !== 'before' && side !== 'after') {
          throw new Error(t('参数 side 只能是 before / after，收到 {0}', side))
        }
        anchor = { name: anchorName, side }
      } else if (rawSide) {
        throw new Error(t('给了 side 就要一并给 anchorSlot（排序锚点的插槽名）'))
      }
      const result = moveSlot(draft, slot, bone, anchor, { worldMatrixOf: worldMatrixOfBone })
      if (!result.ok) throw new Error(result.message)
      return changed({ slot, bone, anchorSlot: anchorName ?? '' }, result.message)
    }
  )

  defineWrite(
    {
      name: 'moveDisplay',
      title: '移动附件',
      description:
        '把附件搬到另一个插槽（会自动换算保持世界位姿、并同步 display 帧），或在同一插槽内排序。anchorDisplay / side 指定落点',
      args: {
        slot: { type: 'string', description: '附件当前所在插槽', required: true },
        display: { type: 'string', description: '附件名', required: true },
        toSlot: { type: 'string', description: '目标插槽名', required: true },
        anchorDisplay: { type: 'string', description: '排序锚点：放到这个附件的前 / 后（目标插槽内）' },
        side: {
          type: 'string',
          description: '相对锚点的位置',
          values: ['before', 'after'],
          default: 'after'
        },
        skin: { type: 'string', description: '皮肤名；不传用当前皮肤' }
      },
      returns: '{ slot, display, toSlot }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const display = need(args, 'display')
      const toSlot = need(args, 'toSlot')
      const anchorName = optText(args, 'anchorDisplay')
      const rawSide = optText(args, 'side')
      let anchor: { name: string; side: 'before' | 'after' } | null = null
      if (anchorName) {
        const side = rawSide ?? 'after'
        if (side !== 'before' && side !== 'after') {
          throw new Error(t('参数 side 只能是 before / after，收到 {0}', side))
        }
        anchor = { name: anchorName, side }
      }
      const skin = optText(args, 'skin') ?? draft.editorMeta.activeSkin
      const result = moveDisplay(draft, slot, display, toSlot, anchor, skin, { worldMatrixOf: worldMatrixOfBone })
      if (!result.ok) throw new Error(result.message)
      return changed({ slot, display, toSlot }, result.message)
    }
  )

  // ---------------- 骨架嵌套 ----------------

  defineWrite(
    {
      name: 'nestArmature',
      title: '嵌套骨架',
      description:
        '把工程里的另一个骨架作为 display 挂到指定插槽上（同工程按名字引用，不复制数据），并切换为当前显示项。会拒绝自引用 / 循环引用 / 超深',
      args: {
        slot: { type: 'string', description: '目标插槽名', required: true },
        armature: { type: 'string', description: '被引用的骨架名（必须是工程里的另一个骨架）', required: true },
        name: { type: 'string', description: '新 display 的名字；缺省用骨架名（重名自动加序号）' },
        skin: { type: 'string', description: '皮肤名；不传用当前皮肤' }
      },
      returns: '{ slot, attachment }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const armature = need(args, 'armature')
      const reason = checkNestDrop(useProjectStore.getState().skeletons, draft.armatureName, armature)
      if (reason) throw new Error(reason)
      const result = addArmatureDisplay(draft, {
        slot,
        armature,
        name: optText(args, 'name'),
        skin: optText(args, 'skin') ?? useSelectionStore.getState().skin
      })
      if (!result) throw new Error(t('插槽「{0}」不存在或骨架名无效', slot))
      return changed(result, t('已把骨架「{0}」嵌到插槽「{1}」', [armature, slot]))
    }
  )

  // ---------------- 绘制顺序 ----------------

  defineWrite(
    {
      name: 'setDrawOrder',
      title: '设置绘制顺序',
      description:
        '一次性重排全部插槽的绘制顺序。order 必须**包含所有插槽名**（只给一部分无法确定唯一顺序），第 0 个最先画（最底层）',
      args: {
        order: { type: 'array', description: '插槽名数组（绘制顺序：先画的在前）', required: true }
      },
      returns: '{ order }'
    },
    (draft, args) => {
      const order = optTextList(args, 'order')
      if (!order || order.length === 0) {
        throw new Error(t('缺少参数 order（插槽名数组，第 0 个最先画；用 listSlots 可以拿到当前顺序）'))
      }
      const existing = draft.slots.map((slot) => slot.name)
      const unique = new Set(order)
      if (unique.size !== order.length) throw new Error(t('order 里有重复的插槽名'))
      const unknown = order.filter((name) => !existing.includes(name))
      if (unknown.length > 0) {
        throw new Error(
          t('order 里有不存在的插槽：{0}（用 listSlots 查现有插槽名）', unknown.join('、'))
        )
      }
      const missing = existing.filter((name) => !unique.has(name))
      if (missing.length > 0) {
        throw new Error(
          t('order 少了 {0} 个插槽：{1}（必须给出全部插槽名）', [
            missing.length,
            missing.join('、')
          ])
        )
      }
      // applySlotOrder 约定 names[0] = 最上层；命令参数反过来是「先画的在前」，所以倒序传入
      applySlotOrder(draft, [...order].reverse())
      return changed({ order }, t('已重排 {0} 个插槽的绘制顺序', order.length))
    }
  )

  // ---------------- 重命名 ----------------

  defineWrite(
    {
      name: 'renameNode',
      title: '重命名',
      description:
        '给骨骼 / 插槽 / 附件 / 约束改名，文档里所有引用（父级、宿主、动画轨道、display 帧…）自动级联更新',
      args: {
        kind: { type: 'string', description: '改什么', values: ['bone', 'slot', 'attachment', 'constraint'], required: true },
        name: { type: 'string', description: '现在的名字（附件 = 附件名）', required: true },
        nextName: { type: 'string', description: '新名字', required: true },
        slot: { type: 'string', description: '附件所在插槽名（kind=attachment 时必给）' }
      },
      returns: '{ kind, from, to }'
    },
    (draft, args) => {
      const kind = needOneOf(args, 'kind', ['bone', 'slot', 'attachment', 'constraint'] as const)
      const name = need(args, 'name')
      const nextName = need(args, 'nextName')
      const slot = optText(args, 'slot')
      if (kind === 'attachment' && !slot) {
        throw new Error(t('附件改名要带上 slot（附件所在插槽名；用 listDisplays 查）'))
      }
      const target: RenameTarget = slot ? { kind, slot } : { kind }
      const reason = checkRename(draft, target, name, nextName)
      if (reason) throw new Error(reason)
      if (!applyRename(draft, target, name, nextName)) {
        throw new Error(
          t('改不了：找不到{0}「{1}」（用 listBones / listSlots / listDisplays / listConstraints 核对）', [
            kind,
            name
          ])
        )
      }
      return changed(
        { kind, from: name, to: nextName },
        t('已把「{0}」改名为「{1}」', [name, nextName])
      )
    }
  )

  // ---------------- 图片池 ----------------

  defineWrite(
    {
      name: 'deleteImage',
      title: '删除图片',
      description:
        '从图片池删掉一张图。仍被附件引用时默认拒绝执行，确认要删就带 force: true（引用它的附件会退化成纯色，附件本身保留）',
      args: {
        image: { type: 'string', description: '图片名（用 listImages 查）', required: true },
        force: { type: 'boolean', description: '有附件引用时也照删', default: false }
      },
      returns: '{ image, references }'
    },
    (draft, args) => {
      const image = need(args, 'image')
      const force = optBool(args, 'force') ?? false
      if (!draft.images.some((item) => item.name === image)) {
        throw new Error(t('图片不存在：{0}（用 listImages 查图片池）', image))
      }
      const references = countImageReferences(draft, image)
      if (references > 0 && !force) {
        throw new Error(
          `图片「${image}」还被 ${references} 个附件引用着。确认要删就带 force: true（引用会退化成纯色）`
        )
      }
      deleteImage(draft, image)
      return changed(
        { image, references },
        t('已删除图片「{0}」{1}', [
          image,
          references > 0 ? t('（清空了 {0} 处引用）', references) : ''
        ])
      )
    }
  )

  defineWrite(
    {
      name: 'replaceImage',
      title: '替换图片文件',
      description:
        '把图片池里某张图的来源换成另一个文件并更新尺寸（名字不变，所有附件引用自动跟随）。width / height 是**像素尺寸**，要自己量好再传',
      args: {
        image: { type: 'string', description: '图片名', required: true },
        path: { type: 'string', description: '新的图片文件路径', required: true },
        width: { type: 'number', description: '新图宽度（像素）', required: true },
        height: { type: 'number', description: '新图高度（像素）', required: true }
      },
      returns: '{ image, path, width, height }'
    },
    (draft, args) => {
      const image = need(args, 'image')
      const path = need(args, 'path')
      const width = needNum(args, 'width')
      const height = needNum(args, 'height')
      if (!replaceImage(draft, image, { path, width, height })) {
        throw new Error(t('图片不存在：{0}（用 listImages 查图片池）', image))
      }
      return changed(
        { image, path, width, height },
        t('已替换图片「{0}」的来源与尺寸', image)
      )
    }
  )

  // ---------------- 选择（不碰文档） ----------------

  defineRead(
    {
      name: 'setSelection',
      title: '设置选择',
      description:
        '改变编辑器里当前选中的对象（骨骼 / 插槽 / 附件 / 约束 / 取消选择）。copyNodes、pasteNodes 等依赖「当前选择」的操作要先用它定位',
      args: {
        kind: { type: 'string', description: '选什么', values: ['none', 'bone', 'slot', 'attachment', 'constraint'], required: true },
        name: { type: 'string', description: '骨骼 / 插槽 / 约束名' },
        bones: { type: 'array', description: '骨骼名数组（多选；给了就用它，否则用 name）' },
        slot: { type: 'string', description: '附件所在插槽（kind=attachment 时必给）' },
        attachment: { type: 'string', description: '附件名（kind=attachment 时必给）' }
      },
      returns: '{ kind, bone, bones, slot, attachment, constraint }'
    },
    (args) => {
      const kind = needOneOf(args, 'kind', ['none', 'bone', 'slot', 'attachment', 'constraint'] as const)
      const selection = useSelectionStore.getState()
      if (kind === 'none') selection.clear()
      else if (kind === 'bone') selection.selectBones(optTextList(args, 'bones') ?? [need(args, 'name')])
      else if (kind === 'slot') selection.selectSlot(need(args, 'name'))
      else if (kind === 'attachment') selection.selectAttachment(need(args, 'slot'), need(args, 'attachment'))
      else selection.selectConstraint(need(args, 'name'))
      const now = useSelectionStore.getState()
      return {
        kind: now.kind,
        bone: now.bone,
        bones: now.bones,
        slot: now.slot,
        attachment: now.attachment,
        constraint: now.constraint
      }
    }
  )

  // ---------------- 编辑状态（Pose / Animate）切换 ----------------

  defineAction(
    {
      kind: 'read',
      name: 'setMode',
      title: '切换编辑状态',
      description:
        '在 Pose（绑定）态与 Animate（动画编辑）态之间切换。切到 Animate 时会自动选中一个动画（优先上次离开时选的，否则第一个）；切回 Pose 会记录当前动画并清空时间轴选择。时间轴只在 Animate 态出现，做关键帧编辑前要先切到 Animate',
      args: {
        mode: { type: 'string', description: '目标状态', values: ['pose', 'animate'], required: true }
      },
      returns: '{ mode, animation }'
    },
    (args) => {
      const next = needOneOf(args, 'mode', ['pose', 'animate'] as const)
      const modeStore = useModeStore.getState()
      if (next === modeStore.mode) {
        return unchanged(t('已在 {0} 状态', next))
      }
      const timeline = useTimelineStore.getState()
      if (next === 'animate') {
        if (!timeline.currentAnimation) {
          const picked = pickAnimationForAnimate(
            useProjectStore.getState().document.animations.map((a) => a.name),
            modeStore.lastAnimation
          )
          if (picked) timeline.setAnimation(picked)
        }
        modeStore.setMode('animate')
      } else {
        modeStore.setLastAnimation(timeline.currentAnimation)
        timeline.setAnimation(null)
        modeStore.setMode('pose')
      }
      const nowMode = useModeStore.getState().mode
      return changed(
        { mode: nowMode, animation: useTimelineStore.getState().currentAnimation },
        `已切换到 ${nowMode} 状态`
      )
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'setAnimation',
      title: '切换当前动画',
      description:
        '在 Animate（动画编辑）态下切换当前正在编辑的动画。name 必须是工程中已存在的动画名。要先 setMode 切到 animate 才能用；切换会清空时间轴选择与播放头归零',
      args: {
        name: { type: 'string', description: '目标动画名（工程里已存在的）', required: true }
      },
      returns: '{ animation }'
    },
    (args) => {
      if (useModeStore.getState().mode !== 'animate') {
        throw new Error(t('当前不在 Animate 状态：请先调用 setMode 切到 animate 再做动画编辑'))
      }
      const name = need(args, 'name')
      const document = useProjectStore.getState().document
      if (!document.animations.some((a) => a.name === name)) {
        throw new Error(t('没有这个动画：{0}（用 listAnimations 查全部动画名）', name))
      }
      useTimelineStore.getState().setAnimation(name)
      return changed(
        { animation: useTimelineStore.getState().currentAnimation },
        t('已切换到动画「{0}」', name)
      )
    }
  )

  // ---------------- 视口叠加层 / 相机 ----------------

  defineAction(
    {
      kind: 'read',
      name: 'setOverlay',
      title: '切换叠加层',
      description:
        '显示 / 隐藏视口叠加层：bones = 骨骼骨架，constraints = 约束手柄（IK / 变换 / 路径 / 物理）。与视口右上角的「骨骼 / 约束」开关等效。visible 不传 = 切换',
      args: {
        key: { type: 'string', description: '开关哪一层', values: ['bones', 'constraints'], required: true },
        visible: { type: 'boolean', description: 'true = 显示，false = 隐藏；不传 = 切换' }
      },
      returns: '{ overlay: { bones, constraints } }'
    },
    (args) => {
      const key = needOneOf(args, 'key', ['bones', 'constraints'] as const)
      const tools = useToolStore.getState()
      const next = optBool(args, 'visible') ?? !tools.overlay[key]
      tools.setOverlay({ ...tools.overlay, [key]: next })
      const overlay = useToolStore.getState().overlay
      return {
        changed: false,
        data: { overlay: { ...overlay } },
        message: overlay[key]
          ? t('「{0}」叠加层已显示', key === 'bones' ? t('骨骼') : t('约束'))
          : t('「{0}」叠加层已隐藏', key === 'bones' ? t('骨骼') : t('约束'))
      }
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'fitViewport',
      title: '适配视野',
      description: '把视口缩放 / 平移到刚好框住整个角色（与右上角「适配视野」按钮、F 键等效）。captureViewport 前常用它先把角色摆正',
      args: {},
      returns: '{}'
    },
    () => {
      const scene = getActiveScene()
      if (!scene) throw new Error(t('视口还没就绪：等编辑器窗口画完一帧再试'))
      scene.fit()
      return { changed: false, message: t('已适配视野') }
    }
  )

  // ---------------- 时间轴面板（洋葱皮 / 智能过滤 / 缩放 / 帧数） ----------------

  defineAction(
    {
      kind: 'read',
      name: 'setOnionSkin',
      title: '洋葱皮开关',
      description: '显示 / 隐藏时间轴的洋葱皮（前后帧骨骼姿态）。enabled 不传 = 切换',
      args: {
        enabled: { type: 'boolean', description: 'true = 开，false = 关；不传 = 切换' }
      },
      returns: '{ onionSkin }'
    },
    (args) => {
      const timeline = useTimelineStore.getState()
      const next = optBool(args, 'enabled') ?? !timeline.onionSkin
      if (next !== timeline.onionSkin) timeline.toggleOnionSkin()
      const now = useTimelineStore.getState().onionSkin
      return {
        changed: false,
        data: { onionSkin: now },
        message: now ? t('洋葱皮已开启') : t('洋葱皮已关闭')
      }
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'setSmartFilter',
      title: '智能过滤开关',
      description:
        '只显示当前选中对象（骨骼 / 插槽 / 约束）的时间轴轨道。先用 setSelection 选中对象再开过滤才有效。enabled 不传 = 切换',
      args: {
        enabled: { type: 'boolean', description: 'true = 开，false = 关；不传 = 切换' }
      },
      returns: '{ smartFilter }'
    },
    (args) => {
      const timeline = useTimelineStore.getState()
      const next = optBool(args, 'enabled') ?? !timeline.smartFilter
      timeline.setSmartFilter(next)
      return {
        changed: false,
        data: { smartFilter: next },
        message: next ? t('智能过滤已开启') : t('智能过滤已关闭')
      }
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'setTimelineZoom',
      title: '时间轴缩放',
      description:
        '设置时间轴时间缩放：1 = 完整适配动画长度；越大时间轴越长、关键帧越松散（逐帧精修），最小 0.5、最大 2。超范围会自动夹住',
      args: {
        zoom: { type: 'number', description: '缩放倍数（0.5 ~ 2）', required: true }
      },
      returns: '{ zoom }'
    },
    (args) => {
      const zoom = needNum(args, 'zoom')
      if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(t('zoom 必须是正数'))
      useTimelineStore.getState().setZoom(zoom)
      const now = useTimelineStore.getState().zoom
      return { changed: false, data: { zoom: now }, message: t('时间轴缩放已设为 {0}×', now) }
    }
  )

  defineWrite(
    {
      name: 'setAnimationFrames',
      title: '设置动画帧数',
      description:
        '按帧数设置动画时长（帧数 ÷ 工程帧率 = 秒）。这是「可编辑范围」——改大就能在后面继续加帧；播放与导出仍按最后一个关键帧算。不能短于最后一个关键帧，不够时会自动抬高并说明',
      args: {
        frames: { type: 'number', description: '时长（帧数），至少 1', required: true },
        animation: { type: 'string', description: '动画名；不传 = 当前选中的动画' }
      },
      returns: '{ name, frames, duration }'
    },
    (draft, args) => {
      const frames = Math.max(1, Math.round(needNum(args, 'frames')))
      const name = optText(args, 'animation') || draft.editorMeta.activeAnimation
      if (!name) {
        throw new Error(
          t('没有指定动画：传 animation 参数，或先 setMode 切到 animate（会自动选中一个动画）')
        )
      }
      const target = draft.animations.find((item) => item.name === name)
      if (!target) throw new Error(t('没有这个动画：{0}（用 listAnimations 查全部动画名）', name))
      const minFrames = Math.ceil(lastKeyTime(target) * draft.frameRate - 1e-6)
      const finalFrames = Math.max(frames, minFrames)
      target.duration = finalFrames / draft.frameRate
      return changed(
        { name, frames: finalFrames, duration: target.duration },
        finalFrames !== frames
          ? `时长不能短于最后一个关键帧（${minFrames} 帧），已按 ${minFrames} 帧设置`
          : `动画「${name}」的时长已设为 ${finalFrames} 帧`
      )
    }
  )

  // ---------------- 剪贴板 ----------------

  defineAction(
    {
      kind: 'read',
      name: 'copyNodes',
      title: '复制节点',
      description:
        '把当前选中的骨骼 / 插槽节点复制进剪贴板（不改文档）。先用 setSelection 选中；粘贴用 pasteNodes',
      args: {},
      returns: '{ count }'
    },
    () => {
      const count = copyNodes()
      if (count === 0) {
        throw new Error(
          t('没有可复制的内容：先用 setSelection 选中骨骼（kind=bone）或插槽（kind=slot）')
        )
      }
      return { changed: false, data: { count }, message: t('已复制 {0} 个节点', count) }
    }
  )

  defineAction(
    {
      name: 'pasteNodes',
      title: '粘贴节点',
      description:
        '把剪贴板里的节点粘贴到当前选择之下（粘贴骨骼时挂到选中骨骼下；粘贴插槽时挂到选中骨骼 / 插槽所在骨骼）',
      args: {},
      returns: '{ count }'
    },
    () => {
      const count = pasteNodes()
      if (count === 0) {
        throw new Error(
          t('粘贴失败：剪贴板为空，或没有合适的落点。先 copyNodes，再用 setSelection 选中目标骨骼')
        )
      }
      return changed({ count }, t('已粘贴 {0} 个节点', count))
    }
  )

  defineAction(
    {
      name: 'duplicateSelection',
      title: '就地复制选择',
      description:
        '复制当前选择并立即粘贴（骨骼 / 插槽新副本，改名加序号）。依赖当前选择，配合 setSelection 使用',
      args: {},
      returns: '{ count }'
    },
    () => {
      const count = duplicateSelection()
      if (count === 0) {
        throw new Error(
          t('没有可复制的选择：先用 setSelection 选中骨骼或插槽（关键帧的复制请用 copyKeyframes）')
        )
      }
      return changed({ count }, t('已复制并粘贴 {0} 个节点', count))
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'copyKeyframes',
      title: '复制关键帧',
      description:
        '把时间轴上当前选中的关键帧复制进剪贴板（不改文档）。粘贴用 pasteKeyframes；轨道上有哪些关键帧用 getAnimationKeys 查',
      args: {},
      returns: '{ count }'
    },
    () => {
      const count = copyKeyframes()
      if (count === 0) {
        throw new Error(
          t('没有选中的关键帧：这一步需要在时间轴上手动选中（或直接改用 keyBoneFrame / moveKeyframe 逐个编辑）')
        )
      }
      return { changed: false, data: { count }, message: t('已复制 {0} 个关键帧', count) }
    }
  )

  defineAction(
    {
      name: 'pasteKeyframes',
      title: '粘贴关键帧',
      description: '把剪贴板里的关键帧粘贴到指定时间（不传 time 就贴到当前播放头）。关键帧之间相对间距保持不变',
      args: {
        time: { type: 'number', description: '粘贴起点（秒）；不传用当前播放头时间' }
      },
      returns: '{ count, time }'
    },
    (args) => {
      const time = optNum(args, 'time')
      const count = pasteKeyframes(time)
      if (count === 0) {
        throw new Error(t('粘贴失败：剪贴板里没有关键帧（先 copyKeyframes），或目标动画不存在'))
      }
      return changed({ count, time: time ?? null }, t('已粘贴 {0} 个关键帧', count))
    }
  )

  // ---------------- 轮廓网格（需要视口像素） ----------------

  defineAction(
    {
      name: 'convertToOutlineMesh',
      title: '生成轮廓网格',
      description:
        '沿图片不透明像素的轮廓生成贴合网格（比 convertToMesh 的规则栅格更贴合）。可重复执行；需要图片已解码（窗口已画过一帧）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        divisions: { type: 'number', description: '细分数，越大越贴合（顶点也越多），默认 8', default: 8 }
      },
      returns: '{ slot, attachment, vertices, triangles, coverage }'
    },
    (args) => {
      const slot = need(args, 'slot')
      const attachmentName = need(args, 'attachment')
      const divisions = Math.max(1, Math.min(24, Math.round(optNum(args, 'divisions') ?? 8)))
      const scene = getActiveScene()
      if (!scene) throw new Error(t('视口还没就绪，取不到图片像素。等编辑器窗口画完一帧再试'))
      const attachment = findAttachment(useProjectStore.getState().document, slot, attachmentName)
      if (!attachment) {
        throw new Error(t('找不到附件：{0} / {1}（用 listDisplays 查）', [slot, attachmentName]))
      }
      const isFromImage =
        attachment.type === 'region' || (attachment.type === 'mesh' && Boolean(attachment.regionSnapshot))
      if (!isFromImage) {
        throw new Error(
          t('只有图片（Region）或由图片转来的网格能生成轮廓网格；纯网格请用 convertToMesh 的规则栅格')
        )
      }
      const entry = attachment.image ? scene.imageAlpha.entryOf(attachment.image) : null
      if (!entry) {
        throw new Error(t('图片「{0}」还没解码完成，稍后再试', attachment.image || '(空)'))
      }
      let result: { vertices: number; triangles: number; coverage: number } | null = null
      const committed = useProjectStore.getState().runCommand(t('生成轮廓网格'), (draft) => {
        result = autoGenerateRegionMesh(draft, slot, attachmentName, entry, divisions)
        return result !== null
      })
      const stats = result as { vertices: number; triangles: number; coverage: number } | null
      if (!committed || !stats) {
        throw new Error(t('生成失败：图片没有可用的不透明像素区域（可能整张图都是透明的）'))
      }
      // 网格数据变了，推回场景并重画
      const next = useProjectStore.getState().document
      scene.setDocument(next, next.editorMeta.activeSkin)
      scene.refresh()
      return changed(
        { slot, attachment: attachmentName, ...stats },
        `已生成轮廓网格：${stats.vertices} 顶点 / ${stats.triangles} 三角面`
      )
    }
  )

  // ---------------- 事务（POST /batch 内部用） ----------------

  defineAction(
    {
      kind: 'read',
      name: 'beginTransaction',
      title: '开始事务',
      description: '把接下来的一批编辑合并成一条撤销记录（由 POST /batch 的 transaction:true 自动调用，不建议单独使用）',
      args: { label: { type: 'string', description: '撤销记录上显示的名字', default: 'AI 批量操作' } },
      returns: '{ started, label }'
    },
    (args) => {
      const label = optText(args, 'label') ?? 'AI 批量操作'
      useProjectStore.getState().beginTransaction(label)
      return { changed: false, data: { started: true, label } }
    }
  )

  defineAction(
    {
      kind: 'read',
      name: 'endTransaction',
      title: '结束事务',
      description: '把事务期间的改动合并为一条撤销记录（由 POST /batch 自动调用）',
      args: {},
      returns: '{ ended }'
    },
    () => {
      useProjectStore.getState().endTransaction()
      return { changed: false, data: { ended: true } }
    }
  )

  defineAction(
    {
      name: 'rollbackTransaction',
      title: '回滚事务',
      description: '放弃事务：文档恢复到 beginTransaction 时的状态，不留撤销记录（由 POST /batch 在批量失败时自动调用）',
      args: {},
      returns: '{ rolledBack }'
    },
    () => {
      const rolledBack = useProjectStore.getState().rollbackTransaction()
      if (!rolledBack) {
        throw new Error(t('没有正在进行的事务（rollbackTransaction 要跟在 beginTransaction 之后）'))
      }
      return changed({ rolledBack }, t('已回滚到批量操作前的状态'))
    }
  )

  defineAction(
    {
      name: 'importImage',
      title: '导入图片到工程',
      description:
        '把一张图片写进工程目录的 images/ 并登记到图片池，供 addDisplay 做成附件。图片来源二选一：data（base64 或 dataURL）/ path（本地绝对路径）。工程需先保存或创建（确定 images/ 目录）。name 不传用原文件名自动命名，重名自动加序号',
      args: {
        data: { type: 'string', description: '图片字节：base64 或 dataURL（与 path 二选一）' },
        path: { type: 'string', description: '本地图片绝对路径（与 data 二选一）' },
        name: { type: 'string', description: '图片名（不含目录与扩展名）；不传用原文件名' },
        ext: { type: 'string', description: 'data 模式下的格式（png/jpg/jpeg/webp/gif），不传从 dataURL 推断或默认 png' }
      },
      returns: '{ name, width, height, path }',
      example: { path: '/Users/me/art/sword.png' }
    },
    async (args) => {
      const platform = getPlatform()
      const store = useProjectStore.getState()
      const projectPath = store.projectPath
      if (!projectPath) {
        throw new Error(
          t('请先保存或创建工程：导入的图片要落到工程目录的 images/ 下（可先调用 createProject 或 saveProject）')
        )
      }
      const data = optText(args, 'data')
      const sourcePath = optText(args, 'path')
      if (!data && !sourcePath) {
        throw new Error(t('必须给 data（base64 / dataURL）或 path（本地图片绝对路径）其中一个'))
      }
      let bytes: Uint8Array
      let ext: string
      if (data) {
        const decoded = decodeImageData(data)
        bytes = decoded.bytes
        ext = (decoded.ext ?? optText(args, 'ext') ?? 'png').toLowerCase()
        if (ext === 'jpeg') ext = 'jpg'
      } else {
        bytes = await platform.readBinary(sourcePath as string)
        ext = extOf(sourcePath as string)
      }
      if (!bytes || bytes.length === 0) {
        throw new Error(t('读不到图片字节（data 解码失败或 path 文件不存在）'))
      }

      const dir = joinPath(dirName(projectPath), ASSET_DIR)
      const given = optText(args, 'name') ?? (sourcePath ? stripExtension(baseName(sourcePath)) : 'image')
      const base = sanitizeName(given)
      const fileName = await uniqueImageName(base, ext, store.document.images)
      const target = joinPath(dir, fileName)
      await platform.writeBinary(target, bytes)
      const info = await platform.imageInfo([target])
      const width = info[0]?.width ?? 0
      const height = info[0]?.height ?? 0
      store.update(t('导入图片'), (draft) => {
        draft.images.push({ name: fileName, path: target, width, height, loose: true })
      })
      return changed(
        { name: fileName, width, height, path: target },
        t('已导入图片 {0}（{1}×{2}）', [fileName, width, height])
      )
    }
  )

  defineAction(
    {
      name: 'splitAtlas',
      title: '拆分图集为碎图',
      description:
        '把图集页（loose=false，即用 Spine / DragonBones 导入带来的整页图集）按记录的区域拆成独立碎图，写到 <图集名>_split/，并让所有引用它的附件改指碎图。图集图片名用 listImages 查',
      args: { name: { type: 'string', description: '图集图片名', required: true } },
      returns: '{ message }'
    },
    async (args) => {
      const name = need(args, 'name')
      const result = await splitAtlasImage(name)
      if (!result.ok) throw new Error(result.message)
      return changed({ message: result.message }, result.message)
    }
  )
}
