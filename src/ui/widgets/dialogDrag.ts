import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

/**
 * 拖动后至少要留在视口里的像素数。
 *
 * 夹住的意义不是「好看」，而是**别把自己拖丢**：面板横竖都至少留这么多在屏幕内，
 * 标题栏就永远抓得回来（30px 刚好是一个标题栏的高度）。
 */
const KEEP_VISIBLE = 30

/** 标题栏里这些控件有自己的点击语义（关闭、勾选、拖拽条），按在它们身上不算「拖窗口」 */
const NO_DRAG = 'button, input, select, textarea, a, label, [data-dialog-drag="off"]'

/** 面板「没被拖动过」时的矩形（视口坐标）：拖动范围按它算，拖动中若按当前矩形重算会自己追自己 */
interface BaseBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** 把 `value` 夹进 `[lo, hi]`；面板比视口还高时 `hi < lo`，此时按 `hi` 收（保证标题栏在屏幕内） */
function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return hi
  return Math.min(Math.max(value, lo), hi)
}

/**
 * 弹窗拖动：把标题栏变成抓手，整块面板可以拖到任意位置，双击标题栏复位到屏幕中央。
 *
 * 用法：面板根 div 贴 `panelStyle`，标题栏 div 摊 `handleProps`。
 *
 * ```tsx
 * const { panelStyle, handleProps } = useDialogDrag()
 * return (
 *   <div className="…" style={panelStyle}>
 *     <div className="…" {...handleProps}>标题栏</div>
 *     …
 *   </div>
 * )
 * ```
 *
 * 几个实现上的选择：
 *
 * - **只用 `transform` 表达位移，不动布局**。遮罩靠 `flex items-center justify-center` 居中，
 *   `ExportDialog` 还有 `items-start` + `my-auto` + `overflow-auto` 那套（面板变高时可滚）。
 *   改成 `absolute` + `left/top` 就得自己接管居中、resize 后还会飘；`transform` 对上面这些
 *   一律无影响。代价是面板成了一个**包含块**，里面的 `position: fixed` 元素会改为相对面板定位 ——
 *   所以全屏只有「颜色拾色器」是 fixed，而它是 portal 到 body 的（见 `ColorPickerPopover`），
 *   不在这棵子树里。
 * - **抓手默认就是标题栏的父元素**（`parentElement`），调用方不用额外传 ref 进来 ——
 *   这几个弹窗的标题栏都是面板的直接子元素。
 * - 拖动的原点记在 ref 里而不是读 state：`pointermove` 可能比 React 重渲染跑得快，
 *   读闭包里那个 `offset` 会拿到上一帧的值，拖快了会抖。
 */
export function useDialogDrag(): {
  /** 面板位移：贴在弹窗根 div 上（没拖动过时是 `undefined`，不产生 transform，也就没有包含块副作用） */
  panelStyle: CSSProperties | undefined
  /** 标题栏的抓手事件 + 光标 / 禁选 / 提示：摊在标题栏 div 上（自带 `style` 与 `title`，别在同一元素上重复写） */
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
    onDoubleClick: () => void
    title: string
    style: CSSProperties
  }
} {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  /** 是否正在拖：只管光标与「拖动时禁选文字」，每次按下 / 松开各变一次 */
  const [dragging, setDragging] = useState(false)
  /** 本次拖动的原点：按下那一刻的指针位置、面板位移、面板基础矩形 */
  const drag = useRef<{ x0: number; y0: number; ox: number; oy: number; box: BaseBox } | null>(null)

  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.userSelect
    // 指针划过弹窗正文时会把文字拖成选中态（蓝色高亮），拖动期间一律禁掉
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = previous
    }
  }, [dragging])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    // 只认左键：中键 / 右键（以及触控笔的橡皮端）留给别的用途
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest(NO_DRAG)) return
    const panel = event.currentTarget.parentElement
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    drag.current = {
      x0: event.clientX,
      y0: event.clientY,
      ox: offset.x,
      oy: offset.y,
      // 减去当前位移 = 面板「没被拖动过」时该在的矩形
      box: {
        left: rect.left - offset.x,
        top: rect.top - offset.y,
        right: rect.right - offset.x,
        bottom: rect.bottom - offset.y
      }
    }
    // 抓住指针：拖到弹窗外面（甚至窗口外）也照样收得到 move / up，不会半路丢拖动
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state) return
    const { box } = state
    setOffset({
      x: clamp(
        state.ox + (event.clientX - state.x0),
        KEEP_VISIBLE - box.right,
        window.innerWidth - KEEP_VISIBLE - box.left
      ),
      y: clamp(
        state.oy + (event.clientY - state.y0),
        KEEP_VISIBLE - box.top,
        window.innerHeight - KEEP_VISIBLE - box.top
      )
    })
  }

  /** 结束这次拖动：指针捕获会在 pointerup 后自动释放，这里只需清掉原点 */
  const endDrag = (): void => {
    drag.current = null
    setDragging(false)
  }

  return {
    panelStyle: offset.x === 0 && offset.y === 0 ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` },
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      // 触控被系统接管（来电、手势返回）时也会走到这里，别让面板卡在「拖动中」
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      // 拖歪了双击标题栏回到屏幕中央：位移清零，遮罩的居中布局立刻把它摆回正中间
      onDoubleClick: () => setOffset({ x: 0, y: 0 }),
      title: '按住标题栏可拖动窗口（双击回到屏幕中央）',
      style: {
        // 光标比类名可靠：`cursor-grab` 与 `cursor-grabbing` 谁赢取决于 CSS 里的先后，不取决于 class 的顺序
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        // 触屏 / 触控板：标了 none 才会把 pointermove 交给这里，而不是拿去滚页面
        touchAction: 'none'
      }
    }
  }
}
