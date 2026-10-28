#!/usr/bin/env node
/**
 * 从**命令注册表**生成 Skill 的 `references/commands.md`，避免手抄命令表漂移。
 *
 * 为什么走 vite-node：命令定义是 TS + 路径别名（`@editor/*`、`@shared/*`），
 * 还会 `import ...?raw` 内联文档。普通 node 跑不了，这里复用 vitest 的 vite 配置，
 * 在 node 环境里 `installCommands()` + `catalog()`，拿到的就是编辑器 `GET /commands`
 * 返回的同一份自描述（唯一权威来源）。
 *
 * 用法（必须用 vite-node 跑，普通 node 不认路径别名）：
 *   npm run gen:skill-docs                          # 生成
 *   npm run check:skill-docs                        # 只校验是否最新（CI 用）
 *   npx vite-node --config vitest.config.ts scripts/gen-skill-commands.mjs --out /tmp/commands.md
 *
 * 改了命令（新增 / 改参数 / 改说明）后跑一次，再提交生成结果。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCommands } from '@editor/commands'
import { catalog } from '@editor/commands/registry'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const DEFAULT_OUT = resolve(repo, 'resources/skills/hao2d-skeletal-animation/references/commands.md')

/**
 * 分组：命令名 → 章节。没列到的落到「其它」，保证新命令不会从文档里消失。
 * 顺序 = 文档里的章节顺序（也是 AI 阅读顺序：先查状态、再建、再动画、最后导出）。
 */
const GROUPS = [
  {
    title: '状态与查询（开工前、收工后）',
    names: [
      'getProjectState', 'getHierarchy', 'listBones', 'listSlots', 'listDisplays', 'listImages',
      'listAnimations', 'listSkins', 'listConstraints', 'getAnimationKeys', 'getAttachmentVertices',
      'getDisplayWorldBounds', 'getBoneWorldTransform', 'getViewport', 'captureViewport',
      'getMask', 'listMasks', 'getSelection'
    ]
  },
  {
    title: '工程与素材',
    names: [
      'newProject', 'createProject', 'openProject', 'saveProject', 'setProjectName', 'importImages',
      'importImage', 'splitAtlas', 'importSpine', 'importDragonBones', 'replaceImage', 'deleteImage',
      'setExportScale'
    ]
  },
  {
    title: '骨骼',
    names: ['addBone', 'setBoneTransform', 'moveBone', 'deleteBone', 'renameNode']
  },
  {
    title: '插槽与附件',
    names: [
      'addSlot', 'setSlotProps', 'setSlotHost', 'setDrawOrder', 'moveSlot', 'deleteSlot', 'addDisplay',
      'setDisplayTransform', 'setAttachmentTransform', 'moveDisplay', 'deleteDisplay', 'addConstraint',
      'setConstraint', 'deleteConstraint'
    ]
  },
  {
    title: '网格与蒙皮',
    names: [
      'autoMeshFromImage', 'convertToMesh', 'convertToRegion', 'convertToOutlineMesh', 'autoWeightMesh',
      'bindWeightBone', 'unbindWeightBone', 'setVertexWeight', 'swapWeightBones', 'trimWeights',
      'redrawMeshBoundary', 'connectMeshVertices', 'insertMeshVertex', 'deleteMeshVertex', 'moveMeshVertex'
    ]
  },
  {
    title: '动画与关键帧（时间单位：秒，绝对时间点）',
    names: [
      'addAnimation', 'setAnimation', 'setActiveAnimation', 'setAnimationDuration', 'setAnimationFrames', 'renameAnimation',
      'removeAnimation', 'keyBoneFrame', 'keySlotDisplayFrame', 'keySlotColorFrame', 'keySlotVisibleFrame',
      'keyDrawOrderFrame', 'keyDeformFrame', 'keySlotSubArmatureFrame', 'keyEvent', 'setEvent', 'removeEvent',
      'moveKeyframe', 'setKeyframeEasing', 'clearTrack', 'clearAnimationKeys', 'removeBoneFrame',
      'removeDeformFrame', 'copyKeyframes', 'pasteKeyframes'
    ]
  },
  {
    title: '皮肤与换装',
    names: [
      'addSkin', 'renameSkin', 'removeSkin', 'setActiveSkin', 'createLinkedMesh', 'setLinkedMeshImage',
      'setLinkedMeshSource', 'unlinkLinkedMesh'
    ]
  },
  {
    title: '多骨架与嵌套',
    names: ['addSkeleton', 'removeSkeleton', 'renameSkeleton', 'setActiveSkeleton', 'nestArmature', 'setNestedArmature']
  },
  {
    title: '遮罩（Spine Clipping）',
    names: [
      'createMask', 'convertToMask', 'setMaskPoints', 'setMaskPoint', 'insertMaskPoint', 'deleteMaskPoint',
      'setMaskOptions'
    ]
  },
  {
    title: '视口、预览与导出',
    names: [
      'setMode', 'setTime', 'setPlaying', 'focusNode', 'fitViewport', 'panViewport', 'setViewportZoom',
      'centerViewport', 'setStage', 'updateStage', 'removeStage', 'exportProject', 'undo', 'redo',
      'beginTransaction', 'endTransaction', 'rollbackTransaction'
    ]
  },
  {
    title: '编辑器界面与剪贴板（AI 少用）',
    names: [
      'setSelection', 'setOverlay', 'setOnionSkin', 'setSmartFilter', 'setTimelineZoom', 'copyNodes',
      'pasteNodes', 'duplicateSelection', '__catalog'
    ]
  }
]

const OTHER_TITLE = '其它'

function groupOf(name) {
  for (const group of GROUPS) if (group.names.includes(name)) return group.title
  return OTHER_TITLE
}

/**
 * 一个参数压成一段：`` `bone`*(string) 宿主骨骼名；不传则挂根骨骼 ``
 * 参数说明不能省——「rotate 传数字」「空串 = 不显示」「offsets 长度 = 点数 × 2」这类
 * 关键约定全在参数描述里，表格里丢掉就等于把最容易踩的坑删了。
 */
function formatArg(name, spec) {
  const required = spec.required ? '*' : '?'
  let type = spec.type ?? 'any'
  if (Array.isArray(spec.values) && spec.values.length) type = spec.values.map((v) => `'${v}'`).join('|')
  const def = spec.default !== undefined ? `=${spec.default}` : ''
  const note = spec.description ? ` ${spec.description}` : ''
  return `\`${name}\`${required}(${type}${def})${note}`
}

function formatArgs(args) {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return '—'
  // `<br>` 让每个参数独占一行：一行塞 5 个参数在 markdown 里会糊成一片
  return entries.map(([name, spec]) => formatArg(name, spec)).join('<br>')
}

/** 表格单元格里不能有裸的 `|` 和换行 */
function cell(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function render(commands) {
  const byGroup = new Map()
  for (const command of commands) {
    const title = groupOf(command.name)
    if (!byGroup.has(title)) byGroup.set(title, [])
    byGroup.get(title).push(command)
  }
  const order = [...GROUPS.map((g) => g.title), OTHER_TITLE].filter((title) => byGroup.has(title))

  const lines = []
  lines.push('# Hao2DEditor 命令速查（骨骼动画相关）')
  lines.push('')
  lines.push('> 本文件由 `scripts/gen-skill-commands.mjs` 从**命令注册表**生成，不要手改；')
  lines.push('> 改了命令就跑 `npm run gen:skill-docs` 重新生成。')
  lines.push('>')
  lines.push('> 唯一权威来源是编辑器本身：`GET {url}/commands`（含每条的 `example` 与实时参数说明）。')
  lines.push('> 这里按「做动画时用到的顺序」重排过，方便当离线速查。')
  lines.push('> 所有命令统一返回 `{ ok, changed, data, message, error, label }`；`ok:false` 时读 `error`。')
  lines.push('')
  lines.push('参数写法：`名字`*(类型) 表示必填；`名字`?(类型=默认值) 表示可选；`\'a\'|\'b\'` 表示取值枚举。')
  lines.push('')
  lines.push(`共 ${commands.length} 条命令，分 ${order.length} 组。`)
  lines.push('')

  for (const title of order) {
    lines.push(`## ${title}`)
    lines.push('')
    lines.push('| 命令 | 参数 | 说明 | 返回 |')
    lines.push('| --- | --- | --- | --- |')
    for (const command of byGroup.get(title)) {
      lines.push(
        `| \`${command.name}\` | ${cell(formatArgs(command.args))} | ${cell(command.description)} | ${cell(
          command.returns ?? '—'
        )} |`
      )
    }
    lines.push('')
  }

  lines.push('## 批量调用形状')
  lines.push('')
  lines.push('```json')
  lines.push('POST /batch')
  lines.push('{')
  lines.push('  "transaction": true,')
  lines.push('  "label": "搭骨架",')
  lines.push('  "commands": [')
  lines.push('    { "name": "addBone", "args": { "name": "root" } },')
  lines.push('    { "name": "addBone", "args": { "name": "hip", "parent": "root", "localPosition": { "x": 0, "y": 1.0 } } }')
  lines.push('  ]')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('- 顺序执行，后面的命令能看到前面的结果')
  lines.push('- `transaction: true` → 一条撤销记录；任一条失败 → 整体回滚，不留半套状态')
  lines.push('- 整批无改动同样回滚，不留空记录')
  lines.push('- 单批 ≤ 约 30 条（撤销栈只有 80 条）')
  lines.push('')
  return lines.join('\n')
}

function argValue(flag, fallback) {
  const at = process.argv.indexOf(flag)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

installCommands()
const commands = catalog()
if (commands.length === 0) {
  console.error('注册表是空的：installCommands() 没生效？')
  process.exit(1)
}

const out = resolve(argValue('--out', DEFAULT_OUT))
const markdown = render(commands)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(out, 'utf8')
  } catch {
    console.error(`缺少 ${out}，请先跑 npm run gen:skill-docs`)
    process.exit(1)
  }
  if (current !== markdown) {
    console.error(`已过期：${out}\n命令改了但没重新生成，跑 npm run gen:skill-docs`)
    process.exit(1)
  }
  console.log(`最新：${out}（${commands.length} 条命令）`)
  process.exit(0)
}

writeFileSync(out, markdown, 'utf8')
console.log(`已生成 ${out}（${commands.length} 条命令）`)
