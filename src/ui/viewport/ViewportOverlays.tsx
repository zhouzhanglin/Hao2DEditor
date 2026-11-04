import { useState } from 'react'
import { Bone, Box, Crosshair, Globe, Waypoints } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getActiveScene } from '@editor/activeScene'
import type { GizmoSpace, OverlayState } from '@editor/store/toolStore'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import { t } from '@i18n'

export interface ViewportOverlaysProps {
  zoom: number
  overlay: OverlayState
  space: GizmoSpace
  onToggleOverlay: (key: keyof OverlayState) => void
  onSetSpace: (space: GizmoSpace) => void
  onFitViewport: () => void
}

/**
 * 叠加层开关。**只剩与「在编辑谁」无关的两项**：骨架与约束手柄 —— 任何工具下看的都是同一件事。
 *
 * 「网格 / FFD / 权重」都已移除：它们分别跟着选中项、顶点工具、权重刷工具自动显示，
 * 手动开全局版只会把整个角色铺满线条与顶点，还得记着关回去。
 */
/** 叠加层文案随语言切换，故做成函数（文字都收进 title：面板上只留图标，省地方也少一层视觉噪音） */
function overlays(): Array<{ key: keyof OverlayState; label: string; hint: string; icon: LucideIcon }> {
  return [
    { key: 'bones', label: t('骨骼'), icon: Bone, hint: t('显示 / 隐藏骨骼骨架') },
    { key: 'constraints', label: t('约束'), icon: Waypoints, hint: t('显示 / 隐藏约束手柄（IK / 变换 / 路径 / 物理）') }
  ]
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
 * 视口**右上角**的浮动面板：坐标空间（本地 / 世界）+ 叠加层开关（骨骼 / 约束）
 * + 整体染色 + 缩放读数与「适配视野」。
 *
 * 与左上角的 Pose / Animate 开关（ModeSwitch）同一种外观与尺寸：它们都是视口上下文的
 * 高频操作，贴着画布浮着比占用菜单栏下面一整行更省地方，视线也不用离开画面。
 *
 * 缩放与「适配视野」原来在那一行里，跟着搬过来（那一行已整体移除）。
 *
 * 整体染色原来在属性面板的「显示」一组里：它改的是**怎么看画面**，与选中了谁无关 ——
 * 搬到画布边上，调完立刻能看到叠加效果，属性面板也就少一块与选中对象无关的噪音。
 * 它单独占**第二行**（右对齐）：上面那行全是开 / 关按钮，滑杆混进去会被当成又一个开关。
 *
 * 四个按钮**只用图标、不写字**：这一行要挤下四个开关 + 缩放读数，「骨骼 / 约束 / 本地 / 世界」
 * 四个两字词排开会把面板撑得很长；文字都进 title，鼠标停一下照样看得到。
 */
export default function ViewportOverlays(props: ViewportOverlaysProps) {
  const { zoom, overlay, space } = props
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
    // 一整块浮层：上面一行是开关 + 缩放，下面一行是整体染色，中间一条细分割线
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex flex-col rounded-[7px] border border-white/10 bg-ink-900/70 p-0.5 shadow-lg shadow-black/30 backdrop-blur-md">
      <div className="flex items-center gap-0.5">
        {/* 空间：本地 / 世界（单选，永远有一项是高亮的） */}
        {spaces().map(({ key, label, icon: Icon, hint }) => (
          <button
            key={key}
            type="button"
            title={hint}
            aria-label={label}
            aria-pressed={space === key}
            onClick={() => props.onSetSpace(key)}
            className={['hao-tool-button h-[22px] w-[24px] shrink-0', space === key ? 'hao-tool-button-active' : ''].join(' ')}
          >
            <Icon size={13} />
          </button>
        ))}
        {/* 分隔线：左边是「怎么变换」，右边是「显示什么」，两件事不该看成一排同类开关 */}
        <span aria-hidden className="mx-0.5 h-[14px] w-px shrink-0 bg-white/10" />
        {overlays().map(({ key, label, icon: Icon, hint }) => (
          <button
            key={key}
            type="button"
            title={hint}
            aria-label={label}
            aria-pressed={overlay[key]}
            onClick={() => props.onToggleOverlay(key)}
            className={['hao-tool-button h-[22px] w-[24px] shrink-0', overlay[key] ? 'hao-tool-button-active' : ''].join(' ')}
          >
            <Icon size={13} />
          </button>
        ))}
        {/*
          缩放读数按 4 位数 + % 预留宽度并右对齐：位数增减时面板不再左右晃动。
          固定宽度放在**内层纯文字**的 span 上 —— 外层还背着 px 内边距，
          border-box 会把内边距算进 min-width，导致预留空间不足（80%→110% 仍会晃）
        */}
        <span className="px-1.5 font-mono text-3xs text-content-lo">
          <span className="inline-block min-w-[5ch] text-right">{zoom.toFixed(0)}%</span>
        </span>
        <button
          type="button"
          title={t('适配视野 (F)')}
          onClick={props.onFitViewport}
          className="hao-tool-button h-[22px] w-[24px]"
        >
          <Crosshair size={13} />
        </button>
      </div>
      {/*
        第二行：整体染色。色块 = 拾色器（原生弹层的说明见 ColorField），滑杆 = 透明度。
        单独一行而不是塞进上面那行：上面全是「开 / 关」按钮，掺一个滑杆会被当成又一个开关；
        说明文字也不搬过来 —— 画布边上没地方摆一段话，都收进 title。
      */}
      <div className="mx-1 mt-1 flex items-center justify-between gap-1.5 border-t border-white/10 px-1 pt-1">
        {/* 标签贴左边缘（与上一行第一个按钮对齐），控件组靠右：两行左右都对齐，不会一边空一块 */}
        <span className="shrink-0 select-none text-3xs text-content-lo">{t('整体染色')}</span>
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={rgb}
            title={t('整体染色（与插槽色、附件色相乘）；双击复位为白色')}
            onDoubleClick={() => applyTint('#FFFFFFFF')}
            onChange={(event) => applyTint(`${event.target.value.toUpperCase()}${tint.slice(7)}`)}
            className="h-[22px] w-[24px] shrink-0 cursor-pointer rounded-[4px] border border-white/15 bg-transparent p-0"
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={alpha}
            title={t('染色透明度')}
            onChange={(event) => applyTint(rgbaToHex({ ...hexToRgba(tint), a: Number(event.target.value) / 100 }))}
            className="h-[14px] w-[56px] shrink-0 cursor-pointer accent-accent"
          />
          <span className="w-[32px] shrink-0 text-right font-mono text-3xs text-content-lo">{alpha}%</span>
        </div>
      </div>
    </div>
  )
}
