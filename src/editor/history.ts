import type { EditorDocument } from '@core/model/authoring'

export interface HistoryEntry {
  label: string
  document: EditorDocument
}

function clone(doc: EditorDocument): EditorDocument {
  if (typeof structuredClone === 'function') return structuredClone(doc)
  return JSON.parse(JSON.stringify(doc)) as EditorDocument
}

/**
 * 撤销 / 重做栈。
 *
 * 采用「编辑前快照 + 容量上限」策略：工程文档是纯数据（数组 / 对象 / 字符串），
 * 快照比 patch 更简单可靠，且不会因漏记字段导致撤销后状态不一致。
 * 拖拽等连续操作通过 `begin` / `end` 合并成单条记录。
 */
export class History {
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private pending: HistoryEntry | null = null

  constructor(private readonly limit = 80) {}

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.length > 0 ? this.past[this.past.length - 1].label : null
  }

  get redoLabel(): string | null {
    return this.future.length > 0 ? this.future[this.future.length - 1].label : null
  }

  /** 记一条编辑记录（传入**修改前**的文档） */
  push(label: string, before: EditorDocument): void {
    this.past.push({ label, document: clone(before) })
    if (this.past.length > this.limit) this.past.shift()
    this.future.length = 0
  }

  /** 连续操作的起点（拖拽开始）；重复调用只保留第一次 */
  begin(label: string, before: EditorDocument): void {
    if (this.pending) return
    this.pending = { label, document: clone(before) }
  }

  /** 连续操作的终点（拖拽结束）；把整段操作合并成一条记录 */
  end(): void {
    if (!this.pending) return
    this.push(this.pending.label, this.pending.document)
    this.pending = null
  }

  cancelPending(): void {
    this.pending = null
  }

  undo(current: EditorDocument): EditorDocument | null {
    const entry = this.past.pop()
    if (!entry) return null
    this.future.push({ label: entry.label, document: clone(current) })
    return entry.document
  }

  redo(current: EditorDocument): EditorDocument | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push({ label: entry.label, document: clone(current) })
    return entry.document
  }

  clear(): void {
    this.past.length = 0
    this.future.length = 0
    this.pending = null
  }

  get depth(): number {
    return this.past.length
  }
}
