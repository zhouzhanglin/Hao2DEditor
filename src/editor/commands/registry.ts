import type { EditorDocument } from '@core/model/authoring'
import type { CommandKind, CommandResponse, CommandSpec } from '@shared/commandTypes'
import { useProjectStore } from '../store/projectStore'
import { t } from '@i18n'

/**
 * 命令注册表：把「编辑器能做的每一件事」变成带名字、带参数描述、可序列化的调用。
 *
 * 三类命令的差别只有一个 —— **谁负责写 store**：
 *
 * - `defineRead`：只读。绝不动文档，因此也绝不会污染撤销栈。
 * - `defineWrite`：runner 在深拷贝草稿上原地改，成功后才写撤销记录。
 *   草稿里什么都没改就返回 `unchanged()`，整条命令作废（不留无效历史）。
 * - `defineAction`：复合动作（剪贴板、依赖视口数据的权重命令…）。它自己调 store，
 *   因为这类操作需要「读一次 → 算 → 写回去」多步，或依赖场景状态。
 *
 * 设计要点：**命令的语义只写在这里一遍**，UI 与 AI 走同一套；
 * 参数校验失败时抛异常 → 被 `executeCommand` 折成 `ok: false`，撤销栈保持干净。
 */

/** 命令的执行结果；`changed === false` = 这次调用没有改动文档 */
export interface CommandOutcome<T = unknown> {
  changed?: boolean
  data?: T
  /** 给调用方（AI / 状态栏）的一行人话说明 */
  message?: string
}

/** 声明「改成功了」 */
export function changed<T>(data?: T, message?: string): CommandOutcome<T> {
  return { changed: true, data, message }
}

/** 声明「什么都没改」：不写撤销记录、不替换文档 */
export function unchanged<T = never>(message?: string): CommandOutcome<T> {
  return { changed: false, data: undefined as T, message }
}

/** 命令实参：按名字传（`{"name":"arm"}`），不是位置参数 */
export type Args = Record<string, unknown>
// runner 可以是同步或 async：导入图片 / 自动网格 / 拆图集都要先写盘或解码像素，必须能 await
type Runner = (args: Args) => CommandOutcome | Promise<CommandOutcome>

interface Entry {
  spec: CommandSpec
  run: Runner
}

const table = new Map<string, Entry>()

export function registerCommand(spec: CommandSpec, run: Runner): void {
  if (table.has(spec.name)) throw new Error(t('命令重复注册：{0}', spec.name))
  table.set(spec.name, { spec, run })
}

/** 只读命令：不进历史、不改文档 */
export function defineRead(spec: Omit<CommandSpec, 'kind'>, run: (args: Args) => unknown): void {
  registerCommand({ ...spec, kind: 'read' }, (args) => ({ changed: false, data: run(args) }))
}

/**
 * 写命令：runner 在**深拷贝的草稿**上原地修改。
 *
 * 返回 `unchanged()` 时整条命令作废 —— AI 试错很频繁（传错名字、附件类型不对），
 * 每一次都写一条撤销记录会瞬间冲光 80 条的撤销栈，也会把工程标脏。
 */
export function defineWrite(
  spec: Omit<CommandSpec, 'kind'>,
  // 必须是同步的：runCommand 在深拷贝草稿上同步跑完再决定是否记账，async 会把提交时机打乱
  run: (draft: EditorDocument, args: Args) => CommandOutcome
): void {
  registerCommand({ ...spec, kind: 'write' }, (args) => {
    let outcome: CommandOutcome = {}
    const committed = useProjectStore.getState().runCommand(spec.title, (draft) => {
      outcome = run(draft, args) ?? {}
      return outcome.changed !== false
    })
    return committed ? outcome : { ...outcome, changed: false }
  })
}

/** 复合动作：自己负责 store 更新与场景刷新；默认按写命令记账 */
export function defineAction(spec: Omit<CommandSpec, 'kind'> & { kind?: CommandKind }, run: Runner): void {
  registerCommand({ ...spec, kind: spec.kind ?? 'write' }, run)
}

/** 命令目录（`GET /commands` 的返回体，按名字排序，AI 读一遍就知道能做什么） */
export function catalog(): CommandSpec[] {
  return [...table.values()].map((entry) => entry.spec).sort((a, b) => a.name.localeCompare(b.name))
}

/** 只注册了名字、还没跑到 bindAll 时也能安全查询 */
export function hasCommand(name: string): boolean {
  return table.has(name)
}

/** 测试用：清空注册表 */
export function clearRegistry(): void {
  table.clear()
}

/**
 * 执行一条命令。**不抛异常** —— 任何失败都折成 `{ ok: false, error }`，
 * 调用方（IPC / HTTP）只管转发。
 */
export async function executeCommand(name: string, args?: unknown): Promise<Omit<CommandResponse, 'id'>> {
  const entry = table.get(name)
  if (!entry) {
    const guess = nearestName(name)
    const hint = t('用 GET /commands 查全部命令名')
    return {
      ok: false,
      changed: false,
      error: guess
        ? t('没有这个命令：{0}（是不是想用 {1}？{2}）', [name, guess, hint])
        : t('没有这个命令：{0}（{1}）', [name, hint])
    }
  }
  try {
    // runner 可以是同步或 async（导入图片 / 自动网格 / 拆图集都要先写盘或解码像素，必须 await）
    const outcome = (await entry.run(asArgs(args))) ?? {}
    const didChange = outcome.changed === true
    return {
      ok: true,
      data: outcome.data,
      message: outcome.message,
      changed: didChange,
      // 只在真的改了东西时给出撤销标签：否则 AI 会以为「刚才那步可撤销」
      label: didChange && entry.spec.kind === 'write' ? entry.spec.title : undefined
    }
  } catch (err) {
    return { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 参数必须是对象：命令参数按名字传（`{"name":"arm"}`），不是位置参数 */
function asArgs(args: unknown): Args {
  if (args === null || args === undefined) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(t('args 必须是对象（按参数名传，例如 {"name":"arm"}）'))
  }
  return args as Args
}

/** 名字打错时给个候选：优先「包含关系」，其次最长公共前缀 */
function nearestName(input: string): string | null {
  const lower = input.toLowerCase()
  let best: string | null = null
  let bestScore = 0
  for (const name of table.keys()) {
    const candidate = name.toLowerCase()
    let score: number
    if (candidate.includes(lower)) score = lower.length + 2
    else if (lower.includes(candidate)) score = candidate.length + 1
    else {
      let common = 0
      while (common < candidate.length && common < lower.length && candidate[common] === lower[common]) common++
      score = common
    }
    if (score > bestScore) {
      bestScore = score
      best = name
    }
  }
  // 太短的前缀（1~2 个字符）没有参考价值，不如老实说「没这个命令」
  return bestScore >= 3 ? best : null
}
