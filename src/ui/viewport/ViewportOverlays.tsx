import { useState } from 'react'
import { Bone, Box, Crosshair, Eye, Globe, Image, MousePointer2, Waypoints } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getActiveScene } from '@editor/activeScene'
import type { GizmoSpace, OverlayState, SelectableState } from '@editor/store/toolStore'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import { t } from '@i18n'

export interface ViewportOverlaysProps {
  zoom: number
  overlay: OverlayState
  selectable: SelectableState
  space: GizmoSpace
  onToggleOverlay: (key: keyof OverlayState) => void
  onToggleSelectable: (key: keyof SelectableState) => void
  onSetSpace: (space: GizmoSpace) => void
  onFitViewport: () => void
}

/**
 * 「选项」矩阵的行：三类对象 × 两列开关（可被选中 / 可见）。
 *
 * 之所以做成矩阵而不是一排图标：这三类的两个开关是**同一件事的两个维度**，
 * 排成矩阵才能一眼看出「图片看得见但点不到」这种组合，也不用为六种状态各记一个图标。
 */
function optionRows(): Array<{ key: keyof SelectableState; label: string; icon: LucideIcon }> {
  return [
    { key: 'display', label: t('图片'), icon: Image },
    { key: 'bones', label: t('骨骼'), icon: Bone },
    { key: 'constraints', label: t('约束'), icon: Waypoints }
  ]
}

/** 矩阵里的一个开关：实心点 = 开，空心点 = 关（与 Spine 的 Options 同一套读法） */
function OptionCell({ on, title, onClick }: { on: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className="flex h-[15px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] transition-colors hover:bg-white/[0.08]"
    >
      <span
        aria-hidden
        className={
          on
            ? 'h-[6px] w-[6px] rounded-full bg-accent shadow-[0_0_0_2px_rgba(10,132,255,0.18)]'
            : 'h-[6px] w-[6px] rounded-full border border-white/25'
        }
      />
    </button>
  )
}

/**
 * 小坐标轴的坐标空间（本地 / 世界），与下面的叠加层开关分开排在最前面：
 * 它决定「轴朝哪、拖动按哪个方向算」，是操作本身的一部分，不是显示开关。
 */
function spaces(): Array<{ key: GizmoSpace; label: string; icon: LucideIcon; hint: string }> {
  return [
    {
      key: 'local',
      label: t('本地'),
      icon: Box,
      hint: t('本地空间（默认）：小坐标轴跟着骨骼自身朝向，拖 X 轴 = 沿骨骼方向')
    },
    {
      key: 'world',
      label: t('世界'),
      icon: Globe,
      hint: t('世界空间：小坐标轴固定对齐世界 X / Y（画面上永远水平 / 竖直），拖动也只沿世界方向')
    }
  ]
}

/**
 * 视口**右上角**的浮动面板：坐标空间（本地 / 世界）+ 缩放读数与「适配视野」
 * + 整体染色 + **选项矩阵**（图片 / 骨骼 / 约束 × 可被选中 / 可见）。
 *
 * 与左上角的 Pose / Animate 开关（ModeSwitch）同一种外观与尺寸：它们都是视口上下文的
 * 高频操作，贴着画布浮着比占用菜单栏下面一整行更省地方，视线也不用离开画面。
 *
 * 整体染色原来在属性面板的「显示」一组里：它改的是**怎么看画面**，与选中了谁无关 ——
 * 搬到画布边上，调完立刻能看到叠加效果，属性面板也就少一块与选中对象无关的噪音。
 *
 * 选项矩阵替代了原来「骨骼 / 约束」两个可见性图标：那两项在矩阵里都有一格，
 * 再单独放一排图标就是同一个开关出现两次。矩阵还补上了「图片」的可见性。
 *
 * 只有第一行（本地 / 世界）**图标 + 文字**：它是「坐标系」而不是开关，
 * 文字比图标更不容易认错；其余各行仍只用图标，文字收在 title 里。
 */
export default function ViewportOverlays(props: ViewportOverlaysProps) {
  const { zoom, overlay, selectable, space } = props
  /**
   * 整体染色（场景级、不进文档）：用本地状态回显当前值。
   * 否则受控的 `<input type="color">` 会一直是写死的白色，拾色后看着像"改了没反应"。
   */
  const [tint, setTint] = useState('#FFFFFFFF')
  const applyTint = (hex: string): void => {
    setTint(hex)
    getActiveScene()?.setTint(hexToRgba(hex))
  }
  /** 拾色器只认 #RRGGBB（不带 alpha），透明度单独由滑杆调 */
  const rgb = tint.length === 9 ? tint.slice(0, 7) : tint
  const alpha = Math.round(hexToRgba(tint).a * 100)

  return (
    /*
     * **竖向排列**：坐标系 / 缩放 / 染色（色块 + 透明度）/ 选项矩阵，一块一行，块间一条细分割线。
     * 定宽而不是由内容撑开：滑杆要占满一整行，宽度由它来定，其它行跟着对齐（否则每行宽度都不同，
     * 面板边缘会参差不齐）。
     */
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex w-[120px] flex-col rounded-[7px] border border-white/10 bg-ink-900/70 p-0.5 shadow-lg shadow-black/30 backdrop-blur-md">
      <div className="flex items-center gap-0.5 px-1">
        {/*
          空间：本地 / 世界（单选，永远有一项是高亮的），各占一半宽度铺满这一行。
          这一行**带文字**（其余行只用图标）：它是「坐标系」而不是开关，文字比图标更不容易认错，
          而且中文两字 / 英文一个词都放得下，不会把面板撑宽。
        */}
        {spaces().map(({ key, label, icon: Icon, hint }) => (
          <button
            key={key}
            type="button"
            title={hint}
            aria-pressed={space === key}
            onClick={() => props.onSetSpace(key)}
            className={['hao-tool-button h-[22px] flex-1 gap-1', space === key ? 'hao-tool-button-active' : ''].join(' ')}
          >
            <Icon size={12} />
            <span className="whitespace-nowrap text-3xs">{label}</span>
          </button>
        ))}
      </div>
      {/* 第二行：适配视野（图标在左）+ 缩放读数（数字在右），两端对齐 */}
      <div className="mt-0.5 flex items-center justify-between gap-1 px-1">
        <button
          type="button"
          title={t('适配视野 (F)')}
          onClick={props.onFitViewport}
          className="hao-tool-button h-[20px] w-[24px]"
        >
          <Crosshair size={13} />
        </button>
        {/*
          读数按 5 个字符预留宽度并右对齐：位数增减时面板不再左右晃动。
          固定宽度放在**内层纯文字**的 span 上 —— 外层还背着内边距，
          border-box 会把内边距算进 min-width，导致预留空间不足（80%→110% 仍会晃）
        */}
        <span className="font-mono text-3xs text-content-lo">
          <span className="inline-block min-w-[5ch] text-right">{zoom.toFixed(0)}%</span>
        </span>
      </div>
      {/*
        分割线**自己占一层**（左右各让 4px），不挂在内容块的 `border-t` 上：
        给内容块加 `mx-1 + px-1` 会把内容整体右移 8px，与上面几行对不齐 —— 之前就是这么歪的。
      */}
      <span aria-hidden className="mx-1 my-1 h-px shrink-0 bg-white/10" />
      {/*
        第三块：染色。色块 = 拾色器（原生弹层的说明见 ColorField），**透明度单独一行**：
        与色块挤一行的话滑杆只能占一半（还要给百分比读数留位），拉满一行更好拖。
      */}
      <div className="px-1">
        <div className="flex items-center justify-between gap-1">
          <span
            className="shrink-0 select-none text-3xs text-content-lo"
            title={t('整体染色（与插槽色、附件色相乘）；双击复位为白色')}
          >
            {t('染色')}
          </span>
          <input
            type="color"
            value={rgb}
            title={t('整体染色（与插槽色、附件色相乘）；双击复位为白色')}
            onDoubleClick={() => applyTint('#FFFFFFFF')}
            onChange={(event) => applyTint(`${event.target.value.toUpperCase()}${tint.slice(7)}`)}
            className="h-[20px] w-[24px] shrink-0 cursor-pointer rounded-[4px] border border-white/15 bg-transparent p-0"
          />
        </div>
        {/* 透明度只留滑杆、不放百分比读数：读数调完就没人再看，还要按位数留白 */}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={alpha}
          title={t('染色透明度')}
          onChange={(event) => applyTint(rgbaToHex({ ...hexToRgba(tint), a: Number(event.target.value) / 100 }))}
          className="mt-1 h-[14px] w-full cursor-pointer accent-accent"
        />
      </div>
      <span aria-hidden className="mx-1 my-1 h-px shrink-0 bg-white/10" />
      {/*
        第四块：**选项矩阵** —— 行 = 图片 / 骨骼 / 约束，列 = 可被选中 / 可见。
        「可见」原来只对骨骼 / 约束各给了一个图标，这里补齐图片，并把「可选」放在旁边：
        两者是同一件事的两个维度（看得见但不想点到 / 看不见自然也点不到），排成矩阵最省地方。
      */}
      <div className="flex flex-col gap-px px-1">
        {/* 行首用图标而不是文字：三类对象各有一个固定图形（图片 / 骨头 / 约束），
            比三个两字词窄得多，也和第一行「只用图标」的风格一致；文字都在 title 里 */}
        <div className="flex items-center">
          {/* 行首占满剩余宽度：图标贴左、两列开关贴右，与面板右边缘对齐 */}
          <span aria-hidden className="flex-1" />
          <span className="flex w-[18px] shrink-0 justify-center text-content-lo" title={t('可被选中')}>
            <MousePointer2 size={10} />
          </span>
          <span className="flex w-[18px] shrink-0 justify-center text-content-lo" title={t('可见')}>
            <Eye size={10} />
          </span>
        </div>
        {optionRows().map(({ key, label, icon: Icon }) => (
          <div key={key} className="flex items-center">
            {/* 图标 + 文字：三类对象的图形单看容易混（尤其图片与约束），配上两字标签更好认 */}
            <span className="flex min-w-0 flex-1 items-center gap-0.5 text-content-mid" title={label}>
              <Icon size={11} className="shrink-0" />
              {/* 英文的「Constraints」比中文长不少，放不下时省略而不是换行 / 撑宽面板 */}
              <span className="truncate text-3xs">{label}</span>
            </span>
            <OptionCell
              on={selectable[key]}
              title={`${label} · ${t('可被选中')}`}
              onClick={() => props.onToggleSelectable(key)}
            />
            <OptionCell on={overlay[key]} title={`${label} · ${t('可见')}`} onClick={() => props.onToggleOverlay(key)} />
          </div>
        ))}
      </div>
    </div>
  )
}
