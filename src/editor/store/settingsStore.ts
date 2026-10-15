import { create } from 'zustand'
import { DEFAULT_BONE_STYLE, normalizeBoneHex } from '@render/overlays/boneStyle'
import type { BoneOverlayStyle } from '@render/overlays/boneStyle'

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
  /** 骨骼叠加层样式（视口里骨骼的长相，默认值 = 加设置之前用的那一档） */
  boneStyle: BoneOverlayStyle
}

const DEFAULT_SETTINGS: GlobalSettings = {
  spineAtlasTxt: false,
  boneStyle: { ...DEFAULT_BONE_STYLE }
}

function loadSettings(): GlobalSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS, boneStyle: { ...DEFAULT_BONE_STYLE } }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS, boneStyle: { ...DEFAULT_BONE_STYLE } }
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>
    // `boneStyle` 是**嵌套对象**：老版本存档里没有它（或只有其中几项），
    // 直接展开会把缺失的字段留成 undefined，于是叠加层拿到 NaN 透明度 / NaN 半径。
    // 所以它要逐字段与默认值合并，其余顶层字段维持原来的整体展开。
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      boneStyle: sanitizeBoneStyle({ ...DEFAULT_BONE_STYLE, ...parsed.boneStyle })
    }
  } catch {
    return { ...DEFAULT_SETTINGS, boneStyle: { ...DEFAULT_BONE_STYLE } }
  }
}

/**
 * 把外部数据（localStorage / 设置面板）里的骨骼样式夹到合法范围。
 *
 * 颜色校验交给绘制时的 `boneStyleColor`（坏值退回白色，不会让骨骼消失）；
 * 这里只兜数值：负数半径 / 超过 100 的百分比 / NaN 都会让骨骼画成乱码甚至不画。
 */
function sanitizeBoneStyle(style: BoneOverlayStyle): BoneOverlayStyle {
  const num = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback)
  return {
    ...style,
    widthPercent: Math.min(60, Math.max(0.5, num(style.widthPercent, DEFAULT_BONE_STYLE.widthPercent))),
    jointRadius: Math.min(40, Math.max(2, num(style.jointRadius, DEFAULT_BONE_STYLE.jointRadius))),
    fillAlpha: Math.min(1, Math.max(0, num(style.fillAlpha, DEFAULT_BONE_STYLE.fillAlpha))),
    strokeAlpha: Math.min(1, Math.max(0, num(style.strokeAlpha, DEFAULT_BONE_STYLE.strokeAlpha))),
    fillColor: normalizeBoneHex(style.fillColor, DEFAULT_BONE_STYLE.fillColor),
    strokeColor: normalizeBoneHex(style.strokeColor, DEFAULT_BONE_STYLE.strokeColor),
    selectedColor: normalizeBoneHex(style.selectedColor, DEFAULT_BONE_STYLE.selectedColor)
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
  /** 改骨骼样式：传部分字段即可，其余保持现值 */
  setBoneStyle: (patch: Partial<BoneOverlayStyle>) => void
  /** 骨骼样式恢复默认 */
  resetBoneStyle: () => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...loadSettings(),
  setSpineAtlasTxt: (value) => {
    set({ spineAtlasTxt: value })
    saveSettings({ ...get(), spineAtlasTxt: value })
  },
  setBoneStyle: (patch) => {
    const boneStyle = sanitizeBoneStyle({ ...get().boneStyle, ...patch })
    set({ boneStyle })
    saveSettings({ ...get(), boneStyle })
  },
  resetBoneStyle: () => {
    const boneStyle = { ...DEFAULT_BONE_STYLE }
    set({ boneStyle })
    saveSettings({ ...get(), boneStyle })
  }
}))
