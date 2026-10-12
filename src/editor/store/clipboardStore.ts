import { create } from 'zustand'
import type { AuthoringAttachment, AuthoringBone, AuthoringSlot } from '@core/model/authoring'
import type { PasteKeyEntry } from '../timeline/model'

/**
 * 内存剪贴板：复制的节点（骨骼 / 插槽）与关键帧都存深拷贝，避免与工程文档共享引用。
 *
 * 名字引用模型下，跨工程 / 跨骨架粘贴会有重名冲突，所以这里只做内存暂存、
 * 不写 OS 剪贴板（序列化成文本反而要处理名字冲突与图片引用）。
 */
export interface ClipboardNodeData {
  bones: AuthoringBone[]
  slots: AuthoringSlot[]
  /** 每个被复制插槽在各皮肤里的附件（粘贴时用于重建 skin 条目） */
  skinSlots: Array<{ slot: string; attachments: AuthoringAttachment[] }>
}

export interface ClipboardKeyData {
  /** 来源动画名（仅作记录，粘贴时按「当前动画」写入，按骨骼 / 插槽名匹配目标） */
  animation: string
  entries: PasteKeyEntry[]
}

export type ClipboardContent =
  | { kind: 'nodes'; data: ClipboardNodeData }
  | { kind: 'keyframes'; data: ClipboardKeyData }
  | null

interface ClipboardState {
  content: ClipboardContent
  setContent: (content: ClipboardContent) => void
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  content: null,
  setContent: (content) => set({ content })
}))
