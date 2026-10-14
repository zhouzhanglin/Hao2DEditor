import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import type { CommandServerInfo } from '@shared/commandTypes'
import type { McpClientResult } from '@shared/ipcTypes'

/**
 * 「一键安装 AI 集成」：把 Hao2DEditor 的 MCP URL 写进已识别的 AI 客户端配置，
 * 这样客户端下次启动时就能自动加载编辑器全部命令，无需手动粘贴。
 *
 * 两类客户端：
 * - **auto（已知 schema，安全自动写）**：Claude Desktop、Cursor、VSCode。按各自既定结构合并写入。
 * - **manual（schema 未公开）**：Codex / WorkBuddy / CodeBuddy / DeepSeek Harness / Trae / ZCode。
 *   它们的 MCP 配置格式各异甚至尚未支持，不冒然改写其配置（避免写坏），只检测是否安装、
 *   把 URL 交给用户手动填。这也是「支持就写、不支持给 URL 退路」的落地方式。
 */

const isWin = process.platform === 'win32'
const home = (): string => homedir()

interface ClientSpec {
  id: string
  label: string
  /** 配置文件（auto）或安装目录（manual）的绝对路径 */
  path: () => string
  /** 是否已知 schema、可安全自动写入 */
  auto: boolean
  /** auto 客户端：把 mcpUrl 合并进现有配置（不覆盖其它条目） */
  merge?: (config: Record<string, unknown>, mcpUrl: string) => Record<string, unknown>
}

const clients: ClientSpec[] = [
  {
    id: 'claude',
    label: 'Claude Desktop',
    auto: true,
    path: () =>
      isWin
        ? join(home(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
        : join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    merge: (config, mcpUrl) => ({
      ...config,
      mcpServers: { ...(config.mcpServers as object | undefined), 'hao2d-editor': { url: mcpUrl } }
    })
  },
  {
    id: 'cursor',
    label: 'Cursor',
    auto: true,
    path: () => join(home(), '.cursor', 'mcp.json'),
    merge: (config, mcpUrl) => ({
      ...config,
      mcpServers: { ...(config.mcpServers as object | undefined), 'hao2d-editor': { url: mcpUrl } }
    })
  },
  {
    id: 'vscode',
    label: 'VSCode / Copilot',
    auto: true,
    path: () =>
      isWin
        ? join(home(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json')
        : join(home(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    merge: (config, mcpUrl) => ({
      ...config,
      mcp: {
        ...(config.mcp as object | undefined),
        servers: {
          ...((config.mcp as { servers?: object } | undefined)?.servers),
          'hao2d-editor': { type: 'http', url: mcpUrl }
        }
      }
    })
  },
  // 以下客户端 MCP 配置未公开 / 各异：只探测安装目录，不自动写
  { id: 'codex', label: 'Codex', auto: false, path: () => join(home(), '.codex') },
  { id: 'workbuddy', label: 'WorkBuddy', auto: false, path: () => join(home(), '.workbuddy') },
  { id: 'codebuddy', label: 'CodeBuddy', auto: false, path: () => join(home(), '.codebuddy') },
  { id: 'deepseek', label: 'DeepSeek Harness', auto: false, path: () => join(home(), '.deepseek') },
  { id: 'trae', label: 'Trae', auto: false, path: () => join(home(), '.trae') },
  { id: 'zcode', label: 'ZCode', auto: false, path: () => join(home(), '.zcode') }
]

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 把 MCP URL 安装到已识别的 AI 客户端。
 * 返回逐项报告：auto 客户端写入结果、manual 客户端是否检测到安装目录。
 */
export async function installMcpIntoClients(info: CommandServerInfo | null): Promise<{
  running: boolean
  mcpUrl: string
  items: McpClientResult[]
}> {
  if (!info) {
    return { running: false, mcpUrl: '', items: [] }
  }
  const mcpUrl = `${info.url}/mcp?token=${info.token}`
  const items: McpClientResult[] = []

  for (const client of clients) {
    if (!client.auto || !client.merge) {
      const installed = await exists(client.path())
      items.push({ id: client.id, label: client.label, status: 'manual', installed })
      continue
    }
    try {
      const configPath = client.path()
      let config: Record<string, unknown> = {}
      try {
        const raw = await readFile(configPath, 'utf8')
        config = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // 配置文件不存在或损坏：从空对象开始，下面 merge 会建出正确的结构
      }
      const next = client.merge(config, mcpUrl)
      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      items.push({ id: client.id, label: client.label, status: 'written', path: configPath })
    } catch (err) {
      items.push({
        id: client.id,
        label: client.label,
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return { running: true, mcpUrl, items }
}
