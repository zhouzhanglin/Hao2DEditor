import { t } from '@i18n'
import type { EditorScene } from '@editor/scene'
import type { AuthoringAnimData } from '@core/model/authoring'
import { lastKeyTime } from '@editor/timeline/model'
import { getPlatform, joinPath } from '@editor/platform'
import { useTimelineStore } from '@editor/store/timelineStore'
import { usePlayheadStore } from '@editor/store/playheadStore'
import type { ExportView } from '@render/exportCamera'

/**
 * 导出视频的编排层：算帧计划 → 逐帧（seek + 离屏渲染 + 推给 ffmpeg）→ 收尾恢复现场。
 *
 * 这里**不碰** UI，也不管 ffmpeg 怎么起（那是主进程的事），只负责：
 * - 「导哪些帧、每帧什么时间」—— 纯函数，可单测；
 * - 导出期间把场景切到导出模式、结束后把播放头 / 播放状态原样还回去；
 * - 出错 / 取消时把半成品删掉，不留下坏文件。
 */

export interface VideoExportOptions {
  animation: AuthoringAnimData
  animationName: string
  projectName: string
  /** 视频宽高（偶数，调用方已对齐） */
  width: number
  height: number
  /** 帧率：直接取工程帧率 */
  fps: number
  /** 背景色 `#RRGGBB`（不支持透明） */
  background: string
  view: ExportView
  /** 导出目录（成品写到 `目录/工程名_动画名.mp4`） */
  outDir: string
  /** H.264 CRF，默认 18 */
  crf?: number
}

export interface VideoExportHooks {
  /** 每帧回调（内部已节流到 ~10Hz，可以放心 setState） */
  onProgress?: (done: number, total: number) => void
  /** 返回 true 时尽快停下（面板上的「取消」） */
  isCancelled?: () => boolean
}

export interface VideoExportOutcome {
  ok: boolean
  cancelled: boolean
  /** 成功时的成品路径 */
  path: string
  /** 失败原因（成功 / 取消时为空串） */
  reason: string
}

/** 帧计划：整段动画按工程帧率切帧，**末帧时间强制落在最后一个关键帧** */
export interface FramePlan {
  total: number
  duration: number
  /** 每一帧的时间点（秒） */
  times: number[]
}

/**
 * 算帧计划。
 *
 * 时长口径 = 最后一个关键帧（与播放器一致，不留静止尾巴）；
 * 帧数 = round(时长 × 帧率)，至少 1 帧；第 i 帧时间 = i / fps，
 * 但**末帧固定取时长** —— 否则「时长 1.234s / 30fps」时最后一帧会落在 1.2s，
 * 末尾那点位移就被裁掉了。
 */
export function buildFramePlan(animation: AuthoringAnimData, fps: number): FramePlan {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30
  const duration = Math.max(0, lastKeyTime(animation))
  const total = Math.max(1, Math.round(duration * rate))
  const times: number[] = []
  for (let i = 0; i < total; i++) {
    times.push(i === total - 1 ? duration : i / rate)
  }
  return { total, duration, times }
}

/** 文件 / 目录名里不能出现的字符一律换成 `_`（跨平台保守处理） */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'animation'
}

/** `#RRGGBB` → 0xRRGGBB（给 pixi 的 clearColor 用）；非法值退回白色 */
export function hexToColorInt(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return 0xffffff
  return Number.parseInt(match[1], 16)
}

/**
 * 生成不冲突的输出路径：`工程名_动画名.mp4`，已存在就依次加 `_2`、`_3`…
 * （导出面板不关闭，同名动画连导两次也不会互相覆盖）
 */
export async function resolveOutputPath(
  outDir: string,
  projectName: string,
  animationName: string
): Promise<string> {
  const platform = getPlatform()
  const base = `${sanitizeFileName(projectName)}_${sanitizeFileName(animationName)}`
  let candidate = joinPath(outDir, `${base}.mp4`)
  let index = 2
  // 上限只是防御：同名文件不可能有上千个
  while (index < 1000) {
    if (!(await platform.exists(candidate))) break
    candidate = joinPath(outDir, `${base}_${index}.mp4`)
    index++
  }
  return candidate
}

/** 秒 → `1.33s` 这种展示用短文本 */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`
}

/**
 * 真正干活：导出**一个**动画。
 *
 * 全程在渲染进程跑循环，主进程只负责编码。任何一步失败都会：
 * 1. 取消会话（杀掉 ffmpeg + 删半成品）；
 * 2. 把场景恢复成导出前的样子（时间 / 播放状态 / 渲染循环）。
 */
export async function exportAnimationVideo(
  scene: EditorScene,
  options: VideoExportOptions,
  hooks: VideoExportHooks = {}
): Promise<VideoExportOutcome> {
  const platform = getPlatform()
  const plan = buildFramePlan(options.animation, options.fps)
  const timeline = useTimelineStore.getState()
  const savedTime = timeline.time
  const savedPlaying = timeline.playing

  const outputPath = await resolveOutputPath(options.outDir, options.projectName, options.animationName)
  const started = await platform.startVideoExport({
    outputPath,
    width: options.width,
    height: options.height,
    fps: options.fps,
    crf: options.crf
  })
  if (!started.ok) {
    return { ok: false, cancelled: false, path: '', reason: started.error }
  }
  const sessionId = started.data.sessionId

  // 导出期间停掉播放：rAF 里不再推进时间，画面只跟着导出 seek 走
  timeline.setPlaying(false)
  scene.setExportMode(true)
  const background = hexToColorInt(options.background)
  let done = 0
  let lastReport = 0

  try {
    for (let i = 0; i < plan.total; i++) {
      if (hooks.isCancelled?.() === true) {
        await platform.cancelVideoExport(sessionId)
        return { ok: false, cancelled: true, path: '', reason: '' }
      }
      const frame = scene.captureFrame({
        time: plan.times[i],
        width: options.width,
        height: options.height,
        background,
        view: options.view
      })
      if (!frame) {
        await platform.cancelVideoExport(sessionId)
        return { ok: false, cancelled: false, path: '', reason: t('视口还没就绪：等编辑器画完一帧再导出') }
      }
      const pushed = await platform.pushVideoFrame(sessionId, frame)
      if (!pushed.ok) {
        await platform.cancelVideoExport(sessionId)
        return { ok: false, cancelled: false, path: '', reason: pushed.error }
      }
      done++
      // 进度节流：每帧 setState 会把面板拖到 2fps，100ms 一次足够看出进度
      const now = performance.now()
      if (now - lastReport > 100 || done === plan.total) {
        lastReport = now
        hooks.onProgress?.(done, plan.total)
      }
      // 让出主线程：否则整段导出期间面板完全无响应（进度条不动、取消点不到）
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }

    const finished = await platform.finishVideoExport(sessionId)
    if (!finished.ok) return { ok: false, cancelled: false, path: '', reason: finished.error }
    return { ok: true, cancelled: false, path: finished.data.path, reason: '' }
  } finally {
    scene.setExportMode(false)
    // 现场还原：播放头回到导出前的位置，播放状态也还回去
    timeline.setTime(savedTime)
    usePlayheadStore.getState().setTime(savedTime)
    if (savedPlaying) timeline.setPlaying(true)
  }
}
