import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical } from 'lucide-react'
import { useModeStore } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { drawOrderFrameAt, keyDrawOrder } from '@editor/commands/animationCommands'
import { applySlotOrder } from '@editor/commands/hierarchyCommands'

type Direction = 'up' | 'down' | 'top' | 'bottom'
const ORDER_MIME = 'application/x-hao2d-slotorder'

/** slot 层级面板：Pose 改 setup 的 zOrder；Animate 态自动在当前时间打绘制顺序关键帧 */
export default function SlotOrderPanel({ onStatus = () => undefined }: { onStatus?: (text: string) => void }) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const mode = useModeStore((s) => s.mode)
  const timeline = useTimelineStore()
  const [dragging, setDragging] = useState<string | null>(null)

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

  const dropAt = (targetName: string, side: 'before' | 'after'): void => {
    if (!dragging || dragging === targetName) return
    const names = [...layers].filter((name) => name !== dragging)
    const at = names.indexOf(targetName)
    if (at < 0) return
    names.splice(side === 'before' ? at : at + 1, 0, dragging)
    setDragging(null)
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
      {/* 容器同时兜底「拖到列表下方空白」：落到末尾 = 最底层 */}
      <div
        className="hao-scroll min-h-0 flex-1 overflow-auto pb-1"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(ORDER_MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          // 落在这里 = 没落在任何行上（行下方 / 行间的空白）→ 放到列表末尾
          const from = event.dataTransfer.getData(ORDER_MIME)
          if (!from) return
          event.preventDefault()
          const names = [...layers].filter((name) => name !== from)
          names.push(from)
          setDragging(null)
          commitOrder(names)
        }}
      >
        {layers.map((name) => {
          const slot = rowByName(document, name)
          if (!slot) return null
          // 选中 display（附件）时也高亮它所属的插槽：两处选择是同一个对象
          const active =
            (selection.kind === 'slot' || selection.kind === 'attachment') && selection.slot === name
          return (
            <div
              key={name}
              ref={active ? activeRowRef : null}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(ORDER_MIME, name)
                event.dataTransfer.effectAllowed = 'move'
                setDragging(name)
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(ORDER_MIME)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                const from = event.dataTransfer.getData(ORDER_MIME)
                if (!from || from === name) return
                // 行内自己处理完就停：不要让容器的兜底再提交一次（会把位置覆盖成末尾）
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                dropAt(name, event.clientY - rect.top < rect.height / 2 ? 'before' : 'after')
              }}
              className={[
                'group flex h-[22px] cursor-grab items-center gap-1 px-1.5 text-panel active:cursor-grabbing',
                active ? 'bg-accent/12 text-yellow-400' : 'text-content-mid hover:bg-ink-700',
                dragging === name ? 'opacity-40' : '',
                slot.visible ? '' : 'opacity-55'
              ].join(' ')}
              onClick={() => selection.selectSlot(name)}
              title={`${slot.name}（挂载于「${slot.bone}」）：拖动调整绘制顺序${animate ? '，Animate 态自动打关键帧' : ''}`}
            >
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
      </div>
    </div>
  )
}

function rowByName(doc: { slots: Array<{ name: string; bone: string; visible: boolean }> }, name: string) {
  return doc.slots.find((slot) => slot.name === name)
}
