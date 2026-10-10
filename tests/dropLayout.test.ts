import { describe, expect, it } from 'vitest'
import { gridDropLayout } from '@ui/viewport/dropLayout'
import { readImageDrag, setImageDragData } from '@ui/widgets/dragDrop'

/** 最小的 DataTransfer 替身：只实现拖拽协议用到的那几个成员 */
function fakeTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    types: [] as string[],
    effectAllowed: 'uninitialized',
    setData(type: string, value: string) {
      data.set(type, value)
    },
    getData(type: string) {
      return data.get(type) ?? ''
    }
  } as unknown as DataTransfer
}

describe('gridDropLayout', () => {
  it('单张：偏移归零，包围盒就是图片本身', () => {
    const layout = gridDropLayout([{ width: 2, height: 1 }], 0.5)
    expect(layout.offsets).toEqual([{ x: 0, y: 0 }])
    expect(layout.width).toBe(2)
    expect(layout.height).toBe(1)
  })

  it('4 张排成 2×2：四张对称分布在落点四周', () => {
    const layout = gridDropLayout(
      [
        { width: 1, height: 1 },
        { width: 1, height: 1 },
        { width: 1, height: 1 },
        { width: 1, height: 1 }
      ],
      0
    )
    expect(layout.offsets).toEqual([
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: -0.5 }
    ])
  })

  it('尺寸不一时按最大图取格子，任意两张都不重叠', () => {
    const sizes = [
      { width: 2, height: 1 },
      { width: 0.5, height: 0.5 },
      { width: 1.5, height: 2 },
      { width: 1, height: 1 }
    ]
    const layout = gridDropLayout(sizes, 0.25)
    // 格子 2.25×2.25 → 中心间距大于两边半宽之和，不会叠
    for (let i = 0; i < layout.offsets.length; i++) {
      for (let j = i + 1; j < layout.offsets.length; j++) {
        const dx = Math.abs(layout.offsets[i].x - layout.offsets[j].x)
        const dy = Math.abs(layout.offsets[i].y - layout.offsets[j].y)
        const overlapX = dx < (sizes[i].width + sizes[j].width) / 2
        const overlapY = dy < (sizes[i].height + sizes[j].height) / 2
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('5 张排 3 列 2 行：包围盒含网格空隙', () => {
    const layout = gridDropLayout(
      Array.from({ length: 5 }, () => ({ width: 1, height: 1 })),
      0.5
    )
    // 3 列 × 1.5 宽 - 末尾空隙 = 4；2 行 × 1.5 高 - 末尾空隙 = 2.5
    expect(layout.width).toBe(4)
    expect(layout.height).toBe(2.5)
    expect(layout.offsets).toHaveLength(5)
  })
})

describe('图片拖拽协议', () => {
  it('多张：按写入顺序读回', () => {
    const transfer = fakeTransfer()
    setImageDragData(transfer, ['a.png', 'b.png', 'c.png'])
    expect(readImageDrag(transfer)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('单张：字符串与数组两种写法都能读回', () => {
    const fromString = fakeTransfer()
    setImageDragData(fromString, 'only.png')
    expect(readImageDrag(fromString)).toEqual(['only.png'])

    const fromArray = fakeTransfer()
    setImageDragData(fromArray, ['only.png'])
    expect(readImageDrag(fromArray)).toEqual(['only.png'])
  })

  it('兼容早期的裸图片名格式（不是 JSON）', () => {
    const transfer = fakeTransfer()
    transfer.setData('application/x-hao2d-image', 'legacy.png')
    expect(readImageDrag(transfer)).toEqual(['legacy.png'])
  })

  it('空数据 / 空列表读回空数组', () => {
    const transfer = fakeTransfer()
    expect(readImageDrag(transfer)).toEqual([])
    setImageDragData(transfer, [])
    expect(readImageDrag(transfer)).toEqual([])
  })
})
