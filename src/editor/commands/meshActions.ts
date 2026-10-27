import { useModeStore } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { getActiveScene } from '@editor/activeScene'
import type { ActionResult } from '@editor/timeline/actions'
import { autoGenerateRegionMesh, convertRegionToMesh, findAttachment } from './authoringCommands'
import { t } from '@i18n'

/**
 * 网格生成 / 重设的一次性动作 —— 属性面板「网格 / FFD」那一栏的按钮调用。
 *
 * 「密度」= 工具里的 `gridDivisions`（1..24）：规则栅格网格与轮廓贴合网格都用它；
 * 手动编辑（Alt+插点 / 拖顶点）改乱了，也可以用同一个密度一键重设回去。
 */

/** 绑定网格的生成 / 重设只在 Pose 态有意义（Animate 态拖顶点写的是 FFD 帧） */
function requirePoseForMesh(): ActionResult | null {
  if (useModeStore.getState().mode === 'pose') return null
  return { ok: false, message: t('生成 / 重设网格改的是绑定网格：请切到 Pose 状态') }
}

/** 当前选中的附件（需要 slot + attachment 都选着） */
function selectedAttachment(): { slot: string; attachment: string } | null {
  const selection = useSelectionStore.getState()
  if (selection.kind !== 'attachment' || !selection.slot || !selection.attachment) return null
  return { slot: selection.slot, attachment: selection.attachment }
}

/** Region（图片）→ 规则栅格网格（密度 N×N） */
export function buildGridMesh(divisions: number): ActionResult {
  const gate = requirePoseForMesh()
  if (gate) return gate
  const target = selectedAttachment()
  if (!target) return { ok: false, message: t('先在层级树里选中要生成网格的图片附件') }
  const attachment = findAttachment(useProjectStore.getState().document, target.slot, target.attachment)
  if (!attachment || attachment.type !== 'region') {
    return { ok: false, message: t('只有图片（Region）能转为规则栅格网格；已经是网格的请用「自动生成网格」按密度重设') }
  }

  let result: { vertices: number; triangles: number } | null = null
  useProjectStore.getState().update(t('Region 转网格'), (draft) => {
    result = convertRegionToMesh(draft, target.slot, target.attachment, divisions)
  })
  const stats = result as { vertices: number; triangles: number } | null
  return stats
    ? {
        ok: true,
        message: t('已生成规则网格（{0}×{1}）：{2} 顶点 / {3} 三角面', [
          divisions,
          divisions,
          stats.vertices,
          stats.triangles
        ])
      }
    : { ok: false, message: t('生成失败：附件类型不是 Region') }
}

/** 沿图片不透明像素的轮廓生成贴合网格；Region 与「由图片转来的网格」都可重复执行 */
export function buildOutlineMesh(divisions: number): ActionResult {
  const gate = requirePoseForMesh()
  if (gate) return gate
  const target = selectedAttachment()
  if (!target) return { ok: false, message: t('先在层级树里选中要生成网格的图片附件') }
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: t('视口尚未就绪，稍后再试') }
  const attachment = findAttachment(useProjectStore.getState().document, target.slot, target.attachment)
  if (!attachment) return { ok: false, message: t('找不到附件「{0}」', target.attachment) }
  const isFromImage = attachment.type === 'region' || (attachment.type === 'mesh' && Boolean(attachment.regionSnapshot))
  if (!isFromImage) {
    return { ok: false, message: t('只有图片（Region）或由图片转来的网格能自动生成轮廓网格') }
  }
  const entry = scene.imageAlpha.entryOf(attachment.image)
  if (!entry) return { ok: false, message: t('图片「{0}」还没解码完成，稍后再试', attachment.image) }

  let result: { vertices: number; triangles: number; coverage: number } | null = null
  useProjectStore.getState().update(t('自动生成网格'), (draft) => {
    result = autoGenerateRegionMesh(draft, target.slot, target.attachment, entry, divisions)
  })
  const stats = result as { vertices: number; triangles: number; coverage: number } | null
  return stats
    ? {
        ok: true,
        message: t('已自动生成轮廓网格：{0} 顶点 / {1} 三角面（贴合轮廓，孔洞已忽略）', [
          stats.vertices,
          stats.triangles
        ])
      }
    : { ok: false, message: t('自动生成失败：图片没有可用的不透明像素区域') }
}
