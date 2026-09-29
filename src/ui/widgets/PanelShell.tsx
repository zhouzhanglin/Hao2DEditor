import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

export interface PanelShellProps {
  title: string
  /** 面板头部右侧的额外操作区 */
  actions?: React.ReactNode
  children: React.ReactNode
  /** 面板在纵向是否可伸缩（flex-1），默认 true */
  grow?: boolean
  className?: string
  bodyClassName?: string
  /** 面板整体的内联样式（例如由分隔条拖出的固定高度） */
  style?: React.CSSProperties
  collapsible?: boolean
  defaultCollapsed?: boolean
}

/** 统一面板容器：26px 头部 + 内容区，支持折叠与操作区。 */
export default function PanelShell({
  title,
  actions,
  children,
  grow = true,
  className,
  bodyClassName,
  style,
  collapsible = true,
  defaultCollapsed = false
}: PanelShellProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <section
      className={['hao-panel', grow ? 'flex-1' : 'shrink-0', className ?? ''].join(' ')}
      style={style}
    >
      <header className="hao-panel-header">
        <div className="flex min-w-0 items-center gap-1">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? '展开' : '折叠'}
              className="flex h-[16px] w-[16px] items-center justify-center rounded text-content-lo transition-colors duration-panel hover:text-content-hi"
            >
              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : null}
          <span className="hao-panel-title truncate">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </header>
      {collapsed ? null : (
        <div
          className={['min-h-0 flex-1 overflow-auto hao-scroll', bodyClassName ?? ''].join(' ')}
        >
          {children}
        </div>
      )}
    </section>
  )
}

/** 面板内的空状态提示 */
export function PanelEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
      <p className="text-panel font-medium text-content-mid">{title}</p>
      <p className="max-w-[240px] text-3xs leading-relaxed text-content-lo">{description}</p>
    </div>
  )
}
