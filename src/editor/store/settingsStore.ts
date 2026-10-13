import { create } from 'zustand'

/**
 * 软件级全局设置（与具体工程无关，跨「新建 / 打开 / 导入」一直保留）。
 *
 * 持久化走 localStorage（`hao2d:settings`），不写进工程文件 —— 这样换工程、导入别的资源
 * 都不会把设置冲掉，符合「勾选后以后所有导出都沿用」的预期。
 */
const SETTINGS_KEY = 'hao2d:settings'

/** 全局设置字段（以后加新选项直接往这里加） */
export interface GlobalSettings {
  /** Spine 导出时图集文件名追加 `.txt`（`xxx.atlas.txt`）；Spine 编辑器导出的形态，spine-unity 也认 */
  spineAtlasTxt: boolean
}

const DEFAULT_SETTINGS: GlobalSettings = {
  spineAtlasTxt: false
}

function loadSettings(): GlobalSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(settings: GlobalSettings): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式 / 配额满：忽略，下次启动回退到默认即可
  }
}

export interface SettingsStore extends GlobalSettings {
  setSpineAtlasTxt: (value: boolean) => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...loadSettings(),
  setSpineAtlasTxt: (value) => {
    set({ spineAtlasTxt: value })
    saveSettings({ ...get(), spineAtlasTxt: value })
  }
}))
