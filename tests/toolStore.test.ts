import { beforeEach, describe, expect, it } from 'vitest'
import { isDrawTool, useToolStore } from '@editor/store/toolStore'

/**
 * 变换工具（视口左侧那排 移动/旋转/缩放/斜切）与编辑工具的联动。
 *
 * 起因是一次实测：Pose 工具下点「缩放」，上面的工具自动跳回了「选择」——
 * 每换一种变换方式都要重新点一次 Pose 工具。
 */
beforeEach(() => {
  // 显示层 / 可选层也要复位：切工具已经不动它们了，但用例之间仍不该互相影响
  useToolStore.setState({
    tool: 'select',
    gizmo: 'move',
    overlay: { display: true, bones: true, constraints: true },
    selectable: { display: true, bones: true, constraints: true },
    pendingWeightBone: null
  })
})

describe('切换变换工具（gizmo）时的编辑工具', () => {
  it('Pose / 选择 / 画骨骼：只换变换方式，工具本身不动', () => {
    for (const tool of ['pose', 'select', 'bone'] as const) {
      useToolStore.getState().setTool(tool)
      for (const gizmo of ['rotate', 'scale', 'shear', 'move'] as const) {
        useToolStore.getState().setGizmo(gizmo)
        expect(useToolStore.getState().tool).toBe(tool)
        expect(useToolStore.getState().gizmo).toBe(gizmo)
      }
    }
  })

  it('绘制类工具（权重刷 / 顶点）：仍然被顶掉成选择工具，免得「点了旋转却在刷权重」', () => {
    for (const tool of ['weight', 'ffd'] as const) {
      useToolStore.getState().setTool(tool)
      useToolStore.getState().setGizmo('scale')
      expect(useToolStore.getState().tool).toBe('select')
    }
  })

  it('Pose 工具拖顶点时也一样：切 gizmo 不影响它正在做的事', () => {
    useToolStore.getState().setTool('pose')
    useToolStore.getState().setGizmo('scale')
    expect(useToolStore.getState().tool).toBe('pose')
    // 切 gizmo 不该改动任何显示层（显示层现在只由工具与选中项驱动）
    expect(useToolStore.getState().overlay).toEqual({ display: true, bones: true, constraints: true })
  })

  it('isDrawTool 是这条规则的唯一出处', () => {
    expect(['weight', 'ffd'].every((tool) => isDrawTool(tool as 'weight'))).toBe(true)
    expect(['select', 'bone', 'pose'].some((tool) => isDrawTool(tool as 'select'))).toBe(false)
  })
})

describe('选项矩阵（可见 / 可选）', () => {
  it('默认三类都可见且可选：与加这个开关之前的行为一致', () => {
    const state = useToolStore.getState()
    expect(state.overlay).toEqual({ display: true, bones: true, constraints: true })
    expect(state.selectable).toEqual({ display: true, bones: true, constraints: true })
  })

  it('可见性与可选择性各改各的，互不牵连', () => {
    useToolStore.getState().toggleOverlay('display')
    expect(useToolStore.getState().overlay.display).toBe(false)
    // 关掉显示不动「可选」：两者是独立维度（能否点中 = 可见 && 可选，见 Scene.isPickable）
    expect(useToolStore.getState().selectable.display).toBe(true)

    useToolStore.getState().toggleSelectable('bones')
    expect(useToolStore.getState().selectable.bones).toBe(false)
    expect(useToolStore.getState().overlay.bones).toBe(true)

    useToolStore.getState().setSelectable('bones', true)
    expect(useToolStore.getState().selectable.bones).toBe(true)
    useToolStore.getState().toggleSelectable('constraints')
    expect(useToolStore.getState().selectable.constraints).toBe(false)
  })
})
