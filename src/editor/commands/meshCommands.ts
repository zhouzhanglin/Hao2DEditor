import { rootBoneName } from '@core/model/authoring'
import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import {
  addWeightBone,
  autoGenerateRegionMesh,
  autoWeights,
  convertMeshToRegion,
  convertRegionToMesh,
  deleteMeshVertex,
  insertMeshVertex,
  meshVertexSamples,
  removeWeightBone,
  resolveAttachment,
  setVertexWeight
} from './authoringCommands'
import type { VertexSample } from './authoringCommands'
import { changed, defineAction, defineWrite } from './registry'
import type { Args } from './registry'
import { need, needNum, optNum, optTextList, optVec } from './args'
import { connectMeshVertices, rebuildMeshBoundary } from '../tools/authoringTools'
import type { Vec2 } from '@core/math/matrix'
import type { AlphaMask } from '@core/mesh/autoMesh'
import { getPlatform } from '../platform'
import { loadImageBitmap } from '../services/pngEncoder'

/**
 * 网格与蒙皮命令：转网格、编辑顶点、绑骨骼、刷权重。
 *
 * 分两类：
 *
 * - **纯文档操作**（转网格、插 / 删顶点、直接设权重、绑 / 解绑骨骼）：走 `defineWrite`，
 *   参数里的坐标是**附件局部坐标** —— 与 `getAttachmentVertices` 读出来的顶点坐标同一套，
 *   AI 读完就能算，不需要懂世界矩阵。
 * - **需要视口数据**（自动权重）：走 `defineAction`。自动权重必须知道每个顶点的**世界坐标**
 *   才能算「离哪根骨骼近」，这份数据只存在于渲染中的网格里。
 *   所以这类命令在窗口没画完第一帧时会明确报错，而不是悄悄算错。
 *
 * 画笔式刷权重（鼠标拖动那种）**没有**开放给 AI：它需要世界坐标的连续命中测试，
 * 收益远不如「直接设权重 + 自动权重」的组合。AI 应当用 setVertexWeight 精确写入。
 */

/** 收集某个附件的顶点样本（世界坐标），依赖场景里的运行期网格 */
function samplesFor(slot: string, attachment: string): VertexSample[] {
  const scene = getActiveScene()
  const bundle = scene?.runtime
  const mesh = scene?.meshResult
  if (!scene || !bundle || !mesh) return []
  return meshVertexSamples(mesh, (slotIndex, vertex) => {
    const slotData = bundle.asset.slots[slotIndex]
    if (!slotData) return null
    const display = bundle.skeleton.slotDisplayIndex[slotIndex]
    const current = scene.attachmentAt(slotIndex, display)
    if (!current) return null
    if (slotData.name !== slot || current.name !== attachment) return null
    return { slot: slotData.name, attachment: current.name, vertex }
  })
}

/** 把骨骼名换成自动权重需要的「世界空间线段」 */
function boneSegments(names: readonly string[]): Array<{ name: string; ax: number; ay: number; bx: number; by: number }> {
  const scene = getActiveScene()
  if (!scene) return []
  const document = useProjectStore.getState().document
  const segments: Array<{ name: string; ax: number; ay: number; bx: number; by: number }> = []
  for (const name of names) {
    const matrix = scene.worldMatrixOf(name)
    const bone = document.bones.find((item) => item.name === name)
    if (!matrix || !bone) continue
    const ax = matrix[12]
    const ay = matrix[13]
    // 骨骼的 x 轴方向就是矩阵第一列；顶点到这条线段的距离决定它吃多少权重
    const angle = Math.atan2(matrix[1], matrix[0])
    const length = Math.max(0.001, bone.length)
    segments.push({ name, ax, ay, bx: ax + Math.cos(angle) * length, by: ay + Math.sin(angle) * length })
  }
  return segments
}

/**
 * 把一张图片解码成逐像素 alpha 遮罩（行优先，y=0 在顶部），供 autoMeshFromImage 生成轮廓。
 * 复用与拾取缓存同一套解码（loadImageBitmap + canvas），只在渲染进程可用（需要 document/canvas）。
 */
async function imageAlphaMask(imagePath: string): Promise<AlphaMask | null> {
  const platform = getPlatform()
  const url = await platform.imageUrl(imagePath)
  const bitmap = await loadImageBitmap(url)
  if (!bitmap) return null
  const width = bitmap.width
  const height = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(bitmap, 0, 0)
  const pixels = context.getImageData(0, 0, width, height).data
  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]
  if ('close' in bitmap) (bitmap as ImageBitmap).close()
  return { width, height, alpha }
}

export function registerMeshCommands(): void {
  defineWrite(
    {
      name: 'convertToMesh',
      title: '转网格',
      description:
        '把图片附件转成可形变的网格（divisions 决定栅格密度，2 就是 2×2 网格）。转完才能打 FFD 帧、才能刷权重',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        divisions: { type: 'number', description: '栅格细分数，默认 2', default: 2 }
      },
      returns: '{ slot, attachment, vertices, triangles }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const divisions = Math.max(1, Math.min(16, Math.round(optNum(args, 'divisions') ?? 2)))
      const result = convertRegionToMesh(draft, slot, attachment, divisions)
      if (!result) {
        throw new Error(`转不了：${slot} / ${attachment} 不是图片（Region）附件（已经转过网格，或用 listDisplays 看它的 type）`)
      }
      return changed({ slot, attachment, ...result }, `已转为网格：${result.vertices} 顶点 / ${result.triangles} 三角形`)
    }
  )

  defineAction(
    {
      name: 'autoMeshFromImage',
      title: '按图片轮廓自动生成网格',
      description:
        '把 Region 附件（碎图）按不透明像素轮廓自动生成贴合的多边形网格，透明区不占三角形，比 convertToMesh 更省顶点、更贴合图形。需要视口已就绪（取图片像素）。divisions 控制顶点数量级，默认 8',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名（Region）', required: true },
        divisions: { type: 'number', description: '细分数（顶点数量级），默认 8', default: 8 }
      },
      returns: '{ slot, attachment, vertices, triangles, coverage }'
    },
    async (args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const document = useProjectStore.getState().document
      const att = resolveAttachment(document, slot, attachment)
      if (!att) throw new Error(`找不到附件 ${slot} / ${attachment}（用 listDisplays 查）`)
      if (att.type !== 'region' && !(att.type === 'mesh' && att.regionSnapshot)) {
        throw new Error('只能对 Region 附件（或带快照的网格）用：先用 addDisplay 加碎图，或 convertToRegion 还原')
      }
      const image = document.images.find((item) => item.name === att.image)
      if (!image) throw new Error(`附件引用的图片「${att.image}」不在图片池（先用 importImage 导入）`)
      const mask = await imageAlphaMask(image.path)
      if (!mask) throw new Error(`读不到图片「${image.name}」的像素，无法生成轮廓`)
      const divisions = Math.max(1, Math.min(64, Math.round(optNum(args, 'divisions') ?? 8)))
      let result: { vertices: number; triangles: number; coverage: number } | null = null
      const committed = useProjectStore.getState().runCommand('AI：按轮廓生成网格', (draft) => {
        result = autoGenerateRegionMesh(draft, slot, attachment, mask, divisions)
        return result !== null
      })
      if (!committed || !result) {
        throw new Error('生成网格失败：附件不是有效的 Region / 网格，或图片没有不透明像素')
      }
      const scene = getActiveScene()
      if (scene) {
        const next = useProjectStore.getState().document
        scene.setDocument(next, next.editorMeta.activeSkin)
        scene.refresh()
      }
      return changed(
        { slot, attachment, ...result },
        `已生成轮廓网格：${result.vertices} 顶点 / ${result.triangles} 三角形（覆盖率 ${Math.round(result.coverage * 100)}%）`
      )
    }
  )

  defineWrite(
    {
      name: 'convertToRegion',
      title: '转回图片',
      description: '把网格转回普通图片附件（会丢掉顶点与权重）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true }
      },
      returns: '{ slot, attachment }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      if (!convertMeshToRegion(draft, slot, attachment)) {
        throw new Error(`转不了：${slot} / ${attachment} 不是网格（用 listDisplays 看它的 type）`)
      }
      return changed({ slot, attachment }, `已把 ${slot} / ${attachment} 转回图片`)
    }
  )

  defineWrite(
    {
      name: 'insertMeshVertex',
      title: '插入网格顶点',
      description:
        '在网格的一条边上插入顶点并自动重连三角形。point 用**附件局部坐标**（与 getAttachmentVertices 读出来的一致），必须落在大致落在某条边上',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        point: { type: 'object', description: '插入位置（附件局部坐标 {x,y}）', required: true }
      },
      returns: '{ slot, attachment, vertexIndex }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const point = optVec(args, 'point')
      if (!point) throw new Error('缺少参数 point（附件局部坐标 {x,y}）')
      const index = insertMeshVertex(draft, slot, attachment, point)
      if (index === null) {
        throw new Error(
          '插不进去：目标不是网格，或者点位不在任何一条边上（顶点只能插在边上 —— 先读 getAttachmentVertices 拿现有顶点坐标）'
        )
      }
      return changed({ slot, attachment, vertexIndex: index }, `已在边上插入顶点（新下标 ${index}）`)
    }
  )

  defineWrite(
    {
      name: 'deleteMeshVertex',
      title: '删除网格顶点',
      description: '删除网格上的一个顶点（只剩 3 个顶点时不允许再删）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        vertexIndex: { type: 'number', description: '顶点下标', required: true }
      },
      returns: '{ slot, attachment, vertexIndex }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const vertexIndex = needNum(args, 'vertexIndex')
      if (!deleteMeshVertex(draft, slot, attachment, vertexIndex)) {
        throw new Error('删不掉：目标不是网格、下标越界，或者删完会只剩不到 3 个顶点')
      }
      return changed({ slot, attachment, vertexIndex }, `已删除顶点 ${vertexIndex}`)
    }
  )

  defineWrite(
    {
      name: 'bindWeightBone',
      title: '绑定权重骨骼',
      description: '把一个网格附件绑到某根骨骼（让它出现在权重候选里，不影响已有权重）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        bone: { type: 'string', description: '骨骼名', required: true }
      },
      returns: '{ slot, attachment, bone }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const bone = need(args, 'bone')
      if (!addWeightBone(draft, slot, attachment, bone)) {
        throw new Error('绑不上：目标不是网格、骨骼名不存在，或者它已经被绑过了')
      }
      return changed({ slot, attachment, bone }, `已把 ${slot} / ${attachment} 绑到骨骼 ${bone}`)
    }
  )

  defineWrite(
    {
      name: 'unbindWeightBone',
      title: '解绑权重骨骼',
      description: '解绑一根权重骨骼，并把它在所有顶点上的权重清零',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        bone: { type: 'string', description: '骨骼名', required: true }
      },
      returns: '{ slot, attachment, bone }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const bone = need(args, 'bone')
      if (!removeWeightBone(draft, slot, attachment, bone)) {
        throw new Error('解绑不了：目标不是网格，或者它本来就没绑这根骨骼')
      }
      return changed({ slot, attachment, bone }, `已解绑骨骼 ${bone}`)
    }
  )

  defineWrite(
    {
      name: 'setVertexWeight',
      title: '设置顶点权重',
      description:
        '精确写入一个顶点在某根骨骼上的权重（0~1）。骨骼不存在时会自动绑上。所有权重不足 1 的部分会归到宿主骨骼',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        vertexIndex: { type: 'number', description: '顶点下标', required: true },
        bone: { type: 'string', description: '骨骼名', required: true },
        weight: { type: 'number', description: '权重 0~1', required: true }
      },
      returns: '{ slot, attachment, vertexIndex, bone, weight }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const vertexIndex = needNum(args, 'vertexIndex')
      const bone = need(args, 'bone')
      const weight = needNum(args, 'weight')
      if (weight < 0 || weight > 1) throw new Error(`weight 必须在 0 ~ 1 之间，收到 ${weight}`)
      if (!setVertexWeight(draft, slot, attachment, vertexIndex, bone, weight)) {
        throw new Error('写不进去：目标不是网格、顶点下标越界，或者骨骼名不存在')
      }
      return changed(
        { slot, attachment, vertexIndex, bone, weight },
        `顶点 ${vertexIndex} 对骨骼 ${bone} 的权重已设为 ${weight}`
      )
    }
  )

  defineAction(
    {
      name: 'autoWeightMesh',
      title: '自动权重',
      description:
        '按「顶点离哪根骨骼近」自动分配权重（这是 AI 蒙皮的主力命令）。不传 bones 就用除层级根之外的全部骨骼。需要视口已就绪',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        bones: { type: 'array', description: '参与加权的骨骼名数组；不传则用除层级根外的全部骨骼' },
        falloff: { type: 'number', description: '距离衰减指数，越大越「硬」，默认 2', default: 2 },
        maxBones: { type: 'number', description: '每个顶点最多绑几根骨骼（最多 4），默认 4', default: 4 }
      },
      returns: '{ slot, attachment, touched, bones }'
    },
    (args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const scene = getActiveScene()
      if (!scene) {
        throw new Error('视口还没就绪，取不到顶点的世界坐标。等编辑器窗口画完一帧再试')
      }
      const samples = samplesFor(slot, attachment)
      if (samples.length === 0) {
        throw new Error(
          `取不到 ${slot} / ${attachment} 的顶点样本：确认它是网格、并且在当前显示的附件就是它（getAttachmentVertices 可以核对）`
        )
      }
      const document = useProjectStore.getState().document
      const requested = optTextList(args, 'bones') ?? document.bones.map((bone) => bone.name).filter(Boolean)
      const segments = boneSegments(requested.filter((name) => name !== rootBoneName(document.bones)))
      if (segments.length === 0) {
        throw new Error('没有可用的骨骼参与加权（层级根骨骼不参与，不然每个顶点都会被它抢走）')
      }
      const falloff = Math.max(1, Math.round(optNum(args, 'falloff') ?? 2))
      const maxBones = Math.max(1, Math.min(4, Math.round(optNum(args, 'maxBones') ?? 4)))
      let touched = 0
      const committed = useProjectStore.getState().runCommand('AI：自动权重', (draft) => {
        touched = autoWeights(draft, samples, segments, { falloff, maxBones })
        return touched > 0
      })
      if (!committed) return { changed: false, message: '没有顶点被改动' }
      // 权重是运行期算蒙皮矩阵时读的，写完必须把文档推回场景再重画
      const next = useProjectStore.getState().document
      scene.setDocument(next, next.editorMeta.activeSkin)
      scene.refresh()
      return changed(
        { slot, attachment, touched, bones: segments.map((segment) => segment.name) },
        `自动权重完成：${touched} 个顶点分到了 ${segments.length} 根骨骼上`
      )
    }
  )

  defineWrite(
    {
      name: 'redrawMeshBoundary',
      title: '重绘网格边界',
      description:
        '用一串依次点击的轮廓点（附件局部坐标）整块重画网格外边界：丢弃旧顶点、清空绑定权重与该附件的 FFD 关键帧，并重新三角化。首尾会自动闭合，至少需要 3 个点',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        points: {
          type: 'array',
          description: '依次点击的轮廓点 [{x,y}…]（附件局部坐标，与 getAttachmentVertices 一致）',
          required: true
        }
      },
      returns: '{ slot, attachment, vertices, triangles }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const points = parsePoints(args, 'points')
      if (points.length < 3) throw new Error('points 至少需要 3 个点才能围成一圈边界')
      const result = rebuildMeshBoundary(draft, slot, attachment, points)
      if (!result) {
        throw new Error(`重绘不了：${slot} / ${attachment} 不是网格（用 listDisplays 看它的 type），或 points 不足以围成闭合多边形`)
      }
      return changed(
        { slot, attachment, ...result },
        `已按 ${points.length} 个点重绘边界：${result.vertices} 顶点 / ${result.triangles} 三角形（旧权重与 FFD 已清空）`
      )
    }
  )

  defineWrite(
    {
      name: 'connectMeshVertices',
      title: '连线重布网格',
      description:
        '在网格的两个顶点之间连一条线（自定义布线）：沿这条线段把横穿的三角形重新三角化，其余区域不变。from / to 是顶点下标（用 getAttachmentVertices 取）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格附件名', required: true },
        from: { type: 'number', description: '起点顶点下标', required: true },
        to: { type: 'number', description: '终点顶点下标', required: true }
      },
      returns: '{ slot, attachment, from, to }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const from = needNum(args, 'from')
      const to = needNum(args, 'to')
      if (!connectMeshVertices(draft, slot, attachment, from, to)) {
        throw new Error(
          `连不上：两点相同 / 下标越界 / 目标不是网格，或这条线段没有横穿网格内部（已经连着线、或正好擦过顶点都会连不通）。用 getAttachmentVertices 核对下标`
        )
      }
      return changed({ slot, attachment, from, to }, `已在顶点 #${from} 与 #${to} 之间连上线`)
    }
  )
}

/** 解析一组 {x,y} 点：来自 AI 的 JSON 数组，形状不对就给出能看懂的报错 */
function parsePoints(args: Args, key: string): Vec2[] {
  const value = args[key]
  if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是点数组 [{x,y}…]`)
  const points: Vec2[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`参数 ${key} 里每项必须是 {x,y}`)
    }
    const { x, y } = item as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`参数 ${key} 里的点 x / y 必须是数字`)
    }
    points.push({ x, y })
  }
  return points
}
