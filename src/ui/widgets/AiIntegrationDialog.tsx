import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, X } from 'lucide-react'
import { getPlatform } from '@editor/platform'
import type { McpClientResult } from '@shared/ipcTypes'
import { useDialogDrag } from './dialogDrag'

export interface AiIntegrationDialogProps {
  onClose: () => void
}

interface McpInfo {
  running: boolean
  mcpUrl: string
  url: string
  token: string
}

/**
 * AI 接入面板：让 AI 工具（Claude / Cursor / VSCode / Codex / WorkBuddy 等）自动加载
 * Hao2DEditor 的命令。两种用法：
 * - 复制 MCP URL，手动填进任意支持 HTTP MCP 的客户端；
 * - 「一键安装」把 URL 写进已识别的客户端配置（Claude / Cursor / VSCode 自动写；
 *   Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode 只探测安装目录，需手动填）。
 */
export default function AiIntegrationDialog({ onClose }: AiIntegrationDialogProps) {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [report, setReport] = useState<McpClientResult[] | null>(null)
  const [installing, setInstalling] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

  useEffect(() => {
    void getPlatform()
      .aiMcpInfo()
      .then((result) => {
        if (result.ok) setInfo(result.data)
      })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (rootRef.current?.contains(event.target as Node)) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copy = (): void => {
    if (!info?.mcpUrl) return
    void navigator.clipboard?.writeText(info.mcpUrl).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  const install = (): void => {
    setInstalling(true)
    setReport(null)
    void getPlatform()
      .aiInstallMcp()
      .then((result) => {
        if (result.ok) {
          setReport(result.data.items)
          if (result.data.mcpUrl) setInfo((prev) => ({ ...(prev as McpInfo), mcpUrl: result.data.mcpUrl }))
        } else {
          setReport([{ id: 'err', label: '安装失败', status: 'error', error: result.error }])
        }
      })
      .finally(() => setInstalling(false))
  }

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex h-auto w-[520px] flex-col rounded-[6px] border border-line bg-ink-800 shadow-2xl"
        style={panelStyle}
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-line px-3" {...handleProps}>
          <span className="hao-panel-title">AI 接入</span>
          <button
            type="button"
            // 标题栏的 `cursor: grab` 会被继承下来，按钮自己声明 pointer 盖掉它
            className="cursor-pointer text-content-lo hover:text-content-hi"
            title="关闭"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          <p className="text-3xs leading-[16px] text-content-lo">
            让 AI 工具把 Hao2DEditor 当成一个 MCP Server 自动加载：它启动后会在本机开一个
            只监听 127.0.0.1 的命令服务，AI 客户端填下面的地址即可读写当前工程。
          </p>

          <div className="flex flex-col gap-1">
            <span className="text-3xs text-content-mid">
              命令服务：{info?.running ? <span className="text-emerald-400">运行中</span> : <span className="text-amber-400">未启动</span>}
            </span>
            <span className="text-3xs text-content-lo">
              {info?.running
                ? '把下面的 MCP 地址填进 AI 客户端，或点「一键安装」。'
                : '请保持编辑器处于打开状态，命令服务随窗口启动。'}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-3xs text-content-mid">MCP 地址（含访问 token）</span>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={info?.mcpUrl ?? ''}
                className="hao-field min-w-0 flex-1 truncate font-mono text-3xs"
                placeholder="命令服务未启动"
              />
              <button
                type="button"
                className="hao-btn h-[24px] shrink-0 px-2 text-3xs"
                onClick={copy}
                disabled={!info?.mcpUrl}
                title="复制 MCP 地址"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="hao-btn hao-btn-accent h-[26px] self-start px-3 text-3xs"
            onClick={install}
            disabled={installing || !info?.running}
          >
            {installing ? '安装中…' : '一键安装到 AI 客户端'}
          </button>

          {report ? (
            <div className="flex flex-col gap-1 rounded-[4px] border border-line/60 px-2.5 py-2">
              <span className="text-3xs text-content-mid">安装结果</span>
              {report.map((item) => (
                <div key={item.id} className="flex items-start gap-2 text-3xs leading-[15px]">
                  <span className="shrink-0 text-content-hi">{item.label}</span>
                  <span className="min-w-0 flex-1 text-content-lo">
                    {item.status === 'written' ? (
                      <span className="text-emerald-400">已写入配置</span>
                    ) : item.status === 'error' ? (
                      <span className="text-danger/90">失败：{item.error}</span>
                    ) : (
                      <span className="text-amber-400">
                        需手动配置（{item.installed ? '已检测到安装目录' : '未检测到安装目录'}）
                      </span>
                    )}
                    {item.path ? <span className="block truncate font-mono text-content-lo/70">{item.path}</span> : null}
                  </span>
                </div>
              ))}
              <span className="text-3xs leading-[15px] text-content-lo/70">
                标「需手动配置」的客户端（Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode）
                请把上面的 MCP 地址填进它们各自的 MCP 设置。
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex h-[40px] shrink-0 items-center justify-end border-t border-line px-4">
          <button type="button" className="hao-btn h-[24px] px-3 text-3xs" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
