/**
 * 命令系统契约：主进程的本地服务 ↔ 渲染进程的命令注册表。
 *
 * 命令的**执行**永远发生在渲染进程（文档状态只在那里），主进程只负责
 * 「收 HTTP / WebSocket 请求 → 转发给窗口 → 把结果原样送回去」。
 * 所以这个文件只放两件事：跨进程的消息形状，以及给 AI 看的命令自描述结构。
 */

/** 主 → 渲染：一条待执行的命令 */
export interface CommandRequest {
  id: number
  name: string
  args?: unknown
}

/** 渲染 → 主：命令的执行结果 */
export interface CommandResponse {
  id: number
  ok: boolean
  data?: unknown
  /** 成功提示（人话，AI 可以直接读给用户） */
  message?: string
  /** 失败原因（人话，尽量带上「下一步该怎么做」） */
  error?: string
  /** 是否真的改动了文档；false = 空操作，**没有产生撤销记录** */
  changed?: boolean
  /** 写命令产生的撤销标签：AI 据此确认「刚才那步是能撤销的」 */
  label?: string
}

/** read 只读文档、不进历史；write 会改文档并产生一条撤销记录 */
export type CommandKind = 'read' | 'write'

/**
 * 参数自描述。
 *
 * 这里没有用标准 JSON Schema：命令是手写的、参数含义比结构更重要，
 * 手写这个形状既好读又好维护，AI 读一遍 `GET /commands` 就能用。
 */
export interface CommandArgSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required?: boolean
  description: string
  /** 合法取值（有的话 AI 就不用猜，例如约束类型、刷权重模式） */
  values?: readonly string[]
  default?: unknown
}

/** 一条命令的自描述：`GET /commands` 把整个目录吐给 AI */
export interface CommandSpec {
  name: string
  title: string
  kind: CommandKind
  description: string
  args: Record<string, CommandArgSpec>
  /** `data` 字段的形状说明 */
  returns: string
}

/** 命令通道：两个方向各一个（主 → 渲染递命令，渲染 → 主回结果） */
export const COMMAND_CHANNEL = {
  request: 'hao2d:command:request',
  result: 'hao2d:command:result'
} as const

/**
 * 本地服务的握手信息，启动后写到 userData 目录下的文件里。
 *
 * AI 不需要预先知道端口：读这个文件就能拿到地址与 token（见 `commandServer.ts`）。
 */
export interface CommandServerInfo {
  port: number
  token: string
  /** 直接可用的基地址，如 http://127.0.0.1:5274 */
  url: string
  /** 握手文件自身的路径 */
  file: string
}
