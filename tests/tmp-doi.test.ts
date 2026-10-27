import { it } from 'vitest'
import fs from 'node:fs'
import {
  TextureAtlas,
  AtlasAttachmentLoader,
  SkeletonJson,
  Skeleton as OfficialSkeleton,
  Physics,
  AnimationState,
  AnimationStateData
} from '@esotericsoftware/spine-core'
import { normalizeLegacyAnimations } from '@importers/spineLegacyCurves'
import { PPU } from '@importers/uv'
import type { SpineJson } from '@importers/spineTypes'

const base = '/Volumes/zzl_mac/unity/Bones2D-master/Assets/Spine Examples/Spineunitygirl'

it('derived vs applied locals during main', () => {
  const jsonText = fs.readFileSync(`${base}/Doi.json`, 'utf8')
  const atlasText = fs.readFileSync(`${base}/Doi.atlas.txt`, 'utf8')
  const json = JSON.parse(jsonText) as SpineJson
  const normalized = normalizeLegacyAnimations(structuredClone(json))
  const jsonForOfficial = JSON.stringify(normalized.json ?? normalized)

  const skeletonJson = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText)))
  skeletonJson.scale = 1 / PPU
  const data = skeletonJson.readSkeletonData(jsonForOfficial)
  const official = new OfficialSkeleton(data)
  const state = new AnimationState(new AnimationStateData(data))
  state.setAnimation(0, 'main', true)

  for (let f = 0; f <= 6; f++) {
    state.update(f === 0 ? 0 : 1 / 30)
    state.apply(official)
    official.updateWorldTransform(Physics.update)
    const changed: string[] = []
    for (const bone of official.bones) {
      const pose = (bone as any).appliedPose
      const w = pose as any
      const det = w.a * w.d - w.b * w.c
      const before = { x: pose.x, y: pose.y, r: pose.rotation, sx: pose.scaleX, sy: pose.scaleY }
      if (typeof pose.updateLocalTransform !== 'function') continue
      if (!(Math.abs(det) > 1e-12 * (Math.abs(w.a * w.d) + Math.abs(w.b * w.c) + 1))) continue
      pose.updateLocalTransform(official)
      const after = { x: pose.x, y: pose.y, r: pose.rotation, sx: pose.scaleX, sy: pose.scaleY }
      const d = Math.max(
        Math.abs(after.x - before.x),
        Math.abs(after.y - before.y),
        Math.abs(after.r - before.r) * 0.01,
        Math.abs(after.sx - before.sx),
        Math.abs(after.sy - before.sy)
      )
      if (d > 1e-3) changed.push(`${bone.data.name}(d=${d.toFixed(2)})`)
    }
    console.log(`f${f}`, changed.length ? changed.join(' ') : 'none')
  }
})
