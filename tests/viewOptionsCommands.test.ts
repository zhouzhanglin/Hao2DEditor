import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installCommands } from '@editor/commands'
import { executeCommand } from '@editor/commands/registry'
import { useToolStore } from '@editor/store/toolStore'

/**
 * 视口「选项」矩阵的两列：可见（setOverlay）与可被选中（setSelectable）。
 *
 * 这两组是**独立维度**，命令层也必须各管各的：改可选性不能顺手改可见性，
 * 反之亦然（实际能否点中 = 可见 && 可选，见 Scene.isPickable）。
 */

// 命令表只装一次（重复注册会抛「命令重复注册」）
beforeAll(() => installCommands())

beforeEach(() => {
  useToolStore.setState({
    overlay: { display: true, bones: true, constraints: true },
    selectable: { display: true, bones: true, constraints: true }
  })
})

describe('setOverlay：三层可见性', () => {
  it('display / bones / constraints 三层都能关', async () => {
    for (const key of ['display', 'bones', 'constraints'] as const) {
      const result = await executeCommand('setOverlay', { key, visible: false })
      expect(result.ok).toBe(true)
      expect(useToolStore.getState().overlay[key]).toBe(false)
    }
  })

  it('不传 visible = 切换，并且不动「可被选中」', async () => {
    await executeCommand('setOverlay', { key: 'display' })
    expect(useToolStore.getState().overlay.display).toBe(false)
    await executeCommand('setOverlay', { key: 'display' })
    expect(useToolStore.getState().overlay.display).toBe(true)
    // 可见性归可见性：可选性一直是 true
    expect(useToolStore.getState().selectable.display).toBe(true)
  })

  it('非法 key 被拒绝，且不改任何层', async () => {
    const result = await executeCommand('setOverlay', { key: 'meshes' })
    expect(result.ok).toBe(false)
    expect(useToolStore.getState().overlay).toEqual({ display: true, bones: true, constraints: true })
  })
})

describe('setSelectable：三类对象的可选性', () => {
  it('关掉骨骼可选，可见性保持不变', async () => {
    const result = await executeCommand('setSelectable', { kind: 'bones', selectable: false })
    expect(result.ok).toBe(true)
    const state = useToolStore.getState()
    expect(state.selectable.bones).toBe(false)
    expect(state.overlay.bones).toBe(true)
  })

  it('不传 selectable = 切换', async () => {
    await executeCommand('setSelectable', { kind: 'display' })
    expect(useToolStore.getState().selectable.display).toBe(false)
    await executeCommand('setSelectable', { kind: 'display' })
    expect(useToolStore.getState().selectable.display).toBe(true)
  })

  it('约束也能单独设', async () => {
    await executeCommand('setSelectable', { kind: 'constraints', selectable: false })
    expect(useToolStore.getState().selectable.constraints).toBe(false)
    expect(useToolStore.getState().selectable.bones).toBe(true)
  })

  it('非法 kind 被拒绝', async () => {
    const result = await executeCommand('setSelectable', { kind: 'slots' })
    expect(result.ok).toBe(false)
    expect(useToolStore.getState().selectable).toEqual({ display: true, bones: true, constraints: true })
  })
})
