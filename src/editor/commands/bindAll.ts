import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import {
  applyRename,
  autoGenerateRegionMesh,
  checkRename,
  countImageReferences,
  deleteImage,
  findAttachment,
  replaceImage
} from './authoringCommands'
import type { RenameTarget } from './authoringCommands'
import { copyKeyframes, copyNodes, duplicateSelection, pasteKeyframes, pasteNodes } from './clipboardCommands'
import { applySlotOrder, moveDisplay, moveSlot, moveBone } from './hierarchyCommands'
import type { DropZone } from './hierarchyCommands'
import { changed, defineAction, defineRead, defineWrite } from './registry'
import { need, needNum, needOneOf, optBool, optNum, optText, optTextList } from './args'

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
        throw new Error(`参数 zone 只能是 inside / above / below，收到 ${rawZone}`)
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
          throw new Error(`参数 side 只能是 before / after，收到 ${side}`)
        }
        anchor = { name: anchorName, side }
      } else if (rawSide) {
        throw new Error('给了 side 就要一并给 anchorSlot（排序锚点的插槽名）')
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
          throw new Error(`参数 side 只能是 before / after，收到 ${side}`)
        }
        anchor = { name: anchorName, side }
      }
      const skin = optText(args, 'skin') ?? draft.editorMeta.activeSkin
      const result = moveDisplay(draft, slot, display, toSlot, anchor, skin, { worldMatrixOf: worldMatrixOfBone })
      if (!result.ok) throw new Error(result.message)
      return changed({ slot, display, toSlot }, result.message)
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
        throw new Error('缺少参数 order（插槽名数组，第 0 个最先画；用 listSlots 可以拿到当前顺序）')
      }
      const existing = draft.slots.map((slot) => slot.name)
      const unique = new Set(order)
      if (unique.size !== order.length) throw new Error('order 里有重复的插槽名')
      const unknown = order.filter((name) => !existing.includes(name))
      if (unknown.length > 0) {
        throw new Error(`order 里有不存在的插槽：${unknown.join('、')}（用 listSlots 查现有插槽名）`)
      }
      const missing = existing.filter((name) => !unique.has(name))
      if (missing.length > 0) {
        throw new Error(`order 少了 ${missing.length} 个插槽：${missing.join('、')}（必须给出全部插槽名）`)
      }
      // applySlotOrder 约定 names[0] = 最上层；命令参数反过来是「先画的在前」，所以倒序传入
      applySlotOrder(draft, [...order].reverse())
      return changed({ order }, `已重排 ${order.length} 个插槽的绘制顺序`)
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
        throw new Error('附件改名要带上 slot（附件所在插槽名；用 listDisplays 查）')
      }
      const target: RenameTarget = slot ? { kind, slot } : { kind }
      const reason = checkRename(draft, target, name, nextName)
      if (reason) throw new Error(reason)
      if (!applyRename(draft, target, name, nextName)) {
        throw new Error(`改不了：找不到${kind}「${name}」（用 listBones / listSlots / listDisplays / listConstraints 核对）`)
      }
      return changed({ kind, from: name, to: nextName }, `已把「${name}」改名为「${nextName}」`)
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
        throw new Error(`图片不存在：${image}（用 listImages 查图片池）`)
      }
      const references = countImageReferences(draft, image)
      if (references > 0 && !force) {
        throw new Error(
          `图片「${image}」还被 ${references} 个附件引用着。确认要删就带 force: true（引用会退化成纯色）`
        )
      }
      deleteImage(draft, image)
      return changed({ image, references }, `已删除图片「${image}」${references > 0 ? `（清空了 ${references} 处引用）` : ''}`)
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
        throw new Error(`图片不存在：${image}（用 listImages 查图片池）`)
      }
      return changed({ image, path, width, height }, `已替换图片「${image}」的来源与尺寸`)
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
        throw new Error('没有可复制的内容：先用 setSelection 选中骨骼（kind=bone）或插槽（kind=slot）')
      }
      return { changed: false, data: { count }, message: `已复制 ${count} 个节点` }
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
        throw new Error('粘贴失败：剪贴板为空，或没有合适的落点。先 copyNodes，再用 setSelection 选中目标骨骼')
      }
      return changed({ count }, `已粘贴 ${count} 个节点`)
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
        throw new Error('没有可复制的选择：先用 setSelection 选中骨骼或插槽（关键帧的复制请用 copyKeyframes）')
      }
      return changed({ count }, `已复制并粘贴 ${count} 个节点`)
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
        throw new Error('没有选中的关键帧：这一步需要在时间轴上手动选中（或直接改用 keyBoneFrame / moveKeyframe 逐个编辑）')
      }
      return { changed: false, data: { count }, message: `已复制 ${count} 个关键帧` }
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
        throw new Error('粘贴失败：剪贴板里没有关键帧（先 copyKeyframes），或目标动画不存在')
      }
      return changed({ count, time: time ?? null }, `已粘贴 ${count} 个关键帧`)
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
      if (!scene) throw new Error('视口还没就绪，取不到图片像素。等编辑器窗口画完一帧再试')
      const attachment = findAttachment(useProjectStore.getState().document, slot, attachmentName)
      if (!attachment) throw new Error(`找不到附件：${slot} / ${attachmentName}（用 listDisplays 查）`)
      const isFromImage =
        attachment.type === 'region' || (attachment.type === 'mesh' && Boolean(attachment.regionSnapshot))
      if (!isFromImage) {
        throw new Error('只有图片（Region）或由图片转来的网格能生成轮廓网格；纯网格请用 convertToMesh 的规则栅格')
      }
      const entry = attachment.image ? scene.imageAlpha.entryOf(attachment.image) : null
      if (!entry) throw new Error(`图片「${attachment.image || '(空)'}」还没解码完成，稍后再试`)
      let result: { vertices: number; triangles: number; coverage: number } | null = null
      const committed = useProjectStore.getState().runCommand('生成轮廓网格', (draft) => {
        result = autoGenerateRegionMesh(draft, slot, attachmentName, entry, divisions)
        return result !== null
      })
      const stats = result as { vertices: number; triangles: number; coverage: number } | null
      if (!committed || !stats) {
        throw new Error('生成失败：图片没有可用的不透明像素区域（可能整张图都是透明的）')
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
      if (!rolledBack) throw new Error('没有正在进行的事务（rollbackTransaction 要跟在 beginTransaction 之后）')
      return changed({ rolledBack }, '已回滚到批量操作前的状态')
    }
  )
}
