import { it } from 'vitest'
import fs from 'node:fs'
import { importSpine } from '@importers/spine'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import type { SpineJson } from '@importers/spineTypes'

const base = '/Volumes/zzl_mac/unity/Bones2D-master/Assets/Spine Examples/Spineunitygirl'
const out = process.env.DUMP_OUT ?? '/tmp/doi-now.json'

it('dump main pose', () => {
  const json = JSON.parse(fs.readFileSync(`${base}/Doi.json`, 'utf8')) as SpineJson
  const atlasText = fs.readFileSync(`${base}/Doi.atlas.txt`, 'utf8')
  const atlas = parseSpineAtlas(atlasText)
  const { asset } = importSpine({ json, regions: atlas.regions, pageSizes: atlas.pageSizes, atlasText })
  const sk = new Skeleton(asset)
  const player = new AnimationPlayer(asset, sk)
  player.play('main', true)
  const frames: Record<string, number[]> = {}
  for (let f = 0; f <= 20; f++) {
    player.update(f === 0 ? 0 : 1 / 30)
    const row: number[] = []
    for (let b = 0; b < asset.bones.length; b++) {
      row.push(
        Math.round(sk.world[b * 16 + 12] * 1000) / 1000,
        Math.round(sk.world[b * 16 + 13] * 1000) / 1000
      )
    }
    frames[`f${f}`] = row
  }
  const anim = asset.animations.find((a) => a.name === 'main')!
  const tracks: Record<string, unknown> = {}
  anim.bones.forEach((t) => {
    tracks[asset.bones[t.bone].name] = t
  })
  fs.writeFileSync('/tmp/doi-tracks-' + (process.env.DUMP_OUT ?? 'x').split('/').pop(), JSON.stringify(tracks))
  fs.writeFileSync(
    out,
    JSON.stringify({ bones: asset.bones.map((b) => b.name), runtimeIK: asset.runtimeIK, constraints: asset.constraints.length, frames })
  )
  console.log('written', out, 'bones', asset.bones.length, 'runtimeIK', asset.runtimeIK)
})
