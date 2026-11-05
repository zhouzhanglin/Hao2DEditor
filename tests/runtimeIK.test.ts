import { describe, expect, it } from 'vitest'
import { importSpine } from '@importers/spine'
import { buildSpineJson } from '@editor/services/spineExport'
import { serializeRuntimeAtlas, parseRuntimeSke, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import { loadRuntime } from '@core/runtime/loader'

/**
 * 从 Spine 导入且动画已经烘焙（atlasText 交给官方 runtime bake）时，`runtimeIK` 是 false：
 * 约束效果已经写进骨骼轨道，运行期一条都不再解。
 *
 * 这里锁住两点，否则就会出现「编辑器正确、预览错位」：
 * - 运行时 ske 必须把这个开关带过去（旧版 loader 硬编码 true，预览会二次求解 IK/path/transform）；
 * - Spine 导出不能把已经烘焙的约束再写回去（官方运行时会二次求解，spine 预览同样错）。
 */
const IK_SOURCE = {
  skeleton: { spine: '4.2.0', fps: 30 },
  bones: [
    { name: 'root' },
    { name: 'thigh', parent: 'root', length: 20 },
    { name: 'shin', parent: 'thigh', length: 20, x: 20 },
    { name: 'target', parent: 'root', x: 30, y: 0 }
  ],
  slots: [],
  skins: [{ name: 'default', attachments: {} }],
  ik: [{ name: 'leg', bones: ['thigh', 'shin'], target: 'target', bendPositive: true }],
  animations: {
    idle: {
      ik: { leg: [{ time: 0, mix: 0 }] }
    }
  }
}

function imported() {
  return importSpine({ json: IK_SOURCE as never, regions: [], pageSizes: {} }).asset
}

describe('runtimeIK：已烘焙约束的运行期开关', () => {
  it('运行时 ske 往返保留 runtimeIK=false', () => {
    const asset = imported()
    asset.runtimeIK = false
    const skeText = serializeRuntimeSke(asset, { atlasFileName: 'a.json' })
    expect(parseRuntimeSke(skeText).runtimeIK).toBe(false)

    const atlasText = serializeRuntimeAtlas({ format: 'hao2d-atlas', version: 1, pages: [], regions: [] })
    const loaded = loadRuntime(skeText, atlasText).asset
    expect(loaded.runtimeIK).toBe(false)
  })

  it('runtimeIK=false 时 Spine 导出不再带约束（含约束时间轴），骨骼轨道照常保留', () => {
    const asset = imported()
    asset.runtimeIK = false
    const json = buildSpineJson(asset)
    expect(json.constraints ?? []).toHaveLength(0)
    expect(Object.keys(json.animations?.idle?.ik ?? {})).toHaveLength(0)
  })

  it('runtimeIK=true（默认）时仍然导出约束与时间轴', () => {
    const asset = imported()
    expect(asset.runtimeIK).toBe(true)
    const json = buildSpineJson(asset)
    expect(json.constraints?.some((c) => c.type === 'ik')).toBe(true)
    expect(Object.keys(json.animations?.idle?.ik ?? {})).not.toHaveLength(0)
  })
})
