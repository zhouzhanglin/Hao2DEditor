import { describe, expect, it } from 'vitest'
import { renderQualityProfile, useSettingsStore } from '@editor/store/settingsStore'
import type { RenderQuality } from '@editor/store/settingsStore'

/** 视口「渲染质量」档位：默认值与参数必须固定，否则设置弹窗、渲染循环两处会各说各话 */
describe('渲染质量', () => {
  it('默认高清：最多 2× 像素，不额外封帧', () => {
    expect(useSettingsStore.getState().renderQuality).toBe('high')
    expect(renderQualityProfile('high')).toEqual({ maxDevicePixelRatio: 2, maxFps: null })
  })

  it('均衡 = 固定 1× 且不封帧；省电 = 固定 1× 且 60fps 上限', () => {
    expect(renderQualityProfile('balanced')).toEqual({ maxDevicePixelRatio: 1, maxFps: null })
    expect(renderQualityProfile('power')).toEqual({ maxDevicePixelRatio: 1, maxFps: 60 })
  })

  it('写入档位后可读回；坏值兜底回高清', () => {
    const store = useSettingsStore.getState()
    try {
      store.setRenderQuality('power')
      expect(useSettingsStore.getState().renderQuality).toBe('power')
      store.setRenderQuality('ultra' as RenderQuality)
      expect(useSettingsStore.getState().renderQuality).toBe('high')
    } finally {
      useSettingsStore.getState().setRenderQuality('high')
    }
  })
})
