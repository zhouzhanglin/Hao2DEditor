import { useModeStore } from '../store/modeStore'
import { createLinkedMesh, setLinkedMeshImage, setLinkedMeshSource, unlinkLinkedMesh } from './authoringCommands'
import { changed, defineWrite } from './registry'
import { need, optText } from './args'
import { t } from '@i18n'

/**
 * LinkedMesh（链接网格）命令：不同皮肤复用同一份网格几何，只换贴图。
 *
 * 与网格命令一样属于**绑定数据**改动，Animate 态一律拒绝 —— 动画态只该写关键帧，
 * 偷偷改 setup 会让动画基线被污染。
 */

/** 拒绝在 Animate 态改绑定数据（与 meshCommands 同一套口径） */
function requirePose(action: string): void {
  if (useModeStore.getState().mode === 'pose') return
  throw new Error(t('{0}改的是绑定数据：先 setMode 切到 pose（Animate 态只动关键帧）', action))
}

export function registerLinkedMeshCommands(): void {
  defineWrite(
    {
      name: 'createLinkedMesh',
      title: '新建链接网格',
      description:
        '在目标皮肤里创建一条链接网格：几何（顶点 / 三角面 / 权重）取自同插槽的源网格，自己只决定贴图与 UV。附件名与源同名 = 覆盖该插槽的显示（换装标准写法），异名 = 追加一个 display',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        source: { type: 'string', description: '源网格附件名（同插槽，必须是 mesh）', required: true },
        skin: { type: 'string', description: '目标皮肤；不传 = 默认皮肤' },
        sourceSkin: { type: 'string', description: '源皮肤；不传 = 默认皮肤' },
        name: { type: 'string', description: '附件名；不传沿用源网格名（同名覆盖该插槽显示）' },
        image: { type: 'string', description: '自己的图片（图片池里的名字）；不传沿用源网格的图' }
      },
      returns: '{ slot, attachment, warning? }',
      example: { slot: 'front-foot', source: 'front-foot', sourceSkin: 'default', skin: 'goblin', image: 'goblin.png' }
    },
    (draft, args) => {
      requirePose(t('新建链接网格'))
      const result = createLinkedMesh(draft, {
        slot: need(args, 'slot'),
        source: need(args, 'source'),
        ...compact({ skin: optText(args, 'skin'), sourceSkin: optText(args, 'sourceSkin'), name: optText(args, 'name'), image: optText(args, 'image') })
      })
      if (!result.ok) throw new Error(result.reason)
      return changed(
        {
          slot: result.slot,
          attachment: result.attachment,
          ...(result.warning ? { warning: result.warning } : {})
        },
        result.warning ?? t('已创建链接网格：{0} / {1}', [result.slot, result.attachment])
      )
    }
  )

  defineWrite(
    {
      name: 'setLinkedMeshSource',
      title: '改链接网格的源',
      description:
        '把链接网格换成另一个源皮肤 / 源网格，改完按新源重算 UV。源必须是同插槽的网格（不能是链接网格本身）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '链接网格附件名', required: true },
        source: { type: 'string', description: '新源网格附件名', required: true },
        skin: { type: 'string', description: '链接网格自己所在的皮肤；不传 = 默认皮肤' },
        sourceSkin: { type: 'string', description: '新源皮肤；不传 = 默认皮肤' }
      },
      returns: '{ slot, attachment, warning? }'
    },
    (draft, args) => {
      requirePose(t('修改链接源'))
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const result = setLinkedMeshSource(draft, {
        slot,
        attachment,
        source: need(args, 'source'),
        ...compact({ skin: optText(args, 'skin'), sourceSkin: optText(args, 'sourceSkin') })
      })
      if (!result.ok) throw new Error(result.reason)
      return changed(
        { slot, attachment, ...(result.warning ? { warning: result.warning } : {}) },
        result.warning ?? t('已把「{0}」的源网格改成「{1}」', [attachment, need(args, 'source')])
      )
    }
  )

  defineWrite(
    {
      name: 'setLinkedMeshImage',
      title: '给链接网格换图',
      description:
        '只改这一条链接网格的图片（不会动同名源网格），并按新图的区域重算 UV；新图里找不到区域时 UV 清空，运行期退回源网格那块',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '链接网格附件名', required: true },
        image: { type: 'string', description: '新图片（图片池里的名字）', required: true },
        skin: { type: 'string', description: '链接网格自己所在的皮肤；不传 = 默认皮肤' }
      },
      returns: '{ slot, attachment, warning? }'
    },
    (draft, args) => {
      requirePose(t('给链接网格换图'))
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const image = need(args, 'image')
      const result = setLinkedMeshImage(draft, {
        slot,
        attachment,
        image,
        ...compact({ skin: optText(args, 'skin') })
      })
      if (!result.ok) throw new Error(result.reason)
      return changed(
        { slot, attachment, ...(result.warning ? { warning: result.warning } : {}) },
        result.warning ?? t('已把「{0}」换成图片「{1}」', [attachment, image])
      )
    }
  )

  defineWrite(
    {
      name: 'unlinkLinkedMesh',
      title: '解链为独立网格',
      description:
        '把源网格的几何 / 权重 / UV 深拷贝到自己名下，变成普通网格；之后源网格的变化不再影响它。顶点数不变，原有 FFD 关键帧仍然有效',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '链接网格附件名', required: true },
        skin: { type: 'string', description: '链接网格自己所在的皮肤；不传 = 默认皮肤' }
      },
      returns: '{ slot, attachment, vertices, triangles }'
    },
    (draft, args) => {
      requirePose(t('解链为独立网格'))
      const result = unlinkLinkedMesh(draft, {
        slot: need(args, 'slot'),
        attachment: need(args, 'attachment'),
        ...compact({ skin: optText(args, 'skin') })
      })
      if (!result.ok) throw new Error(result.reason)
      return changed(
        {
          slot: result.slot,
          attachment: result.attachment,
          vertices: result.vertices,
          triangles: result.triangles
        },
        t('已解链为独立网格：{0} / {1}（{2} 顶点）', [result.slot, result.attachment, result.vertices])
      )
    }
  )
}

/** 丢掉空串字段：命令参数里没传的和传空串语义相同，别把 undefined 带进 Options */
function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue
    out[key as keyof T] = value as T[keyof T]
  }
  return out
}
