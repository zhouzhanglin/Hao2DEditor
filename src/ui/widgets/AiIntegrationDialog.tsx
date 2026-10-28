import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, FolderOpen, X } from 'lucide-react'
import { getPlatform } from '@editor/platform'
import { useSettingsStore } from '@editor/store/settingsStore'
import type { McpClientResult, SkillBundleInfo, SkillTargetResult } from '@shared/ipcTypes'
import { useDialogDrag } from './dialogDrag'
import { t } from '@i18n'

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
 *
 * 面板下半部分还带一个「骨骼动画 Skill」：随 App 分发一份 Skill（给 AI 的工作手册），
 * 显示它落在安装目录的哪里、能一键复制进客户端的 skills 目录，也可自己选目录。
 */
export default function AiIntegrationDialog({ onClose }: AiIntegrationDialogProps) {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [report, setReport] = useState<McpClientResult[] | null>(null)
  const [installing, setInstalling] = useState(false)
  const [copied, setCopied] = useState(false)

  const [skills, setSkills] = useState<SkillBundleInfo | null>(null)
  const [skillReport, setSkillReport] = useState<SkillTargetResult[] | null>(null)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedCommand, setCopiedCommand] = useState('')
  const [copiedGuidance, setCopiedGuidance] = useState(false)
  /** 细节（路径 / 各客户端版本 / 选择目录 / 开关）默认收起：面板主体是 MCP 那一段 */
  const [showSkillDetail, setShowSkillDetail] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

  /** 保存工程时是否把 Skill 也复制进 `<工程>/ai/skills/` */
  const aiSkillInProject = useSettingsStore((state) => state.aiSkillInProject)
  const setAiSkillInProject = useSettingsStore((state) => state.setAiSkillInProject)
  /** 客户端已装同版本时是否仍然复制（默认不复制，避免同一份手册读两遍） */
  const aiSkillAlwaysCopyProject = useSettingsStore((state) => state.aiSkillAlwaysCopyProject)
  const setAiSkillAlwaysCopyProject = useSettingsStore((state) => state.setAiSkillAlwaysCopyProject)
  const reloadSkills = (): void => {
    void getPlatform()
      .aiSkillsInfo()
      .then((result) => {
        if (result.ok) setSkills(result.data)
      })
  }

  useEffect(() => {
    void getPlatform()
      .aiMcpInfo()
      .then((result) => {
        if (result.ok) setInfo(result.data)
      })
    reloadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时拉一次
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
          setReport([{ id: 'err', label: t('安装失败'), status: 'error', error: result.error }])
        }
      })
      .finally(() => setInstalling(false))
  }

  const openSkillsDir = (): void => {
    setSkillError('')
    void getPlatform()
      .aiOpenSkillsDir()
      .then((result) => {
        if (!result.ok) setSkillError(result.error)
      })
  }

  const copySkillPath = (): void => {
    if (!skills?.path) return
    void navigator.clipboard?.writeText(skills.path).then(() => {
      setCopiedPath(true)
      window.setTimeout(() => setCopiedPath(false), 1600)
    })
  }

  const copyText = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedCommand(text)
      window.setTimeout(() => setCopiedCommand(''), 1600)
    })
  }

  /**
   * 给 Codex 这类**不会自动发现 skill** 的客户端的一句话：
   * 它既不会去读 `~/.codebuddy/skills`，也不会自动扫工程里的 `ai/skills/`，
   * 把这句话粘进对话框，它就知道该读哪两份文件、去哪拿连接信息。
   */
  const copyGuidance = (): void => {
    const dirName = skills?.skills[0]?.dirName ?? 'hao2d-skeletal-animation'
    // 已装到客户端的：提示别再重复读工程副本；工程副本开着就用相对路径（Codex 按工作区解析最稳）；
    // 两者都没有才退回随包绝对路径。
    const text = installedAny
      ? `你已加载 hao2d-skeletal-animation Skill 就直接按它执行，不要再读工程里的同名副本；` +
        `需要补充信息时读工程 ai/hao2d-ai-playbook.md，连接地址与 token 在 ai/hao2d-ai-server.json。`
      : aiSkillInProject
        ? `读工程目录的 ai/hao2d-ai-playbook.md，再按 ai/skills/${dirName}/SKILL.md 执行；` +
          `要连编辑器时地址与 token 在 ai/hao2d-ai-server.json。`
        : `读 ${skills?.path ?? ''}/${dirName}/SKILL.md（Hao2DEditor 随包 Skill），按里面的流程操作；` +
          `编辑器地址与 token 见「AI 接入」面板的 MCP 地址。`
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedGuidance(true)
      window.setTimeout(() => setCopiedGuidance(false), 1600)
    })
  }

  const installSkill = (dir?: string): void => {
    setSkillBusy(true)
    setSkillError('')
    setSkillReport(null)
    void getPlatform()
      .aiInstallSkill(dir ? { dir } : undefined)
      .then((result) => {
        if (result.ok) {
          setSkillReport(result.data.items)
          // 装完重读一遍：面板上的「已装 vX / 可更新」要立刻反映结果
          reloadSkills()
        } else {
          setSkillError(result.error)
        }
      })
      .finally(() => setSkillBusy(false))
  }

  const pickSkillDir = (): void => {
    void getPlatform()
      .pickFiles({ title: t('选择 AI 客户端的 skills 目录'), directory: true })
      .then((paths) => {
        const dir = paths[0]
        if (dir) installSkill(dir)
      })
  }

  const skill = skills?.skills[0]
  const outdatedTargets = skills?.targets.filter((target) => target.outdated) ?? []
  const installedAny = skills?.targets.some((target) => target.installed) ?? false
  /** 有旧版就变成「更新」，否则是「安装」 */
  const installLabel = outdatedTargets.length
    ? t('更新到 v{0}', skill?.version ?? '?')
    : installedAny
      ? t('重新安装 Skill')
      : t('安装到 CodeBuddy / Claude')
  const installedLabels =
    skills?.targets.filter((target) => target.installed).map((target) => target.label) ?? []
  /** 工程副本的实际行为（客户端已装同版本时默认只留 README，不再放副本） */
  const projectCopyLabel = !aiSkillInProject
    ? t('工程副本已关')
    : aiSkillAlwaysCopyProject
      ? t('工程副本：总是复制')
      : t('工程副本：同版本时跳过')
  /** 收起状态下用一行说清：随包版本 · 客户端装没装 · 工程副本行为 */
  const skillStatus = [
    skill?.version ? `v${skill.version}` : t('随包'),
    installedLabels.length ? t('已装 {0}', installedLabels.join(' / ')) : t('未装到客户端'),
    projectCopyLabel
  ].join(' · ')

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex h-auto max-h-[86vh] w-[520px] flex-col rounded-[6px] border border-line bg-ink-800 shadow-2xl"
        style={panelStyle}
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-line px-3" {...handleProps}>
          <span className="hao-panel-title">{t('AI 接入')}</span>
          <button
            type="button"
            // 标题栏的 `cursor: grab` 会被继承下来，按钮自己声明 pointer 盖掉它
            className="cursor-pointer text-content-lo hover:text-content-hi"
            title={t('关闭')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4">
          <p className="text-3xs leading-[16px] text-content-lo">
            {t('让 AI 工具把 Hao2DEditor 当成一个 MCP Server 自动加载：它启动后会在本机开一个只监听 127.0.0.1 的命令服务，AI 客户端填下面的地址即可读写当前工程。')}
          </p>

          <div className="flex flex-col gap-1">
            <span className="text-3xs text-content-mid">
              {t('命令服务：')}
              {info?.running ? (
                <span className="text-emerald-400">{t('运行中')}</span>
              ) : (
                <span className="text-amber-400">{t('未启动')}</span>
              )}
            </span>
            <span className="text-3xs text-content-lo">
              {info?.running
                ? t('把下面的 MCP 地址填进 AI 客户端，或点「一键安装」。')
                : t('请保持编辑器处于打开状态，命令服务随窗口启动。')}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-3xs text-content-mid">{t('MCP 地址（含访问 token）')}</span>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={info?.mcpUrl ?? ''}
                className="hao-field min-w-0 flex-1 truncate font-mono text-3xs"
                placeholder={t('命令服务未启动')}
              />
              <button
                type="button"
                className="hao-btn h-[24px] shrink-0 px-2 text-3xs"
                onClick={copy}
                disabled={!info?.mcpUrl}
                title={t('复制 MCP 地址')}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? t('已复制') : t('复制')}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="hao-btn hao-btn-accent h-[26px] self-start px-3 text-3xs"
            onClick={install}
            disabled={installing || !info?.running}
          >
            {installing ? t('安装中…') : t('一键安装到 AI 客户端')}
          </button>

          {report ? (
            <div className="flex flex-col gap-1 rounded-[4px] border border-line/60 px-2.5 py-2">
              <span className="text-3xs text-content-mid">{t('安装结果')}</span>
              {report.map((item) => (
                <div key={item.id} className="flex items-start gap-2 text-3xs leading-[15px]">
                  <span className="shrink-0 text-content-hi">{item.label}</span>
                  <span className="min-w-0 flex-1 text-content-lo">
                    {item.status === 'written' ? (
                      <span className="text-emerald-400">{t('已写入配置')}</span>
                    ) : item.status === 'error' ? (
                      <span className="text-danger/90">{t('失败：{0}', item.error ?? '')}</span>
                    ) : (
                      <span className="text-amber-400">
                        {t('需手动配置（{0}）', item.installed ? t('已检测到安装目录') : t('未检测到安装目录'))}
                      </span>
                    )}
                    {item.path ? <span className="block truncate font-mono text-content-lo/70">{item.path}</span> : null}
                  </span>
                </div>
              ))}
              <span className="text-3xs leading-[15px] text-content-lo/70">
                {t('标「需手动配置」的客户端（Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode）请把上面的 MCP 地址填进它们各自的 MCP 设置。')}
              </span>
            </div>
          ) : null}

          {/* ── 骨骼动画 Skill：默认两行（状态 + 按钮），细节收在「详情」里 ── */}
          <div className="flex flex-col gap-1.5 border-t border-line/60 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-3xs text-content-mid">
                {t('骨骼动画 Skill')}
                <span className="ml-1 font-mono text-content-lo/70">{skillStatus}</span>
              </span>
              <button
                type="button"
                className="hao-btn h-[22px] shrink-0 px-2 text-3xs"
                onClick={openSkillsDir}
                disabled={!skills?.exists}
                title={t('打开 Skill 目录')}
              >
                <FolderOpen size={12} />
                {t('打开目录')}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="hao-btn hao-btn-accent h-[24px] px-2 text-3xs"
                onClick={() => installSkill()}
                disabled={skillBusy || !skills?.exists}
              >
                {skillBusy ? t('安装中…') : installLabel}
              </button>
              <button
                type="button"
                className="hao-btn h-[24px] px-2 text-3xs"
                onClick={copyGuidance}
                disabled={!skills?.exists}
                title={t('复制给 AI 的一句话：让它自己去读 skill')}
              >
                {copiedGuidance ? <Check size={12} /> : <Copy size={12} />}
                {copiedGuidance ? t('已复制引导语') : t('复制引导语')}
              </button>
              <button
                type="button"
                className="hao-btn h-[24px] px-2 text-3xs"
                onClick={() => setShowSkillDetail((open) => !open)}
              >
                {showSkillDetail ? t('收起') : t('详情')}
              </button>
            </div>

            {showSkillDetail ? (
              <div className="flex flex-col gap-1.5 rounded-[4px] border border-line/60 px-2.5 py-2">
                <span className="text-3xs leading-[15px] text-content-lo">
                  {t('随编辑器带了一份「Hao2D 骨骼动画」Skill：写明坐标约定、搭骨架 / 打帧 / 蒙皮的步骤和导出方式。装进 AI 客户端的 skills 目录后，它就知道该怎么调用上面的命令。')}
                </span>

                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={skills?.exists ? (skills?.path ?? '') : t('未找到随包分发的 Skill 目录')}
                    className="hao-field min-w-0 flex-1 truncate font-mono text-3xs"
                    title={skills?.path}
                  />
                  <button
                    type="button"
                    className="hao-btn h-[24px] shrink-0 px-2 text-3xs"
                    onClick={copySkillPath}
                    disabled={!skills?.path}
                    title={t('复制路径')}
                  >
                    {copiedPath ? <Check size={12} /> : <Copy size={12} />}
                    {copiedPath ? t('已复制') : t('复制')}
                  </button>
                </div>

                {skills?.targets.length ? (
                  <div className="flex flex-col gap-[2px]">
                    {skills.targets.map((target) => (
                      <div key={target.id} className="flex items-center gap-2 text-3xs leading-[15px]">
                        <span className="w-[86px] shrink-0 truncate text-content-lo">{target.label}</span>
                        {!target.detected ? (
                          <span className="text-content-lo/50">{t('未检测到')}</span>
                        ) : target.outdated ? (
                          <span className="shrink-0 text-amber-400">
                            {t('可更新：v{0} → v{1}', [target.installedVersion ?? '?', skill?.version ?? '?'])}
                          </span>
                        ) : target.installed ? (
                          <span className="shrink-0 text-emerald-400">
                            {t('已装 v{0}', target.installedVersion ?? '?')}
                          </span>
                        ) : (
                          <span className="shrink-0 text-content-lo/60">{t('未安装')}</span>
                        )}
                        {target.detected ? (
                          <span className="min-w-0 flex-1 truncate font-mono text-content-lo/40" title={target.path}>
                            {target.path}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="hao-btn h-[22px] self-start px-2 text-3xs"
                  onClick={pickSkillDir}
                  disabled={skillBusy || !skills?.exists}
                >
                  {t('选择目录…')}
                </button>

                <label className="flex items-start gap-1.5 text-3xs leading-[15px] text-content-lo">
                  <input
                    type="checkbox"
                    className="mt-[2px]"
                    checked={aiSkillInProject}
                    onChange={(event) => setAiSkillInProject(event.target.checked)}
                  />
                  <span>
                    {t('保存工程时复制到 <工程>/ai/skills/（给 Codex 这类只读工作区的 AI 用）')}
                  </span>
                </label>

                {aiSkillInProject ? (
                  <label className="ml-4 flex items-start gap-1.5 text-3xs leading-[15px] text-content-lo">
                    <input
                      type="checkbox"
                      className="mt-[2px]"
                      checked={aiSkillAlwaysCopyProject}
                      onChange={(event) => setAiSkillAlwaysCopyProject(event.target.checked)}
                    />
                    <span>{t('客户端已装同版本时也复制（共享工程 / 换机器用）')}</span>
                  </label>
                ) : null}
              </div>
            ) : null}

            {skillError ? <span className="text-3xs text-danger/90">{skillError}</span> : null}

            {skillReport ? (
              <div className="flex flex-col gap-1 rounded-[4px] border border-line/60 px-2.5 py-2">
                <span className="text-3xs text-content-mid">{t('Skill 安装结果')}</span>
                {skillReport.map((item) => (
                  <div key={`${item.id}-${item.path ?? ''}`} className="flex items-start gap-2 text-3xs leading-[15px]">
                    <span className="shrink-0 text-content-hi">{item.label}</span>
                    <span className="min-w-0 flex-1 text-content-lo">
                      {item.status === 'written' ? (
                        <span className="text-emerald-400">{t('已安装')}</span>
                      ) : item.status === 'error' ? (
                        <span className="text-danger/90">{t('失败：{0}', item.error ?? '')}</span>
                      ) : item.detected ? (
                        <span className="text-amber-400">{t('需手动复制')}</span>
                      ) : (
                        <span className="text-content-lo/60">{t('未检测到该客户端')}</span>
                      )}
                      {item.path ? (
                        <span className="block truncate font-mono text-content-lo/70">{item.path}</span>
                      ) : null}
                      {item.copyCommand ? (
                        <button
                          type="button"
                          className="mt-1 block max-w-full truncate rounded-[3px] bg-black/20 px-1 py-[2px] text-left font-mono text-content-lo/80 hover:text-content-hi"
                          title={t('复制安装命令')}
                          onClick={() => copyText(item.copyCommand ?? '')}
                        >
                          {copiedCommand === item.copyCommand ? t('已复制命令') : item.copyCommand}
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
                <span className="text-3xs leading-[15px] text-content-lo/70">
                  {t('Codex / WorkBuddy / Trae 等若未识别到 Skills 目录，把上面的路径或命令交给它，或点「选择目录…」指定它读取技能的位置。')}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex h-[40px] shrink-0 items-center justify-end border-t border-line px-4">
          <button type="button" className="hao-btn h-[24px] px-3 text-3xs" onClick={onClose}>
            {t('完成')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
