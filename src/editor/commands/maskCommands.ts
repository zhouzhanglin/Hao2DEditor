import type { AuthoringAttachment, AuthoringSlot, EditorDocument } from '@core/model/authoring'
import type { Vec2 } from '@core/math/matrix'
import { useProjectStore } from '../store/projectStore'
import {
  convertAttachmentToClipping,
  createClippingAttachment,
  deleteClippingPoint,
  insertClippingPoint,
  setClippingPoint,
  setClippingVertices
} from './authoringCommands'
import { changed, defineRead, defineWrite, unchanged } from './registry'
import type { Args } from './registry'
import { need, needNum, optBool, optNum, optText, optVec, rawText, requireSomeField } from './args'
import { t } from '@i18n'

/**
 * 遮罩（Spine ClippingAttachment）命令。
 *
 * 关键约定：
 * - `points` 是**插槽骨骼局部坐标**，不是世界坐标；与 `getAttachmentVertices` 读出的遮罩点一致。
 * - 遮罩只裁剪绘制顺序中它之后、`endSlot` 之前的附件；`endSlot` 为空 = 裁到末尾。
 * - 改点数（插 / 删 / 整体替换成不同数量）会清掉该遮罩的旧 FFD 轨道，避免 offsets 错位。
 */

interface FoundMask {
  skin: string
  slot: AuthoringSlot
  attachment: AuthoringAttachment
}

function doc(): EditorDocument {
  return useProjectStore.getState().document
}

function requireSlot(document: EditorDocument, name: string): AuthoringSlot {
  const slot = document.slots.find((item) => item.name === name)
  if (!slot) throw new Error(t('找不到插槽「{0}」（用 listSlots 查现有插槽名）', name))
  return slot
}

function readPoints(args: Args): Vec2[] {
  const raw = args.points
  if (!Array.isArray(raw)) {
    throw new Error(t('缺少参数 points（数组 [{x,y}, ...]，至少 3 个点，坐标是插槽骨骼局部坐标）'))
  }
  if (raw.length < 3) throw new Error(t('points 至少需要 3 个点，收到 {0} 个', raw.length))
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(t('points[{0}] 必须是 {x,y}', index))
    }
    const { x, y } = item as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(t('points[{0}] 的 x / y 必须是有限数字', index))
    }
    return { x, y }
  })
}

function findMask(
  document: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName?: string
): FoundMask {
  const slot = requireSlot(document, slotName)
  const skins = skinName ? document.skins.filter((item) => item.name === skinName) : document.skins
  if (skinName && skins.length === 0) {
    throw new Error(t('找不到皮肤「{0}」（用 listSkins 查）', skinName))
  }

  let wrongType = ''
  for (const skin of skins) {
    const found = skin.slots
      .find((skinSlot) => skinSlot.slot === slotName)
      ?.attachments.find((item) => item.name === attachmentName)
    if (!found) continue
    if (found.type === 'clipping') return { skin: skin.name, slot, attachment: found }
    wrongType = found.type
  }

  if (wrongType) {
    throw new Error(
      `附件「${slotName} / ${attachmentName}」类型是 ${wrongType}，不是遮罩；先用 convertToMask 转换`
    )
  }
  throw new Error(
    t('找不到遮罩附件「{0} / {1}」（用 listMasks 查）', [slotName, attachmentName])
  )
}

function findAnyAttachment(
  document: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName?: string
): { skin: string; attachment: AuthoringAttachment } {
  const skins = skinName ? document.skins.filter((item) => item.name === skinName) : document.skins
  for (const skin of skins) {
    const found = skin.slots
      .find((skinSlot) => skinSlot.slot === slotName)
      ?.attachments.find((item) => item.name === attachmentName)
    if (found) return { skin: skin.name, attachment: found }
  }
  throw new Error(
    t('找不到附件「{0} / {1}」（用 listDisplays 查）', [slotName, attachmentName])
  )
}

/** 结束插槽必须存在、不能是遮罩自己，并且排在自己之后 */
function validateEndSlot(document: EditorDocument, maskSlot: AuthoringSlot, endSlot: string): void {
  if (!endSlot) return
  const target = document.slots.find((item) => item.name === endSlot)
  if (!target) throw new Error(t('结束插槽「{0}」不存在（用 listSlots 查）', endSlot))
  if (target.name === maskSlot.name) {
    throw new Error(t('结束插槽不能是遮罩自己；要裁到末尾就把 endSlot 留空'))
  }
  if (target.zOrder <= maskSlot.zOrder) {
    throw new Error(
      `结束插槽「${endSlot}」必须排在遮罩「${maskSlot.name}」之后（zOrder 更大）；要裁到末尾就把 endSlot 留空`
    )
  }
}

function maskInfo(found: FoundMask): Record<string, unknown> {
  const attachment = found.attachment
  return {
    skin: found.skin,
    slot: found.slot.name,
    bone: found.slot.bone,
    attachment: attachment.name,
    type: attachment.type,
    pointCount: attachment.vertices.length,
    points: attachment.vertices.map((point, index) => ({
      index,
      x: point.x,
      y: point.y,
      weights: point.weights.map((weight) => ({ bone: weight.bone, weight: weight.weight }))
    })),
    endSlot: attachment.clipEndSlot || '',
    inverse: attachment.clipInverse,
    convex: attachment.clipConvex,
    displayed: found.slot.attachment === attachment.name,
    zOrder: found.slot.zOrder
  }
}

function maskSummary(found: FoundMask): Record<string, unknown> {
  return {
    skin: found.skin,
    slot: found.slot.name,
    bone: found.slot.bone,
    attachment: found.attachment.name,
    pointCount: found.attachment.vertices.length,
    endSlot: found.attachment.clipEndSlot || '',
    inverse: found.attachment.clipInverse,
    convex: found.attachment.clipConvex,
    displayed: found.slot.attachment === found.attachment.name
  }
}

/** 把命令参数里的 endSlot / inverse / convex 应用到遮罩；返回实际改了的字段 */
function applyMaskOptions(
  document: EditorDocument,
  found: FoundMask,
  args: Args
): string[] {
  const fields: string[] = []
  const attachment = found.attachment
  const endSlot = rawText(args, 'endSlot')
  if (endSlot !== undefined) {
    validateEndSlot(document, found.slot, endSlot)
    attachment.clipEndSlot = endSlot
    fields.push('endSlot')
  }

  const inverse = optBool(args, 'inverse')
  if (inverse !== undefined) {
    attachment.clipInverse = inverse
    fields.push('inverse')
  }
  const convex = optBool(args, 'convex')
  if (convex !== undefined) {
    attachment.clipConvex = convex
    fields.push('convex')
  }
  if (attachment.clipInverse) attachment.clipConvex = true
  return fields
}

export function registerMaskCommands(): void {
  defineWrite(
    {
      name: 'createMask',
      title: '创建遮罩',
      description:
        '在插槽上创建 Clipping 遮罩附件。points 是插槽骨骼局部坐标（不是世界坐标），至少 3 个点；遮罩只裁绘制顺序中它之后、endSlot 之前的附件。默认会把该插槽显示切到遮罩',
      args: {
        slot: { type: 'string', description: '插槽名（遮罩从这条插槽开始生效）', required: true },
        name: { type: 'string', description: '遮罩附件名；不传则用 mask，重名自动加序号' },
        points: {
          type: 'array',
          description: '多边形控制点 [{x,y},...]（插槽骨骼局部坐标，至少 3 个）',
          required: true
        },
        endSlot: { type: 'string', description: '结束插槽名；留空 = 裁到绘制顺序末尾' },
        inverse: { type: 'boolean', description: '反向遮罩（只保留多边形外部）；会自动把 convex 设为 true' },
        convex: { type: 'boolean', description: '多边形是凸的（加速标记，默认 false）' },
        skin: { type: 'string', description: '目标皮肤；不传 = 当前皮肤' },
        display: { type: 'boolean', description: '是否把插槽显示切到遮罩，默认 true' }
      },
      returns: '{ skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed }',
      example: {
        slot: 'mask',
        points: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 }
        ],
        endSlot: 'body'
      }
    },
    (draft, args) => {
      const slot = requireSlot(draft, need(args, 'slot'))
      const points = readPoints(args)
      const endSlot = rawText(args, 'endSlot') ?? ''
      validateEndSlot(draft, slot, endSlot)
      const inverse = optBool(args, 'inverse') ?? false
      const convex = inverse ? true : (optBool(args, 'convex') ?? false)
      const skin = optText(args, 'skin')
      if (skin && !draft.skins.some((item) => item.name === skin)) {
        throw new Error(t('找不到皮肤「{0}」（用 listSkins 查）', skin))
      }
      const created = createClippingAttachment(draft, slot.name, {
        name: optText(args, 'name'),
        points,
        endSlot,
        inverse,
        convex,
        skin,
        display: optBool(args, 'display') ?? true
      })
      if (!created) {
        throw new Error(
          t('创建遮罩失败：插槽「{0}」或皮肤不存在，或点数不足 3（用 listSlots / listSkins 查）', slot.name)
        )
      }
      // 必须回到「实际创建到的那张皮肤」去读；跨皮肤按名字找可能命中另一个皮肤里的同名遮罩
      const skinName = skin ?? draft.editorMeta.activeSkin
      const targetSkin =
        (skinName ? draft.skins.find((item) => item.name === skinName) : undefined) ?? draft.skins[0]
      const found = findMask(draft, slot.name, created.name, targetSkin?.name)
      return changed(
        maskInfo(found),
        t('已创建遮罩 {0} / {1}（{2} 个点）', [slot.name, created.name, points.length])
      )
    }
  )

  defineWrite(
    {
      name: 'convertToMask',
      title: '转遮罩',
      description:
        '把 Region / 非加权 Mesh 转成遮罩（保留附件名）。Region 取内容矩形，Mesh 取顶点凸包；加权网格不支持。转换后可用 setMaskOptions 设结束插槽 / 反向',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' },
        endSlot: { type: 'string', description: '结束插槽名；不传保持默认（裁到末尾）' },
        inverse: { type: 'boolean', description: '是否反向遮罩' },
        convex: { type: 'boolean', description: '是否凸多边形' }
      },
      returns: '{ skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed }'
    },
    (draft, args) => {
      const slotName = need(args, 'slot')
      const attachmentName = need(args, 'attachment')
      const skin = optText(args, 'skin')
      const source = findAnyAttachment(draft, slotName, attachmentName, skin)
      if (source.attachment.type === 'clipping') {
        throw new Error(
          t('附件「{0} / {1}」已经是遮罩（用 getMask 查它）', [slotName, attachmentName])
        )
      }
      if (!convertAttachmentToClipping(draft, slotName, attachmentName, source.skin)) {
        throw new Error(
          `转不了：${slotName} / ${attachmentName} 是加权网格，或类型不支持（请先解除权重，或直接 createMask 画多边形）`
        )
      }
      const found = findMask(draft, slotName, attachmentName, source.skin)
      const fields = applyMaskOptions(draft, found, args)
      const display = optBool(args, 'display')
      if (display === true) found.slot.attachment = found.attachment.name
      return changed(
        maskInfo(found),
        `已把 ${slotName} / ${attachmentName} 转为遮罩${fields.length > 0 ? `（${fields.join(' / ')} 已更新）` : ''}`
      )
    }
  )

  defineWrite(
    {
      name: 'setMaskPoints',
      title: '设置遮罩控制点',
      description:
        '整体替换遮罩多边形。points 是插槽骨骼局部坐标，至少 3 个；点数变化会清掉该遮罩旧的 FFD 轨道。只改少量点优先用 setMaskPoint / insertMaskPoint / deleteMaskPoint',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        points: { type: 'array', description: '[{x,y},...]（插槽骨骼局部坐标，至少 3 个）', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ skin, slot, attachment, pointCount, points, endSlot, inverse, convex }'
    },
    (draft, args) => {
      const found = findMask(draft, need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      const points = readPoints(args)
      const attachment = found.attachment
      const same =
        attachment.vertices.length === points.length &&
        points.every((point, index) => {
          const current = attachment.vertices[index]
          return Math.abs(current.x - point.x) < 1e-9 && Math.abs(current.y - point.y) < 1e-9
        })
      if (same) return unchanged(t('遮罩控制点没有变化'))
      if (!setClippingVertices(draft, found.slot.name, attachment.name, points, found.skin)) {
        throw new Error(t('设置遮罩控制点失败：附件或皮肤已变化'))
      }
      return changed(
        maskInfo(found),
        t('已更新遮罩 {0} / {1}（{2} 个点）', [
          found.slot.name,
          attachment.name,
          points.length
        ])
      )
    }
  )

  defineWrite(
    {
      name: 'setMaskPoint',
      title: '移动遮罩控制点',
      description: '修改遮罩的一个控制点。point 是插槽骨骼局部坐标；index 从 0 开始（getMask 返回的 index）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        index: { type: 'number', description: '控制点下标，从 0 开始', required: true },
        point: { type: 'object', description: '新位置 {x,y}（插槽骨骼局部坐标）', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ slot, attachment, index, point, pointCount }'
    },
    (draft, args) => {
      const found = findMask(draft, need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      const index = Math.round(needNum(args, 'index'))
      const point = optVec(args, 'point')
      if (!point) throw new Error(t('缺少参数 point（新位置 {x,y}，插槽骨骼局部坐标）'))
      if (index < 0 || index >= found.attachment.vertices.length) {
        throw new Error(
          t('index 越界：该遮罩有 {0} 个点，index 应在 0..{1}', [
            found.attachment.vertices.length,
            found.attachment.vertices.length - 1
          ])
        )
      }
      if (!setClippingPoint(draft, found.slot.name, found.attachment.name, index, point, found.skin)) {
        throw new Error(t('移动遮罩控制点失败：附件或皮肤已变化'))
      }
      return changed(
        { slot: found.slot.name, attachment: found.attachment.name, index, point, pointCount: found.attachment.vertices.length },
        `已移动遮罩 ${found.slot.name} / ${found.attachment.name} 的控制点 #${index}`
      )
    }
  )

  defineWrite(
    {
      name: 'insertMaskPoint',
      title: '插入遮罩控制点',
      description:
        '在指定控制点之后插入一个点（index = -1 表示插到最前）。会清掉该遮罩旧 FFD 轨道。point 是插槽骨骼局部坐标',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        index: { type: 'number', description: '插在这个下标之后；-1 = 插到最前', default: -1 },
        point: { type: 'object', description: '新点 {x,y}（插槽骨骼局部坐标）', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ slot, attachment, index, pointCount }'
    },
    (draft, args) => {
      const found = findMask(draft, need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      const index = Math.round(optNum(args, 'index') ?? -1)
      const point = optVec(args, 'point')
      if (!point) throw new Error(t('缺少参数 point（新点 {x,y}，插槽骨骼局部坐标）'))
      if (index < -1 || index >= found.attachment.vertices.length) {
        throw new Error(
          t('index 越界：该遮罩有 {0} 个点，index 应在 -1..{1}', [
            found.attachment.vertices.length,
            found.attachment.vertices.length - 1
          ])
        )
      }
      if (!insertClippingPoint(draft, found.slot.name, found.attachment.name, index, point, found.skin)) {
        throw new Error(t('插入遮罩控制点失败：附件或皮肤已变化'))
      }
      const newIndex = index + 1
      return changed(
        { slot: found.slot.name, attachment: found.attachment.name, index: newIndex, pointCount: found.attachment.vertices.length },
        `已在遮罩 ${found.slot.name} / ${found.attachment.name} 插入控制点（新下标 ${newIndex}）`
      )
    }
  )

  defineWrite(
    {
      name: 'deleteMaskPoint',
      title: '删除遮罩控制点',
      description: '删除遮罩的一个控制点（至少保留 3 个）。会清掉该遮罩旧 FFD 轨道',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        index: { type: 'number', description: '要删除的下标，从 0 开始', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ slot, attachment, pointCount }'
    },
    (draft, args) => {
      const found = findMask(draft, need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      const index = Math.round(needNum(args, 'index'))
      if (index < 0 || index >= found.attachment.vertices.length) {
        throw new Error(
          t('index 越界：该遮罩有 {0} 个点，index 应在 0..{1}', [
            found.attachment.vertices.length,
            found.attachment.vertices.length - 1
          ])
        )
      }
      if (!deleteClippingPoint(draft, found.slot.name, found.attachment.name, index, found.skin)) {
        throw new Error(t('遮罩至少保留 3 个控制点，当前删不了'))
      }
      return changed(
        { slot: found.slot.name, attachment: found.attachment.name, pointCount: found.attachment.vertices.length },
        `已删除遮罩 ${found.slot.name} / ${found.attachment.name} 的控制点 #${index}`
      )
    }
  )

  defineWrite(
    {
      name: 'setMaskOptions',
      title: '设置遮罩选项',
      description:
        '修改遮罩结束插槽 / 反向 / 凸形 / 是否显示。endSlot 留空 = 裁到绘制顺序末尾；至少有 endSlot / inverse / convex / display 之一',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        endSlot: { type: 'string', description: '结束插槽名；传空串 = 裁到末尾' },
        inverse: { type: 'boolean', description: '反向遮罩' },
        convex: { type: 'boolean', description: '凸多边形（inverse 时会自动为 true）' },
        display: { type: 'boolean', description: 'true = 把插槽显示切到遮罩；false = 当前显示是它时清空' },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed }'
    },
    (draft, args) => {
      const found = findMask(draft, need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      const fields = applyMaskOptions(draft, found, args)
      const display = optBool(args, 'display')
      if (display !== undefined) {
        if (display) found.slot.attachment = found.attachment.name
        else if (found.slot.attachment === found.attachment.name) found.slot.attachment = ''
        fields.push('display')
      }
      requireSomeField(fields)
      return changed(
        maskInfo(found),
        t('已更新遮罩选项（{0}）', fields.join(' / '))
      )
    }
  )

  defineRead(
    {
      name: 'getMask',
      title: '查遮罩',
      description:
        '读一个遮罩的全部控制点与选项。points 是插槽骨骼局部坐标；用这些 index 调 setMaskPoint / insertMaskPoint / deleteMaskPoint，或给 keyDeformFrame 算 offsets',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '遮罩附件名', required: true },
        skin: { type: 'string', description: '皮肤名；不传 = 跨皮肤查找' }
      },
      returns: '{ skin, slot, bone, attachment, pointCount, points, endSlot, inverse, convex, displayed, zOrder }'
    },
    (args) => {
      const found = findMask(doc(), need(args, 'slot'), need(args, 'attachment'), optText(args, 'skin'))
      return maskInfo(found)
    }
  )

  defineRead(
    {
      name: 'listMasks',
      title: '列遮罩',
      description: '列出工程里所有遮罩附件（按皮肤 / 插槽）。要控制点明细用 getMask',
      args: {},
      returns: '{ masks: [{ skin, slot, bone, attachment, pointCount, endSlot, inverse, convex, displayed }] }'
    },
    () => {
      const document = doc()
      const masks: Record<string, unknown>[] = []
      for (const skin of document.skins) {
        for (const skinSlot of skin.slots) {
          for (const attachment of skinSlot.attachments) {
            if (attachment.type !== 'clipping') continue
            const slot = document.slots.find((item) => item.name === skinSlot.slot)
            if (!slot) continue
            masks.push(maskSummary({ skin: skin.name, slot, attachment }))
          }
        }
      }
      return { masks }
    }
  )
}
