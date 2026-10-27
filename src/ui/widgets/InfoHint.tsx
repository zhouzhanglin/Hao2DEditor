import { Info } from 'lucide-react'
import { t } from '@i18n'

/**
 * 说明图标：把「看一次就够」的解释文字收进气泡，鼠标悬停或点一下（拿到焦点）时显示。
 *
 * 为什么不在面板里直接摆一段话：属性面板的纵向空间很贵 —— 这些说明常驻要占三四行，
 * 会把真正要操作的控件挤到折叠线下面；而它们本身并不是每次操作都要读的。
 *
 * 气泡从图标**往左**铺开（右边缘与图标对齐）：图标一般贴在行尾 / 面板右缘，
 * 往右展开会被面板边界裁掉。宽度固定，长句子靠换行。
 *
 * 交互全用 CSS 完成（`group-hover` + `group-focus-within`），不挂 JS 监听：
 * 悬停即看、点一下留在原地（按钮拿到焦点）、点别处自动收起，不需要额外维护「打开了没有」。
 */
export function InfoHint({ text }: { text: string }) {
  return (
    <span className="group/info relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={t('说明')}
        /*
         * 偏黄的琥珀色而不是常规灰：这枚图标只是「这里还有说明」，混在一片次级灰文字里看不见。
         * 悬停 / 聚焦时提亮到满色，表示「点得动」。
         */
        className="flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full text-amber-400/85 transition-colors duration-panel hover:text-amber-400 focus:text-amber-400 focus:outline-none"
      >
        <Info size={12} />
      </button>
      <span
        role="tooltip"
        /*
         * 不用原生 `title`：它会和这个气泡同时出现（浏览器在悬停 1 秒后另弹一个系统样式），
         * 两个框叠在一起既难看又互相遮挡。
         */
        className="pointer-events-none absolute right-0 top-full z-40 mt-1 hidden w-[226px] rounded-[6px] border border-line bg-ink-800/95 p-1.5 text-3xs leading-relaxed text-content-mid shadow-lg shadow-black/40 backdrop-blur-md group-hover/info:block group-focus-within/info:block"
      >
        {text}
      </span>
    </span>
  )
}
