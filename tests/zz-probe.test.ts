import { it } from 'vitest'
import fs from 'node:fs'
import { importSpine } from '@importers/spine'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { decompileAsset } from '@core/codec/decompile'
import { compileDocument } from '@core/codec/compile'

const dir = '/Volumes/zzl_mac/bak/SP273 一起打僵尸/一起打僵尸/029'

it('probe doc slots', () => {
  const json = JSON.parse(fs.readFileSync(`${dir}/Character-1.json`, 'utf8'))
  const atlasText = fs.readFileSync(`${dir}/Character-1.atlas`, 'utf8')
  const atlas = parseSpineAtlas(atlasText)
  const { asset } = importSpine({ json, regions: atlas.regions, pageSizes: atlas.pageSizes, atlasText })
  const doc = decompileAsset(asset)
  console.log('doc slots count', doc.slots.length)
  console.log('doc slot names', doc.slots.map((s) => `${s.name}|${s.attachment}`).slice(0, 40).join(' '))
  console.log('doc skins', doc.skins.map((s) => `${s.name}(${s.slots.length})`).join(' '))
  const skin = doc.skins.find((s) => s.name === 'AK/AK-0')!
  console.log('AK/AK-0 slots', skin.slots.map((s) => `${s.slot}[${s.attachments.map((a) => a.name).join(',')}]`).join(' '))
  console.log('editorMeta.activeSkin', doc.editorMeta.activeSkin)

  doc.editorMeta.activeSkin = 'AK/AK-0'
  const compiled = compileDocument(doc)
  console.log('compiled defaultSkin', compiled.asset.defaultSkin, 'defaultSkinIndex', compiled.asset.defaultSkinIndex)
  console.log('compiled skins', compiled.asset.skins.map((s) => `${s.name}(${s.slots.length})`).slice(0, 5).join(' '))
  const base = compiled.asset.skins[compiled.asset.defaultSkinIndex]
  console.log('compiled base slot has AK-0?', base.slots.some((s) => s.slotName === 'AK-0'))
})
