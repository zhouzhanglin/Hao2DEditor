import { describe, expect, it } from 'vitest'
import { parseDocument, serializeDocument } from '@core/codec/projectJson'
import { BlendMode } from '@core/model/types'
import { CURRENT_SCHEMA_VERSION, createEmptyDocument } from '@core/model/authoring'

/** 最小 v1 工程：三个插槽分别用旧 Mask(5) / Below(6) / None(7) */
function legacyProject(): string {
  return JSON.stringify({
    schemaVersion: 1,
    armatureName: 'legacy',
    frameRate: 30,
    bones: [{ name: 'root', parent: '', localPosition: { x: 0, y: 0 }, rotation: 0 }],
    slots: [
      { name: 'a', bone: 'root', blendMode: 5 },
      { name: 'b', bone: 'root', blendMode: 6 },
      { name: 'c', bone: 'root', blendMode: 7 }
    ],
    skins: [{ name: 'default', slots: [] }],
    constraints: [],
    animations: [],
    images: []
  })
}

describe('工程 schema v1 → v2 迁移', () => {
  it('旧 Mask 变 Normal，Below / None 各前移一位', () => {
    const parsed = parseDocument(legacyProject())
    const slots = parsed.document.slots
    expect(slots[0]!.blendMode).toBe(BlendMode.Normal)
    expect(slots[1]!.blendMode).toBe(BlendMode.Below)
    expect(slots[2]!.blendMode).toBe(BlendMode.None)
    expect(parsed.warnings.some((text) => text.includes('Mask'))).toBe(true)
  })

  it('写出一律是新版本号', () => {
    const doc = createEmptyDocument()
    expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(JSON.parse(serializeDocument(doc)).schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})
