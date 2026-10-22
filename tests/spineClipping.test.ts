import { describe, expect, it } from 'vitest'
import { importSpine } from '@importers/spine'
import { buildSpineJson } from '@editor/services/spineExport'
import type { SpineJson } from '@importers/spineTypes'
import type { AtlasRegion } from '@importers/uv'
import { AttachmentType } from '@core/model/types'

const REGION: AtlasRegion = {
  name: 'body',
  page: 'atlas.png',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotate: 0,
  origWidth: 100,
  origHeight: 100,
  offsetX: 0,
  offsetY: 0
}

function source(): SpineJson {
  return {
    skeleton: { spine: '4.3.74', fps: 30 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'mask', bone: 'root', attachment: 'mask' },
      { name: 'body', bone: 'root', attachment: 'body' }
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          mask: {
            mask: {
              type: 'clipping',
              end: 'body',
              inverse: true,
              convex: true,
              vertexCount: 4,
              vertices: [-50, -50, 50, -50, 50, 50, -50, 50]
            }
          },
          body: {
            body: { x: 0, y: 0, width: 100, height: 100 }
          }
        }
      }
    ],
    animations: {}
  }
}

describe('Spine clipping 导入 / 导出', () => {
  it('导入为 Clipping 附件并保留结束插槽 / 反向 / 凸形', () => {
    const result = importSpine({
      json: source(),
      regions: [REGION],
      pageSizes: { 'atlas.png': { width: 128, height: 128 } }
    })
    const attachment = result.asset.skins[0]!.slots
      .find((slot) => slot.slotName === 'mask')!
      .attachments.find((item) => item.name === 'mask')!
    expect(attachment.type).toBe(AttachmentType.Clipping)
    expect(attachment.clipEndSlot).toBe('body')
    expect(attachment.clipInverse).toBe(true)
    expect(attachment.clipConvex).toBe(true)
    expect(attachment.vertices.length).toBe(8)
    expect(attachment.vertices[0]).toBeCloseTo(-0.5, 5)
  })

  it('导出回 Spine JSON 时写 type=clipping 与 end/vertices', () => {
    const imported = importSpine({
      json: source(),
      regions: [REGION],
      pageSizes: { 'atlas.png': { width: 128, height: 128 } }
    })
    const json = buildSpineJson(imported.asset)
    const attachment = json.skins![0]!.attachments!.mask!.mask as Record<string, unknown>
    expect(attachment.type).toBe('clipping')
    expect(attachment.end).toBe('body')
    expect(attachment.inverse).toBe(true)
    expect(attachment.convex).toBe(true)
    expect(attachment.vertexCount).toBe(4)
    expect(attachment.vertices).toEqual([-50, -50, 50, -50, 50, 50, -50, 50])
  })
})
