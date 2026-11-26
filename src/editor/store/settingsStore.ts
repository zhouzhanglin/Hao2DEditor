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

/**
 * 视口渲染质量（不改文档、不影响导出，只决定画布像素密度与帧率上限）。
 *
 * - `high`：Retina 上最多 2× 像素，保持 rAF 原速（默认，观感最好，GPU 占用也最高）；
 * - `balanced`：固定 1× 像素，帧率不封顶；
 * - `power`：固定 1× 像素且最多 60fps，用于高刷屏上省电 / 降 GPU。
 *
 * 抗锯齿（MSAA）是 WebGL 上下文创建时的属性，运行中改不了，因此三档都沿用初始化时的
 * `antialias: true`；主要收益来自 backing store 像素数与刷新频率。
 */
export type RenderQuality = 'high' | 'balanced' | 'power'

export interface RenderQualityProfile {
  /** 渲染分辨率上限：`resolution = min(maxDevicePixelRatio, devicePixelRatio)` */
  maxDevicePixelRatio: number
  /** 帧率上限；`null` = 不额外限制（跟随屏幕刷新） */
  maxFps: number | null
}

/** 渲染质量档位 → 具体参数（纯函数，测试与视口共用同一份口径） */
export function renderQualityProfile(quality: RenderQuality): RenderQualityProfile {
  switch (quality) {
    case 'balanced':
      return { maxDevicePixelRatio: 1, maxFps: null }
    case 'power':
      return { maxDevicePixelRatio: 1, maxFps: 60 }
    case 'high':
    default:
      return { maxDevicePixelRatio: 2, maxFps: null }
  }
}

/** localStorage / 老存档里的坏值兜底：未知档位一律回默认「高」 */
function sanitizeRenderQuality(value: unknown): RenderQuality {
  return value === 'high' || value === 'balanced' || value === 'power' ? value : 'high'
}

/** 全局设置字段（以后加新选项直接往这里加） */
export interface GlobalSettings {
  /** Spine 导出时图集文件名追加 `.txt`（`xxx.atlas.txt`）；Spine 编辑器导出的形态，spine-unity 也认 */
  spineAtlasTxt: boolean
  /** 骨骼叠加层样式（视口里骨骼的长相，默认值见 `DEFAULT_BONE_STYLE`） */
  boneStyle: BoneOverlayStyle
  /**
   * 保存 / 打开工程时，把随包 AI Skill 复制到 `<工程>/ai/skills/`。
   *
   * 给「工作区型」AI（Codex 这类在工程目录里干活的）用：打开文件夹就能看到手册，
   * 不必配 MCP、也不必自己去用户目录找。默认开；嫌工程目录里多文件可在 AI 接入面板关掉。
   */
  aiSkillInProject: boolean
  /**
   * 客户端已经装了**同版本**的 Skill 时，工程里还要不要留副本。
   *
   * 默认 `false`——客户端会自动加载它，工程里再放一份就是同一份手册读两遍：
   * 白占上下文，版本不一致时还会互相冲突。此时工程里只写一个 `ai/skills/README.md` 指路。
   * 需要把工程共享给没装 Skill 的同事、或要换机器时，再在这里打开。
   */
  aiSkillAlwaysCopyProject: boolean
  /** 视口渲染质量（默认 `high`；见 `renderQualityProfile`） */
  renderQuality: RenderQuality
}

const DEFAULT_SETTINGS: GlobalSettings = {
  spineAtlasTxt: false,
  boneStyle: { ...DEFAULT_BONE_STYLE },
  aiSkillInProject: true,
  aiSkillAlwaysCopyProject: false,
  renderQuality: 'high'
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
      boneStyle: sanitizeBoneStyle({ ...DEFAULT_BONE_STYLE, ...parsed.boneStyle }),
      // 顶层字段也别信手改的 localStorage：档位不认识就退回默认「高」
      renderQuality: sanitizeRenderQuality(parsed.renderQuality)
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
  /** 是否把随包 AI Skill 复制进工程 ai/skills/ */
  setAiSkillInProject: (value: boolean) => void
  /** 客户端已装同版本时，是否仍然复制到工程 */
  setAiSkillAlwaysCopyProject: (value: boolean) => void
  /** 视口渲染质量（即时生效，跨工程保留） */
  setRenderQuality: (value: RenderQuality) => void
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
  },
  setAiSkillInProject: (value) => {
    set({ aiSkillInProject: value })
    saveSettings({ ...get(), aiSkillInProject: value })
  },
  setAiSkillAlwaysCopyProject: (value) => {
    set({ aiSkillAlwaysCopyProject: value })
    saveSettings({ ...get(), aiSkillAlwaysCopyProject: value })
  },
  setRenderQuality: (value) => {
    const renderQuality = sanitizeRenderQuality(value)
    set({ renderQuality })
    saveSettings({ ...get(), renderQuality })
  }
}))
