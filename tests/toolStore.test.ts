import { beforeEach, describe, expect, it } from 'vitest'
import { isDrawTool, useToolStore } from '@editor/store/toolStore'

/**
 * 变换工具（视口左侧那排 移动/旋转/缩放/斜切）与编辑工具的联动。
 *
 * 起因是一次实测：Pose 工具下点「缩放」，上面的工具自动跳回了「选择」——
 * 每换一种变换方式都要重新点一次 Pose 工具。
 */
beforeEach(() => {
  // 显示层也要复位：切工具已经不动 overlay 了，但用例之间仍不该互相影响
  useToolStore.setState({
    tool: 'select',
    gizmo: 'move',
    overlay: { bones: true, constraints: true },
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
    expect(useToolStore.getState().overlay).toEqual({ bones: true, constraints: true })
  })

  it('isDrawTool 是这条规则的唯一出处', () => {
    expect(['weight', 'ffd'].every((tool) => isDrawTool(tool as 'weight'))).toBe(true)
    expect(['select', 'bone', 'pose'].some((tool) => isDrawTool(tool as 'select'))).toBe(false)
  })
})
