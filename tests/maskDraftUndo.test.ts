import { describe, expect, it } from 'vitest'
import type { EditorScene } from '@editor/scene'
import { undoMaskDraftPoint } from '@editor/tools/authoringTools'

function fakeScene(pendingMaskPath: EditorScene['state']['pendingMaskPath']) {
  let state = { pendingMaskPath } as EditorScene['state']
  const messages: string[] = []
  const scene = {
    get state() {
      return state
    },
    setViewState(patch: Partial<EditorScene['state']>) {
      state = { ...state, ...patch } as EditorScene['state']
    },
    markDirty() {}
  } as unknown as EditorScene
  return {
    scene,
    messages,
    status: (text: string) => messages.push(text),
    draft: () => state.pendingMaskPath
  }
}

const point = (x: number, y: number) => ({ x, y })

describe('遮罩草稿点撤销', () => {
  it('新建遮罩：Ctrl+Z 逐个撤回已落点', () => {
    const h = fakeScene({
      slot: 'mask',
      target: '',
      points: [point(0, 0), point(10, 0), point(10, 10)],
      cursor: point(20, 20),
      baseCount: 0
    })

    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(2)
    expect(h.draft()?.cursor?.x).toBe(20)

    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(1)

    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(0)

    // 没有点可退也吃掉 Ctrl+Z，避免误撤销文档里创建遮罩之前的命令
    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(0)
    expect(h.messages.at(-1)).toContain('还没有落下遮罩点')
  })

  it('在已有遮罩上追加点：只撤回新增点，不动原多边形', () => {
    const h = fakeScene({
      slot: 'mask',
      target: 'mask',
      points: [point(0, 0), point(10, 0), point(10, 10), point(0, 10), point(20, 20)],
      cursor: null,
      baseCount: 4
    })

    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(4)
    expect(h.messages.at(-1)).toContain('原多边形未变')

    // 再按不会删原多边形的点
    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(true)
    expect(h.draft()?.points).toHaveLength(4)
    expect(h.messages.at(-1)).toContain('没有新增的遮罩点可撤销')

    expect(h.draft()?.points.map((item) => item.x)).toEqual([0, 10, 10, 0])
  })

  it('没有遮罩草稿时返回 false，交还给文档撤销', () => {
    const h = fakeScene(null)
    expect(undoMaskDraftPoint(h.scene, h.status)).toBe(false)
  })
})
