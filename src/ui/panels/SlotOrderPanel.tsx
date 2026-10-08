import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, KeyRound } from 'lucide-react'
import { useModeStore } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useShallow } from 'zustand/react/shallow'
import { drawOrderFrameAt, keyDrawOrder } from '@editor/commands/animationCommands'
import { applySlotOrder } from '@editor/commands/hierarchyCommands'
import { keyframeTargetsNow } from '@editor/timeline/actions'
import type { KeyframeTarget } from '@editor/timeline/model'
import ContextMenu from '@ui/widgets/ContextMenu'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'

type Direction = 'up' | 'down' | 'top' | 'bottom'
const ORDER_MIME = 'application/x-hao2d-slotorder'

/** slot 层级面板：Pose 改 setup 的 zOrder；Animate 态自动在当前时间打绘制顺序关键帧 */
export default function SlotOrderPanel({ onStatus = () => undefined }: { onStatus?: (text: string) => void }) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const mode = useModeStore((s) => s.mode)
  // 细粒度订阅：只跟这两个字段。原来订阅整个 store，擦洗时每次 setTime 都会重渲染本面板
  const timeline = useTimelineStore(
    useShallow((s) => ({ currentAnimation: s.currentAnimation, time: s.time }))
  )
  const [dragging, setDragging] = useState<string | null>(null)
  /** 拖动中的插入位置（0..n）；null = 没在拖 */
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /** 行元素（按插槽名索引）：插入位置靠它们的中心线算 */
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>())
  /** 行右键菜单（Animate 态：给这条插槽打关键帧） */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; slot: string } | null>(null)

  const animate = mode === 'animate' && timeline.currentAnimation !== null
  const animation = document.animations.find((item) => item.name === timeline.currentAnimation) ?? null

  /** 图层顺序（顶层在前）：Pose 用 setup（zOrder 降序）；Animate 且有帧时用帧顺序（缺的补到底层） */
  const layers = useMemo(() => {
    const setupTopFirst = [...document.slots].sort((l, r) => r.zOrder - l.zOrder).map((slot) => slot.name)
    const frame = animation ? drawOrderFrameAt(animation, timeline.time) : null
    if (!animate || !frame) return setupTopFirst
    const names = [...frame.order].reverse()
    for (const name of setupTopFirst) if (!names.includes(name)) names.push(name)
    return names.filter((name) => document.slots.some((slot) => slot.name === name))
  }, [document.slots, animate, animation, timeline.time])

  /** 按 UI 列表顺序落库：Pose 改 zOrder，Animate 打绘制顺序帧 */
  const commitOrder = (names: readonly string[]): void => {
    if (animate && animation) {
      const order = [...names].reverse() // 图层列表顶层在前 → 绘制顺序反过来（第 0 个最先画）
      const at = timeline.time
      update('绘制顺序关键帧', (draft) => {
        const target = draft.animations.find((item) => item.name === animation.name)
        if (target) keyDrawOrder(target, at, order)
      })
      onStatus?.(`已在 ${at.toFixed(2)}s 写入绘制顺序帧（${names.length} 个插槽）`)
      return
    }
    update('调整插槽层级', (draft) => {
      applySlotOrder(draft, names)
    })
    onStatus?.('已调整插槽绘制顺序（setup）')
  }

  const move = (name: string, direction: Direction): void => {
    const names = [...layers]
    const index = names.indexOf(name)
    if (index < 0) return
    const [moved] = names.splice(index, 1)
    const target =
      direction === 'up'
        ? Math.max(0, index - 1)
        : direction === 'down'
          ? Math.min(names.length, index + 1)
          : direction === 'top'
            ? 0
            : names.length
    names.splice(target, 0, moved)
    commitOrder(names)
  }

  /**
   * 鼠标 y → 插入位置（0..n）。判定基准是**每行的中心线**，所以：
   * - 行的上半 → 插到它前面；下半 → 插到它后面（边缘 / 1px 缝隙都算得出来）
   * - 列表下方（或上方）的空白 → 直接落到末尾 / 开头
   *
   * 落点由容器统一计算，不依赖「drop 事件命中了哪一行」——
   * 拖到行边缘、行与行之间、列表空白处都能生效。
   */
  const dropIndexAt = (clientY: number): number => {
    const names = layers.filter((name) => name !== dragging)
    let index = 0
    for (const name of names) {
      const row = rowRefs.current.get(name)
      if (!row) continue
      const rect = row.getBoundingClientRect()
      if (clientY > rect.top + rect.height / 2) index++
      else break
    }
    return index
  }

  const commitDrop = (clientY: number): void => {
    if (!dragging) return
    const names = [...layers].filter((name) => name !== dragging)
    const index = Math.max(0, Math.min(dropIndexAt(clientY), names.length))
    names.splice(index, 0, dragging)
    setDragging(null)
    setDropIndex(null)
    // 拖回原位不算改动：不产生撤销记录
    if (names.every((name, i) => name === layers[i])) return
    commitOrder(names)
  }

  /** 选中的行（在层级树 / 视口里选中 display 也会走到这里）：滚出视野时拉回可见范围 */
  const activeRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selection.kind, selection.slot])

  const toggleVisible = (name: string): void => {
    update('切换插槽可见性', (draft) => {
      const target = draft.slots.find((item) => item.name === name)
      if (target) target.visible = !target.visible
    })
  }

  /** 当前时刻是否已有绘制顺序帧（有则提供清除入口） */
  const hasFrameAtTime =
    animate &&
    animation !== null &&
    animation.drawOrder.some((frame) => Math.abs(frame.time - timeline.time) < 1e-4)

  const clearFrame = (): void => {
    if (!animation) return
    const at = timeline.time
    update('清除绘制顺序帧', (draft) => {
      const target = draft.animations.find((item) => item.name === animation.name)
      if (target) target.drawOrder = target.drawOrder.filter((frame) => Math.abs(frame.time - at) > 1e-4)
    })
    onStatus?.(`已清除 ${at.toFixed(2)}s 的绘制顺序帧（该时段回到 setup 顺序）`)
  }

  const arrowButton = (name: string, direction: 'up' | 'down'): React.ReactNode => (
    <button
      type="button"
      title={direction === 'up' ? '上移一层（更晚绘制，盖住下面的）' : '下移一层（更早绘制，被上面的盖住）'}
      className="flex h-[14px] w-[14px] items-center justify-center rounded text-content-lo hover:bg-ink-600 hover:text-content-hi"
      onClick={(event) => {
        event.stopPropagation()
        move(name, direction)
      }}
    >
      {direction === 'up' ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
    </button>
  )

  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-line/60 px-2 py-1 text-3xs leading-relaxed text-content-lo">
        {animate ? (
          <>
            Animate：拖动或点箭头会在 {timeline.time.toFixed(2)}s 写入绘制顺序帧
            {hasFrameAtTime ? (
              <button
                type="button"
                title="删除当前时刻的绘制顺序帧（该时段回到 setup 顺序）"
                className="ml-1 rounded px-1 text-content-lo underline decoration-dotted hover:text-danger"
                onClick={clearFrame}
              >
                清除此帧
              </button>
            ) : null}
          </>
        ) : (
          '上面的行画在更前面；调整的是 setup 绘制顺序'
        )}
      </p>
      {/* 落点全部由容器统一判定（按行中心线算插入位置）：行边缘 / 缝隙 / 空白都能拖 */}
      <div
        className="hao-scroll min-h-0 flex-1 overflow-auto pb-1"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(ORDER_MIME)) return
          event.preventDefault()
          // 内部拖拽就地处理，别让它继续冒泡（祖先若覆盖 dropEffect 会让浏览器不派发 drop）
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          const index = dropIndexAt(event.clientY)
          setDropIndex((current) => (current === index ? current : index))
        }}
        onDragLeave={(event) => {
          // 拖拽事件的 relatedTarget 多为 null，靠它判断会误清指示线（表现为线闪烁），
          // 直接看坐标是否还在列表范围内
          const rect = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            return
          }
          setDropIndex(null)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.getData(ORDER_MIME)) return
          event.preventDefault()
          commitDrop(event.clientY)
        }}
      >
        {layers.map((name, index) => {
          const slot = rowByName(document, name)
          if (!slot) return null
          // 选中 display（附件）时也高亮它所属的插槽：两处选择是同一个对象
          const active =
            (selection.kind === 'slot' || selection.kind === 'attachment') && selection.slot === name
          return (
            <div
              key={name}
              ref={(el) => {
                if (active) activeRowRef.current = el
                rowRefs.current.set(name, el)
              }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(ORDER_MIME, name)
                event.dataTransfer.effectAllowed = 'move'
                setDragging(name)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropIndex(null)
              }}
              className={[
                'group relative flex h-[22px] cursor-grab items-center gap-1 px-1.5 text-panel active:cursor-grabbing',
                active ? 'bg-accent/12 text-yellow-400' : 'text-content-mid hover:bg-ink-700',
                dragging === name ? 'opacity-40' : '',
                slot.visible ? '' : 'opacity-55'
              ].join(' ')}
              onClick={() => selection.selectSlot(name)}
              onContextMenu={(event) => {
                // Animate 态：右键插槽 = 给它打关键帧（显示 / 颜色 / 可见性）
                if (!animate) return
                event.preventDefault()
                setRowMenu({ x: event.clientX, y: event.clientY, slot: name })
              }}
              title={`${slot.name}（挂载于「${slot.bone}」）：拖动调整绘制顺序${animate ? '，Animate 态自动打关键帧，右键可打显示 / 颜色 / 可见性帧' : ''}`}
            >
              {/* 落点指示线：绝对定位，不占布局（占位会推挤行、让落点来回跳） */}
              {dropIndex === index ? (
                <span className="pointer-events-none absolute inset-x-0 -top-px h-[2px] bg-accent" />
              ) : null}
              <GripVertical size={10} className="shrink-0 text-content-lo/70" />
              <button
                type="button"
                title={slot.visible ? '隐藏插槽' : '显示插槽'}
                className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-content-lo hover:text-content-hi"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleVisible(name)
                }}
              >
                {slot.visible ? <Eye size={11} /> : <EyeOff size={11} />}
              </button>
              <span className="min-w-0 flex-1 truncate">{slot.name}</span>
              <span className="shrink-0 font-mono text-3xs text-content-lo/80">{slot.bone}</span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {arrowButton(name, 'up')}
                {arrowButton(name, 'down')}
              </span>
            </div>
          )
        })}
        {/* 末尾落点指示线：拖到列表下方的空白 = 放到最底层 */}
        {dropIndex !== null && dropIndex >= layers.length ? (
          <div className="h-[2px] bg-accent" />
        ) : null}
      </div>

      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          title={`插槽「${rowMenu.slot}」· 打关键帧${
            // 置灰项的 hover 提示看不到，把原因写在标题里
            document.animations.length === 0 ? '（工程里还没有动画：先在时间轴点「+ 动画」）' : ''
          }`}
          items={slotKeyframeItems(rowMenu.slot, onStatus, document.animations.length > 0)}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </div>
  )
}

/** 插槽的「打关键帧」菜单项：显示 / 颜色 / 可见性，以及一次打全部通道 */
function slotKeyframeItems(
  slot: string,
  onStatus: ((text: string) => void) | undefined,
  hasAnimation: boolean
): ContextMenuItem[] {
  const item = (key: string, label: string, hint: string, targets: KeyframeTarget[]): ContextMenuItem => ({
    key,
    label,
    // 没有动画时置灰并说明原因（点了只会闪一行状态栏，容易被当成「没反应」）
    hint: hasAnimation ? hint : '工程里还没有动画：先在时间轴点「+ 动画」',
    icon: <KeyRound size={12} />,
    disabled: !hasAnimation,
    onSelect: () => {
      const result = keyframeTargetsNow(targets, hint)
      onStatus?.(result.message)
    }
  })
  const channel = (name: string): KeyframeTarget[] => [
    { kind: 'slot', target: slot, attachment: '', channel: name }
  ]
  return [
    item('k-display', '显示关键帧', `${slot} · 显示`, channel('display')),
    item('k-color', '颜色关键帧', `${slot} · 颜色`, channel('color')),
    item('k-visible', '可见性关键帧', `${slot} · 可见性`, channel('visible')),
    { key: 'sep-k', label: '', separator: true },
    item('k-all', '全部通道关键帧', slot, [...channel('display'), ...channel('color'), ...channel('visible')])
  ]
}

function rowByName(doc: { slots: Array<{ name: string; bone: string; visible: boolean }> }, name: string) {
  return doc.slots.find((slot) => slot.name === name)
}
