import { describe, expect, it } from 'vitest'
import type { AuthoringAnimData } from '@core/model/authoring'
import {
  buildFramePlan,
  formatSeconds,
  hexToColorInt,
  sanitizeFileName
} from '@editor/services/videoExport'
import {
  EXPORT_ZOOM_MAX,
  EXPORT_ZOOM_MIN,
  type ExportView,
  clampExportZoom,
  fitExportView,
  panViewByPixels,
  viewOffset,
  videoToWorld,
  withViewOffset,
  worldToVideo,
  zoomViewAtPixel
} from '@render/exportCamera'

/** 只有一条骨骼位移轨的动画（`lastKeyTime` 只看关键帧时间） */
function animationEndingAt(seconds: number): AuthoringAnimData {
  const frame = { time: seconds, x: 0, y: 0, easing: 'linear', curve: null }
  return {
    name: 'walk',
    duration: seconds,
    bones: [{ bone: 'root', parent: '', translate: [frame], rotate: [], scale: [], shear: [] }],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    constraints: []
  } as unknown as AuthoringAnimData
}

describe('导出视频：帧计划', () => {
  it('按工程帧率切帧，末帧时间落在最后一个关键帧上', () => {
    const plan = buildFramePlan(animationEndingAt(1.2), 30)
    expect(plan.duration).toBeCloseTo(1.2, 6)
    expect(plan.total).toBe(36)
    expect(plan.times[0]).toBe(0)
    expect(plan.times[1]).toBeCloseTo(1 / 30, 6)
    // 1.2 × 30 = 36 帧，第 i 帧 = i/30；末帧强制取时长（这里恰好相等）
    expect(plan.times[35]).toBeCloseTo(1.2, 6)
  })

  it('时长不能被帧率整除时，末帧仍然包含最后一个关键帧', () => {
    const plan = buildFramePlan(animationEndingAt(1.234), 30)
    expect(plan.total).toBe(37)
    expect(plan.times[36]).toBeCloseTo(1.234, 6)
    expect(plan.times[35]).toBeCloseTo(35 / 30, 6)
  })

  it('没有关键帧也至少出 1 帧；帧率非法时退回 30', () => {
    const plan = buildFramePlan(animationEndingAt(0), Number.NaN)
    expect(plan.total).toBe(1)
    expect(plan.times).toEqual([0])
  })
})

describe('导出视频：文件名与颜色', () => {
  it('非法字符替换成下划线，中文保留', () => {
    expect(sanitizeFileName('角色/走路:v2*?')).toBe('角色_走路_v2__')
    expect(sanitizeFileName('   ')).toBe('animation')
  })

  it('#RRGGBB 解析成 pixi 用的颜色整数；非法值退回白色', () => {
    expect(hexToColorInt('#FF8800')).toBe(0xff8800)
    expect(hexToColorInt('1a1a1c')).toBe(0x1a1a1c)
    expect(hexToColorInt('nope')).toBe(0xffffff)
  })

  it('时长展示保留两位小数', () => {
    expect(formatSeconds(1.2345)).toBe('1.23s')
  })
})

describe('导出视频：取景相机', () => {
  const view: ExportView = { zoom: 100, centerX: 2, centerY: -1 }

  it('世界 → 画面 → 世界 可逆', () => {
    const screen = worldToVideo(view, 1920, 1080, 3.5, 0.25)
    const back = videoToWorld(view, 1920, 1080, screen.x, screen.y)
    expect(back.x).toBeCloseTo(3.5, 6)
    expect(back.y).toBeCloseTo(0.25, 6)
  })

  it('画面中心对应的就是取景中心', () => {
    const center = worldToVideo(view, 1920, 1080, view.centerX, view.centerY)
    expect(center.x).toBeCloseTo(960, 6)
    expect(center.y).toBeCloseTo(540, 6)
  })

  it('按内容适配：居中 + 长边贴合（留 fill 比例）', () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 5 }
    const fit = fitExportView(bounds, 1000, 1000, 0.8)
    expect(fit.centerX).toBeCloseTo(5, 6)
    expect(fit.centerY).toBeCloseTo(2.5, 6)
    // 宽 10 世界单位 → 800px 可用：zoom = 80
    expect(fit.zoom).toBeCloseTo(80, 6)
  })

  it('缩放被限制在 5% ~ 800%', () => {
    expect(clampExportZoom(0)).toBe(EXPORT_ZOOM_MIN)
    expect(clampExportZoom(100000)).toBe(EXPORT_ZOOM_MAX)
    expect(clampExportZoom(120)).toBe(120)
  })

  it('拖动平移：屏幕右移 = 内容右移（取景中心左移）', () => {
    const panned = panViewByPixels(view, 100, -50)
    expect(panned.centerX).toBeCloseTo(2 - 1, 6)
    expect(panned.centerY).toBeCloseTo(-1 - 0.5, 6)
  })

  it('以光标为锚缩放：光标下的世界坐标不变', () => {
    const zoomed = zoomViewAtPixel(view, 1920, 1080, 1200, 300, 1.5)
    const before = videoToWorld(view, 1920, 1080, 1200, 300)
    const after = videoToWorld(zoomed, 1920, 1080, 1200, 300)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    expect(zoomed.zoom).toBeCloseTo(150, 6)
  })

  it('偏移量按内容中心算，写回后取景与数值一致', () => {
    const bounds = { minX: -4, minY: -2, maxX: 4, maxY: 2 }
    const offset = viewOffset(view, bounds)
    expect(offset).toEqual({ x: 2, y: -1 })
    const restored = withViewOffset(view, bounds, 2, -1)
    expect(restored.centerX).toBeCloseTo(view.centerX, 6)
    expect(restored.centerY).toBeCloseTo(view.centerY, 6)
  })
})
