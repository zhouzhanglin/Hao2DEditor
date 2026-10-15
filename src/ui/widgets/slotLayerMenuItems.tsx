import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Trash2 } from 'lucide-react'
import { deleteSlotNamed, moveSlotLayer } from '@editor/slotOrderOps'
import type { LayerDirection } from '@editor/slotOrderOps'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'
import { t } from '@i18n'

export interface SlotLayerMenuOptions {
  /** true = Pose 态（菜单里有「删除插槽」）；Animate 态没有删除项，移动操作打层级关键帧 */
  pose: boolean
  /** 操作结果提示（视口 / 面板各自的状态栏） */
  onStatus: (text: string) => void
}

/**
 * 「插槽层级」右键菜单的公共菜单项：视口右键 slot / display 与 slot 层级面板共用。
 *
 * - 移到最上层 / 上移一层 / 下移一层 / 移到最下层：内部走 `moveSlotLayer`
 *   （Pose 改 setup 层级；Animate 写当前时间的绘制顺序帧），没动（已在顶 / 底）就不出提示
 * - 删除插槽：只在 Pose 态出现（Animate 态的层级由关键帧驱动，删插槽是绑定数据的改动）
 */
export function slotLayerMenuItems(slot: string, options: SlotLayerMenuOptions): ContextMenuItem[] {
  const { pose, onStatus } = options
  const moveItem = (key: LayerDirection, label: string, icon: React.ReactNode, hint: string): ContextMenuItem => ({
    key: `layer-${key}`,
    label,
    icon,
    hint,
    onSelect: () => {
      const message = moveSlotLayer(slot, key)
      if (message) onStatus(message)
    }
  })
  const items: ContextMenuItem[] = [
    moveItem('top', t('移到顶层'), <ChevronsUp size={12} />, t('把「{0}」移到所有插槽的最前面（最后绘制）', slot)),
    moveItem('up', t('上移一层'), <ArrowUp size={12} />, t('「{0}」往前画一层（盖住下面的）', slot)),
    moveItem('down', t('下移一层'), <ArrowDown size={12} />, t('「{0}」往后画一层（被上面的盖住）', slot)),
    moveItem('bottom', t('移到底层'), <ChevronsDown size={12} />, t('把「{0}」移到所有插槽的最后面（最先绘制）', slot))
  ]
  if (pose) {
    items.push(
      { key: 'sep', label: '', separator: true },
      {
        key: 'delete-slot',
        label: t('删除插槽'),
        danger: true,
        icon: <Trash2 size={12} />,
        hint: t('删除插槽「{0}」及其附件、动画轨道（不可撤销时 Ctrl+Z 也能回）', slot),
        onSelect: () => {
          deleteSlotNamed(slot)
          onStatus(t('已删除插槽「{0}」', slot))
        }
      }
    )
  }
  return items
}
