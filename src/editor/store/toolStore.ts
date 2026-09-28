import { create } from 'zustand'

export type EditorTool = 'select' | 'bone' | 'slot' | 'mesh' | 'weight' | 'ffd' | 'constraint'

export type BrushMode = 'add' | 'subtract' | 'replace'

export interface OverlayState {
  bones: boolean
  mesh: boolean
  weight: boolean
  ffd: boolean
  constraints: boolean
}

export interface BrushState {
  radius: number
  strength: number
  mode: BrushMode
}

export interface ToolState {
  tool: EditorTool
  overlay: OverlayState
  brush: BrushState
  /** 网格创建的栅格细分数量（Region 转网格） */
  gridDivisions: number
  setTool: (tool: EditorTool) => void
  setOverlay: (overlay: OverlayState) => void
  toggleOverlay: (key: keyof OverlayState) => void
  setBrush: (brush: Partial<BrushState>) => void
  setGridDivisions: (value: number) => void
}

export const useToolStore = create<ToolState>((set, get) => ({
  tool: 'select',
  overlay: { bones: true, mesh: false, weight: false, ffd: false, constraints: true },
  brush: { radius: 40, strength: 0.5, mode: 'add' },
  gridDivisions: 4,

  setTool: (tool) => set({ tool }),
  setOverlay: (overlay) => set({ overlay }),
  toggleOverlay: (key) => set({ overlay: { ...get().overlay, [key]: !get().overlay[key] } }),
  setBrush: (brush) => set({ brush: { ...get().brush, ...brush } }),
  setGridDivisions: (value) => set({ gridDivisions: Math.max(1, Math.min(24, Math.round(value))) })
}))

export function currentTools(): ToolState {
  return useToolStore.getState()
}
