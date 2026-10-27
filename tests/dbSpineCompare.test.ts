import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { importDragonBones } from '@importers/dragonBones'
import { parseDbTextureJson } from '@importers/dragonBonesAtlas'
import {
  buildSpineJson,
  buildRegionLookup,
  serializeSpineAtlas,
  collectRegionTrim,
  spineAtlasRegionNames
} from '@editor/services/spineExport'
import { Skeleton } from '@core/model/skeleton'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { buildRuntimeMaps } from '@core/model/asset'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import type { RuntimeAtlasJson } from '@core/codec/runtimeSkeJson'
import { AttachmentType } from '@core/model/types'
import * as spine from '@esotericsoftware/spine-core'

const EXAMPLES_DIR = '/Volumes/zzl_mac/unity/Bones2D-master/Assets/DragonBone Examples'
const EXAMPLES = [
  'Ubbie_MeshAnim',
  'Demon',
  'Dora_zorder',
  'Dragon',
  'Sheep',
  'Rooster',
  'SkinnedMeshAnim'
]

function readPngSize(p: string) {
  const buf = fs.readFileSync(p)
  // IHDR: width @16..19, height @20..23 (big-endian)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width, height }
}

function loadExample(dir: string) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
  let skeletonJson: any = null
  const subTextures: any[] = []
  const pageSizes: Record<string, { width: number; height: number }> = {}
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
    if (Array.isArray(obj.armature) && obj.armature.length) {
      skeletonJson = obj
    } else if (Array.isArray(obj.SubTexture)) {
      const page = obj.imagePath
      const pngPath = path.join(dir, page)
      if (fs.existsSync(pngPath)) pageSizes[page] = readPngSize(pngPath)
      subTextures.push(...parseDbTextureJson(obj, pageSizes))
    }
  }
  if (!skeletonJson) throw new Error('no skeleton json in ' + dir)
  const result = importDragonBones({ json: skeletonJson, subTextures, pageSizes })
  return result.asset
}

function buildAtlas(asset: any): RuntimeAtlasJson {
  // 标注成图集 JSON：下游 serializeSpineAtlas / 区域改名都按这份结构读，
  // 少了 format / version 会被当成残缺数据
  const pages = asset.images.map((img: any) => ({
    image: img.name,
    width: img.width,
    height: img.height
  }))
  const regions: any[] = []
  asset.images.forEach((img: any, pi: number) => {
    for (const r of img.regions ?? []) {
      regions.push({
        name: r.name,
        page: pi,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        rotate: r.rotate,
        origWidth: r.origWidth,
        origHeight: r.origHeight,
        offsetX: r.offsetX,
        offsetY: r.offsetY
      })
    }
  })
  return { format: 'hao2d-atlas', version: 1, pages, regions }
}

// 复刻真实导出路径：spineAtlasRegionNames + collectRegionTrim
function exportSpine(asset: any) {
  const atlas = buildAtlas(asset)
  const names = spineAtlasRegionNames(atlas)
  const { trim } = collectRegionTrim(asset, atlas)
  atlas.regions = atlas.regions.map((r: any) => ({
    ...r,
    name: names.get(r.name) ?? r.name,
    ...(trim.get(r.name) ?? {})
  }))
  const lookup = buildRegionLookup(atlas)
  lookup.names = names
  const spineJson = buildSpineJson(asset, lookup)
  const atlasText = serializeSpineAtlas(atlas)
  return { spineJson, atlasText, atlas }
}

// 用 spine-core 4.3 真实运行库计算 region 附件的世界坐标 + 整页 UV。
// 4.3 起附件不再有 `region` 属性，纹理区域、UV、四边形偏移都由 `sequence` 承载，
// `updateSequence()` 在 readSkeletonData 里已经调用过，sequence.uvs/offsets 可直接用。
function spineRegionWorld(spa: any, slot: any): { world: number[]; uvs: number[] } {
  const seq = spa.sequence
  const world = new Float32Array(8)
  spa.computeWorldVertices(slot, seq.offsets[0], world, 0, 2)
  return { world: Array.from(world), uvs: Array.from(seq.getUVs(0) as ArrayLike<number>) }
}

function spineMeshWorld(spa: any, skel: any, slot: any): { world: number[]; uvs: number[] } {
  const out = new Float32Array(spa.worldVerticesLength)
  spa.computeWorldVertices(skel, slot, 0, spa.worldVerticesLength, out, 0, 2)
  // `spa` 是 any，`getUVs` 的结果会退化成 unknown[] —— 这里按数值数组收口
  return { world: Array.from(out), uvs: Array.from(spa.sequence.getUVs(0) as ArrayLike<number>) }
}

const key = (u: number, v: number) => `${u.toFixed(5)}:${v.toFixed(5)}`

describe('DragonBones 导出 spine 与编辑器图像一致性', () => {
  for (const name of EXAMPLES) {
    it(name, () => {
      const dir = path.join(EXAMPLES_DIR, name)
      const asset = loadExample(dir)

      // 编辑器真值
      const edSkel = new Skeleton(asset)
      const builder = new MeshBuilder(asset)
      const res = builder.build(edSkel)
      buildRuntimeMaps(asset)
      const defaultSkin = asset.skins[asset.defaultSkinIndex]

      // 编辑器角点：按槽位收集（只取默认皮肤 setup 附件），顶点顺序以 sourceVertex 为准
      const editorVerts = new Map<number, Array<{ x: number; y: number; u: number; v: number }>>()
      for (let i = 0; i < res.vertexCount; i++) {
        const si = res.sourceSlot[i]
        const vi = res.sourceVertex[i]
        const slotName = asset.slots[si].name
        const skinSlot = defaultSkin.slots.find((s: any) => s.slotName === slotName)
        if (!skinSlot) continue
        const di = edSkel.slotDisplayIndex[si]
        const att = skinSlot.attachments[di]
        if (!att || att.type === AttachmentType.BoundingBox) continue
        const list = editorVerts.get(si) ?? []
        // 编辑器内部以「单位」存坐标（1 单位 = RUNTIME_PPU 像素），导出 json 是像素，先换算
        list[vi] = {
          x: res.positions[i * 2] * RUNTIME_PPU,
          y: res.positions[i * 2 + 1] * RUNTIME_PPU,
          u: att.uvs[vi * 2],
          v: att.uvs[vi * 2 + 1]
        }
        editorVerts.set(si, list)
      }

      // 真实导出 + spine-core 加载
      const { spineJson, atlasText, atlas } = exportSpine(asset)
      const ta = new spine.TextureAtlas(atlasText)
      const loader = new spine.AtlasAttachmentLoader(ta)
      const sj = new spine.SkeletonJson(loader)
      const data = sj.readSkeletonData(JSON.stringify(spineJson))
      const skel = new spine.Skeleton(data)
      skel.setupPose()
      skel.updateWorldTransform(spine.Physics.pose)

      let maxMeshDiff = 0
      let maxRegionDiff = 0
      let maxUvDiff = 0
      let meshCount = 0
      let regionCount = 0
      const problems: string[] = []

      for (const skinSlot of defaultSkin.slots) {
        const slotName = skinSlot.slotName
        if (!slotName) continue
        const si = asset.slots.findIndex((s: any) => s.name === slotName)
        const di = edSkel.slotDisplayIndex[si]
        const att = skinSlot.attachments[di]
        if (!att || att.type === AttachmentType.BoundingBox) continue

        const slotIndex = data.slots.findIndex((s: any) => s.name === slotName)
        if (slotIndex < 0) {
          problems.push(`slot not found: ${slotName}`)
          continue
        }
        // defaultSkin 在运行库里是可空的（没有皮肤时）—— 这里按缺失处理
        const spa = data.defaultSkin?.getAttachment(slotIndex, att.name)
        if (!spa) {
          problems.push(`attachment not found: ${slotName}/${att.name}`)
          continue
        }
        const slot = skel.slots[slotIndex]

        let world: number[]
        let uvs: number[]
        if (att.type === AttachmentType.Mesh) {
          const r = spineMeshWorld(spa, skel, slot)
          world = r.world
          uvs = r.uvs
          meshCount++
        } else if (spa instanceof spine.RegionAttachment) {
          const r = spineRegionWorld(spa, slot)
          world = r.world
          uvs = r.uvs
          regionCount++
        } else {
          continue
        }

        // 先按**顶点位置**把 Unity 端 Hao2D 运行时顶点与编辑器顶点配对（几何是真相），再比较 UV；
        // 只按 UV 配对会把「位置对、UV 差一点」当成找不到顶点，掩盖贴图错位。
        const eds = (editorVerts.get(si) ?? []).filter(Boolean)
        const vCount = world.length / 2
        if (eds.length !== vCount) {
          problems.push(`${att.name}: vertex count spine=${vCount} editor=${eds.length}`)
        }
        const used = new Set<number>()
        for (let vi = 0; vi < vCount; vi++) {
          let best = -1
          let bestDist = Infinity
          for (let k = 0; k < eds.length; k++) {
            if (used.has(k)) continue
            const d = Math.hypot(world[vi * 2] - eds[k].x, world[vi * 2 + 1] - eds[k].y)
            if (d < bestDist) {
              bestDist = d
              best = k
            }
          }
          if (best < 0) {
            problems.push(`${att.name}#${vi}: no editor vertex`)
            continue
          }
          used.add(best)
          // 位置 + UV 都要一致，绘制结果才会逐像素相同。
          // 编辑器模型里 v=0 是图像**底部**（左下原点），spine 运行库 v=0 是**顶部**，
          // 两者对同一像素互为 1-v（编辑器渲染时 writeVertex 也会再翻一次成 pixi 的左上原点）。
          maxUvDiff = Math.max(
            maxUvDiff,
            Math.abs(uvs[vi * 2] - eds[best].u),
            Math.abs((1 - uvs[vi * 2 + 1]) - eds[best].v)
          )
          if (bestDist > 0.02) {
            problems.push(
              `${att.name}#${vi}: pos off ${bestDist.toFixed(3)} ` +
                `spine=(${world[vi * 2].toFixed(2)},${world[vi * 2 + 1].toFixed(2)}) ` +
                `editor=(${eds[best].x.toFixed(2)},${eds[best].y.toFixed(2)})`
            )
          }
          if (att.type === AttachmentType.Mesh) {
            maxMeshDiff = Math.max(maxMeshDiff, bestDist)
          } else {
            maxRegionDiff = Math.max(maxRegionDiff, bestDist)
          }
        }
      }

      console.log(
        `[${name}] mesh=${meshCount} maxMeshDiff=${maxMeshDiff.toFixed(4)} ` +
          `region=${regionCount} maxRegionDiff=${maxRegionDiff.toFixed(4)} ` +
          `maxUvDiff=${maxUvDiff.toExponential(2)} ` +
          `problems=${problems.length ? problems.slice(0, 4).join(' | ') : 'none'}`
      )

      // 允许极小数值误差；若导出正确，应与编辑器逐点一致
      expect(maxMeshDiff).toBeLessThan(0.02)
      expect(maxRegionDiff).toBeLessThan(0.02)
      expect(maxUvDiff).toBeLessThan(1e-5)
      expect(problems.filter((p) => !p.includes('pos off'))).toEqual([])

      // 绘制顺序：按 Unity 端 Hao2D 运行时读法重放导出的 offsets，必须还原出编辑器每一帧的完整顺序。
      // Dora_zorder 曾因为 offsets 按「目标位置」乱序写出，让 Unity 端 Hao2D 运行时的 originalIndex 永远追不上
      // index 而 RangeError: Invalid array length（读都读不进来）。
      const slotNames = asset.slots.map((s: any) => s.name)
      for (const anim of asset.animations) {
        const exported = (spineJson.animations as any)[anim.name]?.drawOrder as
          | Array<{ time: number; offsets?: Array<{ slot: string; offset: number }> }>
          | undefined
        expect(exported?.length ?? 0, `${name}/${anim.name} 绘制顺序帧数`).toBe(anim.drawOrder.length)
        anim.drawOrder.forEach((key, fi) => {
          const replayed = replayDrawOrder(exported![fi].offsets, slotNames)
          expect(replayed, `${name}/${anim.name} 第 ${fi} 帧绘制顺序`).toEqual(Array.from(key.order))
        })
      }
    })
  }
})

/**
 * 照抄 spine-core `SkeletonJson.readDrawOrder` 的还原算法：
 * 沿 setup 下标单向扫描，未出现在 offsets 里的槽按 setup 顺序回填剩余位置。
 * Unity 端 Hao2D 运行时在该算法里只往前走，所以任何「非升序 / 越界」的 entries 都会让它死循环或越界，
 * 这里顺便把这种情况直接暴露成断言失败。
 */
function replayDrawOrder(
  offsets: Array<{ slot: string; offset: number }> | undefined,
  slotNames: string[]
): number[] {
  const slotCount = slotNames.length
  const indexOf = new Map(slotNames.map((n, i) => [n, i]))
  const changes = offsets ?? []
  if (changes.length > slotCount) throw new Error(`drawOrder offsets 数量 ${changes.length} > 槽数 ${slotCount}`)
  const drawOrder = new Array<number>(slotCount).fill(-1)
  const unchanged = new Array<number>(slotCount - changes.length)
  let originalIndex = 0
  let unchangedIndex = 0
  for (const change of changes) {
    const index = indexOf.get(change.slot)
    if (index === undefined) continue
    while (originalIndex !== index) {
      if (originalIndex >= slotCount) throw new Error(`drawOrder offsets 非升序（Unity 端 Hao2D 运行时会死循环）：${change.slot}`)
      unchanged[unchangedIndex++] = originalIndex++
    }
    drawOrder[originalIndex + change.offset] = originalIndex++
  }
  for (; originalIndex < slotCount; ++originalIndex) unchanged[unchangedIndex++] = originalIndex
  for (let i = slotCount - 1; i >= 0; i--) if (drawOrder[i] === -1) drawOrder[i] = unchanged[--unchangedIndex]
  return drawOrder
}
