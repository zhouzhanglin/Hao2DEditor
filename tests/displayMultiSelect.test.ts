import { beforeEach, describe, expect, it } from 'vitest'
import { useSelectionStore } from '@editor/store/selectionStore'
import { selectionTargets } from '@editor/timeline/actions'

/**
 * display（附件）多选：框选 / Shift 加选都写进 `attachments`，单值 `slot` / `attachment`
 * 继续表示**主选中**。这里钉住这套语义 —— 检查器、操作器、打帧条全都读那两个单值字段，
 * 一旦集合与主选中脱钩，它们就会显示 / 编辑到错的对象。
 */
describe('display 多选（selection.attachments）', () => {
  beforeEach(() => useSelectionStore.getState().clear())

  it('selectAttachment 收敛成单选：集合只剩这一项，且成为主选中', () => {
    useSelectionStore.getState().selectAttachments([
      { slot: 's1', attachment: 'a' },
      { slot: 's2', attachment: 'b' }
    ])
    useSelectionStore.getState().selectAttachment('s3', 'c')
    const state = useSelectionStore.getState()
    expect(state.kind).toBe('attachment')
    expect(state.attachments).toEqual([{ slot: 's3', attachment: 'c' }])
    expect(state.slot).toBe('s3')
    expect(state.attachment).toBe('c')
  })

  it('toggleAttachment：加选后新项成为主选中，减掉主选中后退回最后一项', () => {
    const store = useSelectionStore.getState()
    store.toggleAttachment('s1', 'a')
    expect(useSelectionStore.getState().attachments).toHaveLength(1)

    store.toggleAttachment('s2', 'b')
    let state = useSelectionStore.getState()
    expect(state.attachments.map((item) => item.attachment)).toEqual(['a', 'b'])
    expect(state.attachment).toBe('b')

    // 再点一次 b（当前主选中）→ 移出，主选中退回剩下的 a
    store.toggleAttachment('s2', 'b')
    state = useSelectionStore.getState()
    expect(state.attachments.map((item) => item.attachment)).toEqual(['a'])
    expect(state.attachment).toBe('a')

    // 全部减完 = 取消选择
    store.toggleAttachment('s1', 'a')
    state = useSelectionStore.getState()
    expect(state.kind).toBe('none')
    expect(state.attachments).toEqual([])
  })

  it('同名附件在不同插槽里是两个对象，不能互相抵消', () => {
    const store = useSelectionStore.getState()
    store.toggleAttachment('s1', 'head')
    store.toggleAttachment('s2', 'head')
    const state = useSelectionStore.getState()
    expect(state.attachments).toHaveLength(2)
    store.toggleAttachment('s1', 'head')
    expect(useSelectionStore.getState().attachments).toEqual([{ slot: 's2', attachment: 'head' }])
  })

  it('selectAttachments：去重、空数组等于取消选择', () => {
    const store = useSelectionStore.getState()
    store.selectAttachments([
      { slot: 's1', attachment: 'a' },
      { slot: 's1', attachment: 'a' },
      { slot: 's2', attachment: 'b' }
    ])
    expect(useSelectionStore.getState().attachments).toEqual([
      { slot: 's1', attachment: 'a' },
      { slot: 's2', attachment: 'b' }
    ])
    // 主选中 = 最后一个
    expect(useSelectionStore.getState().attachment).toBe('b')

    store.selectAttachments([])
    expect(useSelectionStore.getState().kind).toBe('none')
    expect(useSelectionStore.getState().attachments).toEqual([])
  })

  it('选中骨骼会清空附件集合（否则叠加层还画着上一批 display）', () => {
    useSelectionStore.getState().selectAttachments([{ slot: 's1', attachment: 'a' }])
    useSelectionStore.getState().selectBone('root')
    const state = useSelectionStore.getState()
    expect(state.kind).toBe('bone')
    expect(state.attachments).toEqual([])
  })

  it('selectedObjects 把集合展开成多个 display（层级树 / 面板靠它高亮）', () => {
    useSelectionStore
      .getState()
      .selectAttachments([
        { slot: 's1', attachment: 'a' },
        { slot: 's2', attachment: 'b' }
      ])
    expect(useSelectionStore.getState().selectedObjects).toEqual([
      { kind: 'display', slot: 's1', name: 'a' },
      { kind: 'display', slot: 's2', name: 'b' }
    ])
  })

  it('K 打帧目标覆盖整批选中 display 之外，约束集合也遵循同一套约定', () => {
    // 约束多选：框选 / Shift 点击都写进 `constraints`，单值 `constraint` 仍是主选中
    useSelectionStore.getState().selectConstraints(['a', 'b', 'a'])
    let state = useSelectionStore.getState()
    expect(state.kind).toBe('constraint')
    expect(state.constraints).toEqual(['a', 'b'])
    expect(state.constraint).toBe('b')

    useSelectionStore.getState().toggleConstraint('c')
    state = useSelectionStore.getState()
    expect(state.constraints).toEqual(['a', 'b', 'c'])
    expect(state.constraint).toBe('c')

    // 点单条 = 收敛成单选
    useSelectionStore.getState().selectConstraint('a')
    state = useSelectionStore.getState()
    expect(state.constraints).toEqual(['a'])
    expect(state.constraint).toBe('a')

    // 切到骨骼 / display 时集合清空（避免叠加层 / 状态栏残留）
    useSelectionStore.getState().selectBone('root')
    expect(useSelectionStore.getState().constraints).toEqual([])
    useSelectionStore.getState().selectConstraints(['x'])
    useSelectionStore.getState().selectAttachment('slot', 'att')
    expect(useSelectionStore.getState().constraints).toEqual([])
  })

  it('K 打帧目标覆盖整批选中 display', () => {
    useSelectionStore
      .getState()
      .selectAttachments([
        { slot: 's1', attachment: 'a' },
        { slot: 's2', attachment: 'b' }
      ])
    expect(selectionTargets(useSelectionStore.getState())).toEqual([
      { kind: 'deform', target: 's1', attachment: 'a' },
      { kind: 'deform', target: 's2', attachment: 'b' }
    ])
  })
})
