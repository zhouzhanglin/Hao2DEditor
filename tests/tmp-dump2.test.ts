import { it } from 'vitest'
import fs from 'node:fs'
import { importSpine } from '@importers/spine'
import { parseSpineAtlas } from '@importers/atlasSpine'
import type { SpineJson } from '@importers/spineTypes'

const base = '/Volumes/zzl_mac/unity/Bones2D-master/Assets/Spine Examples/Spineunitygirl'

it('dump tracks', () => {
  const out = process.env.DUMP_OUT ?? '/tmp/t.json'
  const json = JSON.parse(fs.readFileSync(`${base}/Doi.json`, 'utf8')) as SpineJson
  const atlasText = fs.readFileSync(`${base}/Doi.atlas.txt`, 'utf8')
  const atlas = parseSpineAtlas(atlasText)
  const { asset } = importSpine({ json, regions: atlas.regions, pageSizes: atlas.pageSizes, atlasText })
  const anims = asset.animations.map((a) => ({
    name: a.name,
    bones: Array.isArray(a.bones) ? a.bones.length : -1,
    sample: Array.isArray(a.bones) ? a.bones.slice(0, 3) : null
  }))
  console.log(JSON.stringify(anims, null, 1).slice(0, 1200))
  const main = asset.animations.find((a) => a.name === 'main')!
  const tracks: Record<string, unknown> = {}
  for (const t of main.bones) {
    const name = asset.bones[t.boneIndex]?.name ?? `?${t.boneIndex}`
    tracks[name] = t
  }
  fs.writeFileSync(out, JSON.stringify(tracks))
  console.log('written', out, Object.keys(tracks).length)
})
