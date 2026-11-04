import { useState } from 'react'
import { Crosshair, Grid3x3, Link2, RotateCcw, Trash2 } from 'lucide-react'
import { t } from '@i18n'
import { BlendMode } from '@core/model/types'
import { curvePercent } from '@core/anim/interpolation'
import { usePreviewStore } from '@editor/store/previewStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import type { BrushModeSetting } from '@editor/store/toolStore'
import { useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useThrottledPlayheadTime } from '@editor/store/playheadStore'
import { getActiveScene } from '@editor/activeScene'
import { useRevealStore } from '@editor/store/revealStore'
import { keyBoneChannel, keySlotDisplay, keySlotVisible } from '@editor/commands/animationCommands'
import {
  applyRename,
  checkRename,
  convertAttachmentToClipping,
  convertMeshToRegion,
  copyVertexWeights,
  countOverInfluenced,
  deleteAttachment,
  deleteMeshVertex,
  pasteVertexWeights,
  patchAttachment,
  patchAttachmentInSkin,
  PPU,
  previewTrimWeights,
  removeWeightBone,
  resolveAttachment,
  setLinkedMeshImage,
  setLinkedMeshSource,
  setVertexWeight,
  swapWeightBones,
  trimVertexWeights,
  unlinkLinkedMesh,
  weightBonesOf
} from '@editor/commands/authoringCommands'
import type { AutoWeightMethod } from '@editor/commands/authoringCommands'
import { resolveAuthoringLinkedMesh } from '@core/skin/linkedMesh'
import { runAutoWeightsForBones } from '@editor/tools/authoringTools'
import { buildGridMesh, buildOutlineMesh } from '@editor/commands/meshActions'
import type { RenameKind } from '@editor/commands/authoringCommands'
import type { AuthoringAttachment, AuthoringConstraint, EditorDocument } from '@core/model/authoring'
import { rootBoneName } from '@core/model/authoring'
import { isDescendantOf } from '@editor/commands/hierarchyCommands'
import { weightPaletteColor } from '@core/weightPalette'
import {
  CheckboxField,
  ColorField,
  CommitTextField,
  FieldGroup,
  NumberField,
  PX_PER_UNIT,
  SelectField,
  SliderField,
  TextField,
  ToggleField,
  unitsToPx,
  Vector2Field
} from '@ui/widgets/fields'
import { InfoHint } from '@ui/widgets/InfoHint'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { blendOptions, constraintLabel } from '@ui/widgets/constants'

export interface InspectorPanelProps {
  onStatus?: (text: string) => void
}

/** 关键帧轨道（带 time / value / easing）的最小结构，用于属性面板回显当前时间的动画值 */
interface KeyLike<T> {
  time: number
  value: T
  easing: number
  curve: number[] | null
}

/**
 * 从动画轨道采样当前时间的值，供 Animate 态的属性面板回显。
 * 轨道为空（该骨骼还没打过帧）时回退到绑定姿态，与运行时「未打帧用 setup」的语义一致。
 */
function sampleVec2Keys(
  keys: ReadonlyArray<KeyLike<{ x: number; y: number }>> | undefined,
  time: number,
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (!keys || keys.length === 0) return fallback
  let index = -1
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].time <= time) index = i
    else break
  }
  if (index < 0) return fallback
  const a = keys[index]
  if (index >= keys.length - 1) return a.value
  const b = keys[index + 1]
  const span = b.time - a.time
  const t = span <= 0 ? 1 : curvePercent(a.easing, a.curve, (time - a.time) / span)
  return { x: a.value.x + (b.value.x - a.value.x) * t, y: a.value.y + (b.value.y - a.value.y) * t }
}

function sampleNumberKeys(
  keys: ReadonlyArray<KeyLike<number>> | undefined,
  time: number,
  fallback: number
): number {
  if (!keys || keys.length === 0) return fallback
  let index = -1
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].time <= time) index = i
    else break
  }
  if (index < 0) return fallback
  const a = keys[index]
  if (index >= keys.length - 1) return a.value
  const b = keys[index + 1]
  const span = b.time - a.time
  const t = span <= 0 ? 1 : curvePercent(a.easing, a.curve, (time - a.time) / span)
  return a.value + (b.value - a.value) * t
}

/**
 * 寄宿在某根骨骼上的约束：IK = 目标骨，变换 / 路径 = 第一根被驱动骨。
 * 与层级树行尾徽标同一口径（见 HierarchyTree 的 constraintHost）；物理约束不寄宿，仍在「约束」页。
 */
function hostedConstraints(document: EditorDocument, boneName: string): AuthoringConstraint[] {
  return document.constraints.filter((constraint) => {
    if (constraint.type === 'physics') return false
    return (constraint.type === 'ik' ? constraint.target : constraint.bones[0] ?? '') === boneName
  })
}

/** 删除约束并清掉动画里的约束轨道（与层级树右键删除同一段逻辑） */
function removeConstraint(
  update: (label: string, mutate: (draft: EditorDocument) => void) => void,
  name: string
): void {
  update(t('删除约束'), (draft) => {
    draft.constraints = draft.constraints.filter((c) => c.name !== name)
    for (const animation of draft.animations) {
      animation.constraints = animation.constraints.filter((t) => t.constraint !== name)
    }
  })
}

/**
 * 单条约束的编辑器 —— 两个入口共用同一份字段，避免「改了这边忘了那边」：
 * - 检查器的「约束」页（selection.kind === 'constraint'，从时间轴轨道 / 根层孤儿行进入）
 * - 宿主骨骼面板的内嵌分组（合并显示后 IK / 变换 / 路径约束寄在宿主行上）
 *
 * `embedded` = 内嵌形态：省去名称与顺序（那是「约束对象」的元信息，由专用页维护），
 * 标题带上约束名、标题栏右侧给删除按钮 —— 树里已经没有约束行，这是合并显示后的删除入口。
 * `nameField` / `orderField` 由专用页传入（重命名要联动选中态，闭包留在主组件里）。
 */
function ConstraintEditor({
  document,
  constraint,
  update,
  revealBone,
  nameField,
  orderField,
  embedded = false,
  onDelete
}: {
  document: EditorDocument
  constraint: AuthoringConstraint
  update: (label: string, mutate: (draft: EditorDocument) => void) => void
  revealBone: (name: string) => void
  nameField?: React.ReactNode
  orderField?: React.ReactNode
  embedded?: boolean
  onDelete?: () => void
}) {
  /** 受约束骨骼链（IK 按「链根 → 链尾」顺序驱动，顺序直接影响求解结果） */
  const chainBones = constraint.bones
  const chainCandidates = document.bones.filter((bone) => !chainBones.includes(bone.name))
  const targetBoneExists = constraint.target !== '' && document.bones.some((bone) => bone.name === constraint.target)
  /** 约束的自称（IK / 变换 / 路径），用在下面「…不会生效」之类的提醒里 */
  const kindLabel = constraintLabel(constraint.type)

  /** 「目标」的写入口：下拉选择与「从层级树拖骨骼进来」共用（拖进来的骨骼一定存在） */
  const setTargetBone = (name: string): void => {
    if (name === constraint.target) return
    update(t('修改约束目标'), (draft) => {
      const item = draft.constraints.find((c) => c.name === constraint.name)
      if (item) item.target = name
    })
  }

  /** 「定位到目标骨骼」：层级树滚到它并闪一下（目标常挂在脚 / 手这些离得远的部位） */
  const locateTargetBone = (): void => {
    if (targetBoneExists) revealBone(constraint.target)
  }

  const editChain = (label: string, mutate: (bones: string[]) => void): void => {
    update(label, (draft) => {
      const item = draft.constraints.find((c) => c.name === constraint.name)
      if (item) mutate(item.bones)
    })
  }

  /**
   * IK 混合（「权重」滑杆）的写入口。
   *
   * 拖动期间是高频写入，必须走不记历史的 `updateSilent` —— 撤销事务由滑杆自己按下时开、
   * 松开时收尾，整段拖动只留一条记录；键盘微调 / 数字框提交走普通 `update`。
   */
  const editIkMix = (value: number, silent: boolean): void => {
    const mutate = (draft: EditorDocument): void => {
      const item = draft.constraints.find((c) => c.name === constraint.name)
      if (item && item.type === 'ik') item.mix = value
    }
    if (silent) useProjectStore.getState().updateSilent(mutate)
    else update(t('修改IK权重'), mutate)
  }

  /** 链内换位：越靠前越接近链根，越靠后越接近链尾 */
  const moveChainBone = (from: number, to: number) => (): void => {
    editChain(t('调整受约束骨骼顺序'), (bones) => {
      if (from < 0 || from >= bones.length || to < 0 || to >= bones.length) return
      const [moved] = bones.splice(from, 1)
      bones.splice(to, 0, moved)
    })
  }

  return (
    <>
      <FieldGroup
        title={
          embedded
            ? t('{0}约束 · {1}', [constraintLabel(constraint.type), constraint.name])
            : t('{0}约束', constraintLabel(constraint.type))
        }
      >
        {nameField}
        {orderField}
        <ToggleField
          label={t('启用')}
          value={constraint.enabled}
          onChange={(value) => update(t('启停约束'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item) item.enabled = value })}
        />
        {/*
          内嵌的 IK 不显示「目标」：目标就是宿主骨骼本身（「目标骨即 IK 节点」）。
          要把 IK 挪到别的骨上，走「约束」页（时间轴轨道点进去）或删了重配
        */}
        {(!embedded || constraint.type !== 'ik') ? (
          <SelectField
            label={t('目标')}
            value={constraint.target}
            options={[{ value: '', label: t('（无）') }, ...document.bones.map((b) => ({ value: b.name, label: b.name }))]}
            onChange={setTargetBone}
            onDropBone={setTargetBone}
            trailing={
              <button
                type="button"
                disabled={!targetBoneExists}
                title={
                  targetBoneExists
                    ? t('在层级树里定位「{0}」', constraint.target)
                    : t('还没有可定位的目标骨骼')
                }
                className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-content-lo transition-colors duration-panel hover:bg-white/[0.14] hover:text-content-hi disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-content-lo"
                onClick={locateTargetBone}
              >
                <Crosshair size={13} />
              </button>
            }
          />
        ) : null}
        {/*
          「静默失效」的坑 —— 求解器遇到这些情况**直接返回**，视口里看不出任何异常，
          只能在这里就地提醒（比等编译告警直观）：
          - IK / 变换：必须有目标骨，且被驱动链非空；
          - 路径：目标骨 + 被约束骨骼连成折线，**至少 2 个点**才谈得上排布（只选一根骨又没目标 = 永远不生效）；
          - 物理：本来就不参与求解，不在此列。
        */}
        {constraint.type === 'path' ? (
          chainBones.length + (targetBoneExists ? 1 : 0) < 2 ? (
            <span className="text-3xs text-warn">
              {t('路径约束至少要有 2 个点（目标骨 + 被约束骨骼），当前只有 {0} 个，不会生效', chainBones.length + (targetBoneExists ? 1 : 0))}
            </span>
          ) : null
        ) : constraint.type !== 'physics' ? (
          <>
            {!targetBoneExists ? (
              <span className="text-3xs text-warn">
                {constraint.target
                  ? t('目标骨骼「{0}」不存在，{1} 不会生效', [constraint.target, kindLabel])
                  : t('没有目标骨骼，{0} 不会生效', [kindLabel])}
              </span>
            ) : null}
            {chainBones.length === 0 ? (
              <span className="text-3xs text-warn">{t('受约束骨骼链是空的，{0} 不会生效', [kindLabel])}</span>
            ) : null}
          </>
        ) : null}
        <div className="flex flex-col gap-1">
          <span className="text-3xs text-content-lo">
            {t('受约束骨骼链（')}
            {/*
              求解器对任何非空链都生效：单骨 = 让链尾指向目标（CCD），两骨走解析解，
              更长的链走 CCD 迭代。原来写「至少要两根」与实现不符（单骨也能求解）。
            */}
            {constraint.type === 'ik' ? t('链根 → 链尾，IK 按这个顺序驱动（单骨 = 让链尾指向目标，两骨及以上逐节弯曲）') : t('按顺序排布')}
            {t('）')}
            {constraint.type === 'physics' ? t(' · 物理约束只作用于这根骨骼（弹簧 / 惯性仿真）') : ''}
          </span>
          {chainBones.length === 0 ? <span className="text-3xs text-content-lo">{t('（未设置）')}</span> : null}
          {chainBones.map((name, index) => (
            <div key={`${index}:${name}`} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-ink-700/60">
              <span className="w-[10px] shrink-0 text-right font-mono text-3xs text-content-lo">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-3xs" title={name}>
                {name}
              </span>
              {/* 链里的每根骨骼同样能定位：长链里要挨个确认链根 / 链尾时很好用 */}
              <button
                type="button"
                className="shrink-0 text-content-lo hover:text-content-hi"
                title={t('在层级树里定位「{0}」', name)}
                onClick={() => revealBone(name)}
              >
                <Crosshair size={11} />
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-content-hi disabled:opacity-30 disabled:hover:text-content-lo"
                disabled={index === 0}
                title={t('上移（越靠前越接近链根）')}
                onClick={moveChainBone(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-content-hi disabled:opacity-30 disabled:hover:text-content-lo"
                disabled={index === chainBones.length - 1}
                title={t('下移（越靠后越接近链尾）')}
                onClick={moveChainBone(index, index + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-danger"
                title={t('从受约束骨骼链里移除（约束本身不受影响）')}
                onClick={() => editChain(t('移除受约束骨骼'), (bones) => {
                  const at = bones.indexOf(name)
                  if (at >= 0) bones.splice(at, 1)
                })}
              >
                ×
              </button>
            </div>
          ))}
          <SelectField
            label={t('添加骨骼')}
            value=""
            disabled={chainCandidates.length === 0}
            options={[
              { value: '', label: chainCandidates.length > 0 ? t('（选择骨骼加到链尾）') : t('（没有可添加的骨骼）') },
              ...chainCandidates.map((bone) => ({ value: bone.name, label: bone.name }))
            ]}
            onChange={(value) => {
              if (!value) return
              editChain(t('添加受约束骨骼'), (bones) => bones.push(value))
            }}
            // 从层级树直接拖骨骼过来 = 加到链尾，省得在下拉里翻
            onDropBone={(name) => {
              if (chainBones.includes(name)) return
              editChain(t('添加受约束骨骼'), (bones) => bones.push(name))
            }}
          />
          <span className="text-3xs text-content-lo">{t('「目标」和「添加骨骼」都能从层级树拖骨骼进来')}</span>
        </div>
      </FieldGroup>

      {constraint.type === 'ik' ? (
        <FieldGroup title={t('IK 参数')}>
          <SliderField
            label={t('权重')}
            value={constraint.mix}
            step={0.05}
            min={0}
            max={1}
            transaction={t('修改IK权重')}
            onChange={editIkMix}
          />
          <SelectField
            label={t('弯曲')}
            value={String(constraint.bendSign)}
            options={[{ value: '1', label: t('正向 (+1)') }, { value: '-1', label: t('反向 (-1)') }]}
            onChange={(value) => update(t('修改IK弯曲方向'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'ik') item.bendSign = Number(value) })}
          />
          <ToggleField
            label={t('用骨长')}
            value={constraint.useBoneLength}
            onChange={(value) => update(t('修改IK长度取法'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'ik') item.useBoneLength = value })}
          />
        </FieldGroup>
      ) : null}

      {constraint.type === 'transform' ? (
        <FieldGroup title={t('变换混合')}>
          {/*
            两列排布：位移一行、缩放一行（X / Y 并排才对照得出来），旋转与斜切共用第三行。
            六个字段竖排会把整块面板占满一屏，而它们本来就是成对的量 —— 并排看比上下对照直观。
          */}
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            {(
              [
                ['mixX', 'X 位移'],
                ['mixY', 'Y 位移'],
                ['mixScaleX', 'X 缩放'],
                ['mixScaleY', 'Y 缩放'],
                ['mixRotate', '旋转'],
                ['mixShearY', '斜切']
              ] as const
            ).map(([key, label]) => (
              <NumberField
                key={key}
                label={t(label)}
                value={constraint[key]}
                step={0.05}
                min={0}
                max={1}
                onChange={(value) =>
                  update(t('修改变换约束'), (draft) => {
                    const item = draft.constraints.find((c) => c.name === constraint.name)
                    if (item && item.type === 'transform') item[key] = value
                  })
                }
              />
            ))}
          </div>
        </FieldGroup>
      ) : null}

      {constraint.type === 'path' ? (
        <FieldGroup title={t('路径参数')}>
          {/* position / spacing 的量纲随 spacingMode 变化（percent 模式是 0..1 比例），不做像素显示换算 */}
          <NumberField
            label={t('位置')}
            value={constraint.position}
            step={0.02}
            onChange={(value) => update(t('修改路径位置'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'path') item.position = value })}
          />
          <NumberField
            label={t('间距')}
            value={constraint.spacing}
            step={0.02}
            onChange={(value) => update(t('修改路径间距'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'path') item.spacing = value })}
          />
          <NumberField
            label={t('旋转混合')}
            value={constraint.rotateMix}
            step={0.05}
            min={0}
            max={1}
            onChange={(value) => update(t('修改路径旋转混合'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'path') item.rotateMix = value })}
          />
          <NumberField
            label={t('位移混合')}
            value={constraint.translateMix}
            step={0.05}
            min={0}
            max={1}
            onChange={(value) => update(t('修改路径位移混合'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item && item.type === 'path') item.translateMix = value })}
          />
        </FieldGroup>
      ) : null}

      {constraint.type === 'physics' ? (
        <>
          <FieldGroup title={t('物理影响通道')}>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {(
                [
                  ['x', 'X 位移'],
                  ['y', 'Y 位移'],
                  ['rotate', '旋转'],
                  ['scaleX', 'X 缩放'],
                  ['shearX', '斜切']
                ] as const
              ).map(([key, label]) => (
                <NumberField
                  key={key}
                  label={t(label)}
                  value={constraint[key]}
                  step={0.05}
                  min={0}
                  max={1}
                  onChange={(value) =>
                    update(t('修改物理影响通道'), (draft) => {
                      const item = draft.constraints.find((c) => c.name === constraint.name)
                      if (item && item.type === 'physics') item[key] = value
                    })
                  }
                />
              ))}
            </div>
          </FieldGroup>

          <FieldGroup title={t('物理动力学')}>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {(
                [
                  ['inertia', '惯性'],
                  ['strength', '强度'],
                  ['damping', '阻尼'],
                  ['mass', '质量'],
                  ['wind', '风力'],
                  ['gravity', '重力'],
                  ['mix', '权重'],
                  ['limit', '幅度上限'],
                  ['step', '步长(秒)']
                ] as const
              ).map(([key, label]) => (
                <NumberField
                  key={key}
                  label={t(label)}
                  value={constraint[key]}
                  step={0.01}
                  onChange={(value) =>
                    update(t('修改物理参数'), (draft) => {
                      const item = draft.constraints.find((c) => c.name === constraint.name)
                      if (item && item.type === 'physics') item[key] = value
                    })
                  }
                />
              ))}
            </div>
            <SelectField
              label={t('scaleY 模式')}
              value={String(constraint.scaleYMode)}
              options={[
                { value: '0', label: t('不处理') },
                { value: '1', label: t('等比') },
                { value: '2', label: t('体积') }
              ]}
              onChange={(value) =>
                update(t('修改物理 scaleY 模式'), (draft) => {
                  const item = draft.constraints.find((c) => c.name === constraint.name)
                  if (item && item.type === 'physics') item.scaleYMode = Number(value) as 0 | 1 | 2
                })
              }
            />
          </FieldGroup>

          <FieldGroup title={t('全局参数（*Global）')}>
            <span className="text-3xs text-content-lo">
              {t('勾选后该参数改由动画的「全局物理轨道」驱动（Spine 的 physics[""]）；否则用上面的本地值。')}
            </span>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {(
                [
                  ['inertiaGlobal', '惯性'],
                  ['strengthGlobal', '强度'],
                  ['dampingGlobal', '阻尼'],
                  ['massGlobal', '质量'],
                  ['windGlobal', '风力'],
                  ['gravityGlobal', '重力'],
                  ['mixGlobal', '权重']
                ] as const
              ).map(([key, label]) => (
                <ToggleField
                  key={key}
                  label={t(label)}
                  value={constraint[key]}
                  onChange={(value) =>
                    update(t('修改物理全局参数'), (draft) => {
                      const item = draft.constraints.find((c) => c.name === constraint.name)
                      if (item && item.type === 'physics') item[key] = value
                    })
                  }
                />
              ))}
            </div>
          </FieldGroup>
        </>
      ) : null}

      {/*
        内嵌分组的移除入口：树里已没有 IK / 变换 / 路径约束行，得有个明确的「拆除」按钮 ——
        移除后宿主骨骼还原为普通骨骼（行首图标自动变回骨骼），该约束在时间轴上的轨道一并清掉
      */}
      {embedded && onDelete ? (
        <div className="px-2 py-2">
          <button
            type="button"
            title={t('移除这条约束：本骨骼还原为普通骨骼；它在时间轴上的关键帧轨道一并删除')}
            className="hao-btn flex h-[22px] w-full items-center justify-center gap-1 border-danger/40 text-danger/90 hover:border-danger hover:bg-danger/10"
            onClick={onDelete}
          >
            <Trash2 size={11} />
            <span>{t('移除{0}约束', constraintLabel(constraint.type))}</span>
          </button>
        </div>
      ) : null}
    </>
  )
}

/** 属性：骨骼 / 插槽 / 附件 / 约束四类选中对象的属性编辑（网格 / FFD 的设置也在附件这栏的最下面） */
export default function InspectorPanel({ onStatus = () => undefined }: InspectorPanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  /** 工程内全部骨架：嵌套 display 的「引用骨架」下拉与默认动画清单都从这里取 */
  const skeletons = useProjectStore((s) => s.skeletons)
  const selection = useSelectionStore()
  const tools = useToolStore()
  const mode = useModeStore((s) => s.mode)
  // 节流跟随播放头：这里只是「当前时间」的取值，没必要每帧重渲染整块属性面板
  const time = useThrottledPlayheadTime(400)
  const currentAnimation = useTimelineStore((s) => s.currentAnimation)
  /** Animate 态切显示附件 = 打 displayIndex 关键帧；Pose 态才是改绑定姿态 */
  const animating = mode === 'animate' && !!currentAnimation
  /** 「交换骨骼权重」选的两根骨骼（空串 = 用权重列表的前两根兜底） */
  const [swapBones, setSwapBones] = useState<{ a: string; b: string }>({ a: '', b: '' })
  /** 权重剪贴板里有几组（粘贴按钮据此启用；剪贴板本身在命令模块里） */
  const [clipboardCount, setClipboardCount] = useState(0)
  /** 「定位」：让层级树滚到某根骨骼并闪一下（只提示位置，不改选中 —— 见 locateBone） */
  const revealBone = useRevealStore((s) => s.revealBone)

  /**
   * 删除寄宿在骨骼面板里的约束：Animate 态拒绝（改的是绑定数据，与层级树同一套保护）。
   * 树里已没有 IK / 变换 / 路径约束行，这个按钮是它们的删除入口。
   */
  const deleteHostedConstraint = (name: string): void => {
    if (mode !== 'pose') {
      onStatus(t('切到 Pose 状态才能改绑定数据（骨骼 / 插槽 / display / 约束）'))
      return
    }
    removeConstraint(update, name)
    onStatus(t('已删除约束「{0}」', name))
  }

  /**
   * 重命名当前选中对象（骨骼 / 插槽 / 附件 / 约束）。
   * 名字是元数据：动画轨道里的引用会一并级联更新，不污染关键帧数据，
   * 所以 Pose / Animate 态都允许改。改名后把选中切到新名字，属性面板继续显示。
   */
  const rename = (
    kind: RenameKind,
    oldName: string,
    nextRaw: string,
    options?: { slot?: string; label?: string; reselect?: () => void }
  ): void => {
    const next = nextRaw.trim()
    if (!next || next === oldName) return
    const label = options?.label ?? kind
    const error = checkRename(document, { kind, slot: options?.slot }, oldName, next)
    if (error) {
      onStatus(error)
      return
    }
    update(t('重命名{0}', label), (draft) => {
      applyRename(draft, { kind, slot: options?.slot }, oldName, next)
    })
    options?.reselect?.()
    onStatus(t('「{0}」已重命名为「{1}」', [oldName, next]))
  }

  /**
   * 把 Region 附件的「尺寸」恢复到它的图片大小：像素 ÷ PPU，与拖图创建时
   * `regionAttachmentFromImage` 算出的初始值同一口径。改乱了想找回原尺寸时点一下。
   */
  const resetAttachmentSize = (slotName: string, attachmentName: string, imageName: string): void => {
    const image = document.images.find((item) => item.name === imageName)
    if (!image) {
      onStatus(t('找不到图片「{0}」：它可能已被删除，先在「图片」下拉里换一张', imageName))
      return
    }
    const size = { x: Math.max(1, image.width) / PPU, y: Math.max(1, image.height) / PPU }
    update(t('恢复附件尺寸'), (draft) => {
      patchAttachment(draft, slotName, attachmentName, (a) => {
        a.size = size
      })
    })
    onStatus(t('已把「{0}」的尺寸恢复到图片大小（{1} × {2} px）', [attachmentName, image.width, image.height]))
  }

  /**
   * 权重刷的目标骨骼 —— 就是选中数据里的 `bone` 字段，**与 `kind` 无关**：
   * 刷权重时 kind 常常是 attachment（那才是要刷的网格），骨骼只作"刷哪一根"用；
   * 这里若按 kind 过滤，面板的 Bone 就会在真正开刷时显示成「（未选）」。
   */
  const brushBone = selection.bone

  /**
   * 「工具选项」面板（已删除）里原本剩下的这两块设置，并到属性面板底部。
   *
   * - **权重刷**：只在权重刷工具 + Pose 态显示 —— 工具本身只在 Pose 态可用，其余时候摆出来是噪音；
   * - **整体染色**：已再挪到视口右上角的浮动面板（`ViewportOverlays`）—— 它改的是「怎么看画面」，
   *   与选中了谁无关，贴着画布才调得顺手，属性面板也就不必再背这一段。
   *
   * 原面板里另外两块 ——「重置当前时间点的 FFD」与「权重刷 / 网格 / Pose 属于绑定工具」的提示 ——
   * **没有搬**：它们只在 Animate 态 / 非 Pose 态出现，而 Animate 态整个右栏是收起的（见 App），
   * 搬过来也永远不会渲染。
   *
   * 未选中对象时（`none` 分支）也不显示：那时没有权重刷的目标，「未选中对象」的空状态居中更好看。
   */
  const toolSections = (
    <>
      {tools.tool === 'weight' && mode === 'pose' ? (
        /*
         * 参数：Mode / Bone / Normalize / Size / Strength / Feather（Strength 与 Feather 对齐 Spine 的笔刷语义）。
         * 用法说明收进标题旁的 info 图标：一段话常驻会把下面的列表挤下去，而它读一次就够。
         */
        <FieldGroup
          title={t('权重刷')}
          actions={
            <InfoHint
              text={t('Strength = 一笔能刷到的权重上限；Feather = 边缘衰减占笔刷半径的比例（0 = 硬边）；按住修饰键临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长')}
            />
          }
        >
          <SelectField
            label="Mode"
            value={tools.brush.mode}
            options={[
              { value: 'addSubtract', label: t('Add and Subtract（增加 / Alt 减少）') },
              { value: 'growShrink', label: t('Grow and Shrink（只动已受影响的顶点）') },
              { value: 'smooth', label: t('Smooth（朝邻居平均）') }
            ]}
            onChange={(value) => tools.setBrush({ mode: value as BrushModeSetting })}
          />
          {/* Bone 只改「刷哪根骨骼」，不动当前选中对象 —— 权重刷要求附件保持选中（那才是要刷的网格） */}
          <SelectField
            label="Bone"
            value={brushBone}
            options={[
              { value: '', label: t('（未选）') },
              ...document.bones.map((bone) => ({ value: bone.name, label: bone.name }))
            ]}
            onChange={(value) => useSelectionStore.getState().select({ bone: value })}
          />
          <CheckboxField
            label="Normalize"
            value={tools.brush.normalize}
            onChange={(value) => tools.setBrush({ normalize: value })}
            hint={t('刷过的顶点权重归一到 1；关掉就只改目标骨骼，权重和可能不等于 1')}
          />
          <NumberField
            label="Size"
            value={tools.brush.size}
            step={4}
            min={2}
            precision={0}
            suffix="px"
            onChange={(value) => tools.setBrush({ size: value })}
          />
          <NumberField
            label="Strength"
            value={tools.brush.strength}
            step={5}
            min={1}
            max={100}
            suffix="%"
            onChange={(value) => tools.setBrush({ strength: value })}
          />
          <NumberField
            label="Feather"
            value={tools.brush.feather}
            step={5}
            min={0}
            max={100}
            suffix="%"
            onChange={(value) => tools.setBrush({ feather: value })}
          />
        </FieldGroup>
      ) : null}
    </>
  )

  if (selection.kind === 'none') {
    return (
      <PanelEmpty
        title={t('未选中对象')}
        description={t('在层级树或视口中选中骨骼、插槽、附件或约束后，可在此编辑其属性。')}
      />
    )
  }

  if (selection.kind === 'bone') {
    const bone = document.bones.find((b) => b.name === selection.bone)
    if (!bone) return <PanelEmpty title={t('骨骼不存在')} description={t('该骨骼可能已被删除，请重新选择。')} />
    /** 层级根骨骼：整棵树的根，没有父级可选（面板也不能把它挂到别的骨骼下） */
    const isRootBone = bone.name === rootBoneName(document.bones)

    /**
     * Animate 态：局部变换显示「当前动画在播放头时间的值」，改动即在该时间打关键帧；
     * Pose 态：显示的才是绑定姿态（setup）。
     * 父级 / 长度属于绑定数据，Animate 态改会污染动画基线，所以禁用。
     */
    const animation = animating ? document.animations.find((item) => item.name === currentAnimation) : null
    const boneTrack = animation?.bones.find((track) => track.bone === bone.name)
    const shown = animating
      ? {
          position: sampleVec2Keys(boneTrack?.translate, time, bone.localPosition),
          rotation: sampleNumberKeys(boneTrack?.rotate, time, bone.rotation),
          scale: sampleVec2Keys(boneTrack?.scale, time, bone.localScale),
          shear: sampleVec2Keys(boneTrack?.shear, time, bone.localShear)
        }
      : {
          position: bone.localPosition,
          rotation: bone.rotation,
          scale: bone.localScale,
          shear: bone.localShear
        }

    const writeTransform = (
      channel: 'translate' | 'rotate' | 'scale' | 'shear',
      value: { x: number; y: number } | number,
      label: string
    ): void => {
      if (animating) {
        update(t('{0}（{1}s 打关键帧）', [label, time.toFixed(2)]), (draft) => {
          const target = draft.animations.find((item) => item.name === currentAnimation)
          if (target) keyBoneChannel(target, bone.name, channel, time, value as never)
        })
        return
      }
      update(t('修改骨骼{0}', label), (draft) => {
        const target = draft.bones.find((b) => b.name === bone.name)
        if (!target) return
        if (channel === 'translate') target.localPosition = value as { x: number; y: number }
        else if (channel === 'rotate') target.rotation = value as number
        else if (channel === 'scale') target.localScale = value as { x: number; y: number }
        else target.localShear = value as { x: number; y: number }
      })
    }

    return (
      <div className="flex flex-col">
        <FieldGroup title={t('骨骼')}>
          <TextField
            label={t('名称')}
            value={bone.name}
            commitOnBlur
            onChange={(next) => rename('bone', bone.name, next, { label: t('骨骼'), reselect: () => selection.selectBone(next.trim()) })}
          />
          {/*
            父级下拉只列**层级树里能拖成的那些组合**：层级根骨骼不可选父级（其他骨骼都在它之下），
            其余骨骼也只列「不是自己、也不在自己子树里」的目标 —— 拖进自己的后代会把层级绕成环。
          */}
          <SelectField
            label={t('父级')}
            value={bone.parent}
            disabled={animating || isRootBone}
            options={[
              ...(isRootBone
                ? [{ value: '', label: t('（层级根骨骼）') }]
                : bone.parent
                  ? []
                  : [{ value: '', label: t('（未挂载）') }]),
              ...document.bones
                .filter((b) => b.name !== bone.name && !isDescendantOf(document.bones, b.name, bone.name))
                .map((b) => ({ value: b.name, label: b.name }))
            ]}
            onChange={(value) =>
              update(t('修改骨骼父级'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.parent = value
              })
            }
          />
          {isRootBone ? (
            <p className="text-3xs text-content-lo">{t('层级根骨骼：其他骨骼都在它之下，它没有父级')}</p>
          ) : null}
          {/* 长度按像素显示 / 输入（step 5px）；写回仍是世界单位，换算在字段内做 */}
          <NumberField
            label={t('长度')}
            value={bone.length}
            unitScale={PX_PER_UNIT}
            step={5}
            min={0}
            precision={1}
            suffix="px"
            disabled={animating}
            onChange={(value) =>
              update(t('修改骨骼长度'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.length = value
              })
            }
          />
          {animating ? (
            <p className="text-3xs text-content-lo">{t('父级 / 长度属于绑定数据，切到 Pose 状态再改')}</p>
          ) : null}
        </FieldGroup>

        <FieldGroup
          title={animating ? t('动画变换 · {0}s（改动即打关键帧）', time.toFixed(2)) : t('局部变换（Setup）')}
        >
          {/* 位置按像素显示 / 输入（中键拖动 / 上下键按 10px 走）；写回仍是世界单位 */}
          <Vector2Field
            label={t('位置')}
            value={shown.position}
            unitScale={PX_PER_UNIT}
            step={10}
            onChange={(value) => writeTransform('translate', value, t('位置'))}
          />
          <NumberField
            label={t('旋转')}
            value={shown.rotation}
            step={1}
            suffix="°"
            onChange={(value) => writeTransform('rotate', value, t('旋转'))}
          />
          <Vector2Field
            label={t('缩放')}
            value={shown.scale}
            step={0.1}
            onChange={(value) => writeTransform('scale', value, t('缩放'))}
          />
          <Vector2Field
            label={t('斜切')}
            value={shown.shear}
            step={0.1}
            onChange={(value) => writeTransform('shear', value, t('斜切'))}
          />
        </FieldGroup>

        <FieldGroup title={t('继承')}>
          <ToggleField
            label={t('继承旋转')}
            value={bone.inheritRotation}
            onChange={(value) =>
              update(t('修改继承旋转'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.inheritRotation = value
              })
            }
          />
          <ToggleField
            label={t('继承缩放')}
            value={bone.inheritScale}
            onChange={(value) =>
              update(t('修改继承缩放'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.inheritScale = value
              })
            }
          />
          <ColorField
            label={t('显示色')}
            value={bone.color}
            onDragStart={() => useProjectStore.getState().beginTransaction(t('修改骨骼颜色'))}
            onDragEnd={() => useProjectStore.getState().endTransaction()}
            onChange={(value) =>
              update(t('修改骨骼颜色'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.color = value
              })
            }
          />
          <CheckboxField
            label={t('画法')}
            value={bone.hollow === true}
            hint={t('空心（默认实心）')}
            onChange={(value) =>
              update(t('修改骨骼画法'), (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.hollow = value
              })
            }
          />
        </FieldGroup>

        {/*
          合并显示的约束寄宿在宿主骨骼行上（行尾徽标同口径）：IK = 目标骨，「目标骨就是 IK 节点」；
          变换 / 路径 = 第一根被驱动骨。参数就地在这里编辑，物理约束仍走「约束」页
        */}
        {hostedConstraints(document, bone.name).map((hosted) => (
          <ConstraintEditor
            key={hosted.name}
            document={document}
            constraint={hosted}
            update={update}
            revealBone={revealBone}
            embedded
            onDelete={() => deleteHostedConstraint(hosted.name)}
          />
        ))}
        {toolSections}
      </div>
    )
  }

  if (selection.kind === 'slot' || selection.kind === 'attachment') {
    const slot = document.slots.find((s) => s.name === selection.slot)
    if (!slot) return <PanelEmpty title={t('插槽不存在')} description={t('该插槽可能已被删除，请重新选择。')} />
    const skinSlot = document.skins.find((s) => s.name === selection.skin)?.slots.find((s) => s.slot === slot.name)
      ?? document.skins[0]?.slots.find((s) => s.slot === slot.name)
    // 附件解析走「皮肤优先、跨皮肤兜底」：切过皮肤后不该让检查器整段空掉（与视口同一套规则）
    const attachment = resolveAttachment(document, slot.name, selection.attachment, selection.skin)
    /** 嵌套 display 引用的子骨架（用于列出它的动画名） */
    const nestedSkeleton = attachment?.type === 'armature'
      ? skeletons.find((item) => item.armatureName === attachment.subArmature)
      : undefined
    // 权重骨骼列表：优先用附件上显式绑定的（老数据按顶点权重推断，见 weightBonesOf）
    const weightBones = attachment && attachment.type === 'mesh' ? weightBonesOf(attachment) : []
    /** 是否正在为**这个**附件等待点选骨骼（等待态是全局的，按钮只在目标附件上高亮） */
    const pickingWeightBone =
      tools.pendingWeightBone?.slot === selection.slot &&
      tools.pendingWeightBone?.attachment === selection.attachment

    const meshAttachment = attachment && attachment.type === 'mesh' ? attachment : null

    /*
     * 链接网格（linkedmesh）：几何来自源网格，面板只决定贴图 / UV。
     * 这里解析一次给「只读说明」用 —— 找不到源网格时也要能看出来（而不是显示成一块普通网格）。
     */
    const linkedMesh = attachment && attachment.type === 'linkedmesh' ? attachment : null
    const linkedMeshView = linkedMesh ? resolveAuthoringLinkedMesh(document, linkedMesh, slot.name) : null
    /** 默认皮肤名（与运行期 pickSkinByName 同一口径）：`linkedMeshSkin` 空串表示它 */
    const linkedDefaultSkin =
      document.skins.find((item) => item.name === 'default')?.name ?? document.skins[0]?.name ?? ''
    /** 可选的源网格：当前源皮肤里、同一插槽下的 Mesh 附件 */
    const linkedParentOptions = linkedMesh
      ? (
          document.skins
            .find((item) => item.name === (linkedMesh.linkedMeshSkin || linkedDefaultSkin))
            ?.slots.find((item) => item.slot === slot.name)?.attachments ?? []
        )
          .filter((item) => item.type === 'mesh')
          .map((item) => ({ value: item.name, label: item.name }))
      : []

    /**
     * 附件字段的就地修改：链接网格必须**只改当前皮肤这一条**。
     *
     * 换装场景里链接网格与源网格同名，`patchAttachment` 会把所有皮肤的同名附件一起改 ——
     * 挪一下位置就把源网格也挪走了。其余类型保持「跨皮肤同步」的原语义不变。
     */
    const patchSelected = (draft: EditorDocument, mutate: (item: AuthoringAttachment) => void): void => {
      if (attachment?.type === 'linkedmesh') {
        patchAttachmentInSkin(
          draft,
          selection.skin || document.editorMeta.activeSkin,
          slot.name,
          attachment.name,
          mutate
        )
        return
      }
      patchAttachment(draft, slot.name, attachment.name, mutate)
    }
    /**
     * 修剪的范围：有选中顶点时只处理它们（与画笔「选了顶点就只刷这些」同一套规则）。
     *
     * `selection.vertices` 是**共享顶点缓冲**下标，必须经 `scene.vertexRefAt` 换算成附件内下标 ——
     * 直接拿下标去索引 `attachment.vertices` 会串到别的附件上（画笔那边也是同样换算，见 selectedVertexKeys）。
     */
    const trimScope = ((): number[] | null => {
      if (!meshAttachment) return null
      if (selection.kind !== 'attachment' || selection.vertices.length === 0) return null
      const scene = getActiveScene()
      const indices: number[] = []
      for (const index of selection.vertices) {
        const ref = scene?.vertexRefAt(index)
        if (ref && ref.slot === slot.name && ref.attachment === meshAttachment.name) indices.push(ref.vertex)
      }
      return indices
    })()
    /**
     * 修剪的**计数预览**（不写文档）：Spine 的 Prune 是滑块一动就实时预览，
     * 我们只预览数字，点按钮才提交 —— 拖滑块时往撤销栈里塞记录不是好买卖。
     */
    const trimPreview =
      meshAttachment && trimScope?.length !== 0
        ? previewTrimWeights(document, slot.name, meshAttachment.name, {
            maxInfluences: tools.trim.maxInfluences,
            threshold: tools.trim.threshold / 100,
            vertices: trimScope ?? undefined
          })
        : null
    /**
     * 受超过 4 根骨骼影响的顶点数（Spine 权重工具的黄叹号口径，不写文档）。
     * 有选中顶点时按选中范围统计 —— 警告说几个，下面那把「锤子」就修剪几个，不会对不上。
     */
    const overInfluenced = meshAttachment ? countOverInfluenced(meshAttachment, 4, trimScope ?? undefined) : 0

    /** 执行一次修剪：Pose 校验、范围换算、状态栏回报都在这里（警告条与主按钮共用） */
    const runTrim = (maxInfluences: number, threshold: number): void => {
      if (!meshAttachment) return
      if (mode !== 'pose') {
        onStatus(t('修剪权重改的是绑定姿态：请切到 Pose 状态'))
        return
      }
      if (trimScope && trimScope.length === 0) {
        onStatus(t('选中的顶点不在这个网格上：请重新框选，或点空白取消选择'))
        return
      }
      let result = { touched: 0, removed: 0, capped: 0 }
      useProjectStore.getState().runCommand(t('修剪权重'), (draft) => {
        result = trimVertexWeights(draft, slot.name, meshAttachment.name, {
          maxInfluences,
          threshold,
          normalize: true,
          vertices: trimScope ?? undefined
        })
        return result.touched > 0
      })
      if (result.touched === 0) {
        onStatus(
          threshold > 0
            ? t('没有顶点需要修剪：都在 {0} 根骨骼以内，也没有小于 {1}% 的权重', [
                maxInfluences,
                Math.round(threshold * 100)
              ])
            : t('没有顶点需要修剪：受超过 {0} 根骨骼影响的顶点不在当前选择里', maxInfluences)
        )
        return
      }
      onStatus(
        threshold > 0
          ? t('已修剪 {0} 个顶点：丢掉 {1} 个骨骼影响，{2} 个顶点压到 {3} 根骨骼以内', [
              result.touched,
              result.removed,
              result.capped,
              maxInfluences
            ])
          : t('已把 {0} 个顶点修剪到 {1} 根骨骼以内（丢掉 {2} 个骨骼影响）', [
              result.touched,
              maxInfluences,
              result.removed
            ])
      )
    }

    /** 交换 / 复制 / 粘贴的作用范围：与修剪一致 —— 选中顶点优先，否则整块网格 */
    const scopeOrWhole = (): number[] | undefined =>
      trimScope && trimScope.length > 0 ? trimScope : undefined

    /** 交换两根骨骼的权重（Spine 的 Swap） */
    const runSwap = (): void => {
      if (!meshAttachment) return
      if (mode !== 'pose') {
        onStatus(t('交换权重改的是绑定数据：请切到 Pose 状态'))
        return
      }
      const a = swapBones.a || weightBones[0] || ''
      const b = swapBones.b || weightBones[1] || ''
      if (!a || !b || a === b) {
        onStatus(t('先选两根不同的骨骼再交换'))
        return
      }
      if (trimScope && trimScope.length === 0) {
        onStatus(t('选中的顶点不在这个网格上：请重新框选，或点空白取消选择'))
        return
      }
      let touched = 0
      useProjectStore.getState().runCommand(t('交换骨骼权重'), (draft) => {
        touched = swapWeightBones(draft, slot.name, meshAttachment.name, a, b, scopeOrWhole())
        return touched > 0
      })
      onStatus(
        touched > 0
          ? t('已在 {0} 个顶点上交换「{1}」与「{2}」的权重', [touched, a, b])
          : t('没有可交换的权重：「{0}」与「{1}」在这些顶点上没有区别', [a, b])
      )
    }

    /** 复制选中顶点的权重（Spine 的 ctrl+C） */
    const runCopyWeights = (): void => {
      if (!meshAttachment) return
      const count = copyVertexWeights(document, slot.name, meshAttachment.name, scopeOrWhole() ?? [])
      setClipboardCount(count)
      onStatus(count > 0 ? t('已复制 {0} 个顶点的权重', count) : t('没有可复制的顶点：先在视口里点选或框选'))
    }

    /** 粘贴权重（Spine 的 ctrl+V）：骨骼名对不上的会被丢掉，剩下的重新归一 */
    const runPasteWeights = (): void => {
      if (!meshAttachment) return
      if (mode !== 'pose') {
        onStatus(t('粘贴权重改的是绑定数据：请切到 Pose 状态'))
        return
      }
      if (clipboardCount === 0) {
        onStatus(t('剪贴板是空的：先复制一批顶点的权重'))
        return
      }
      if (trimScope && trimScope.length === 0) {
        onStatus(t('选中的顶点不在这个网格上：请重新框选，或点空白取消选择'))
        return
      }
      let touched = 0
      useProjectStore.getState().runCommand(t('粘贴顶点权重'), (draft) => {
        touched = pasteVertexWeights(draft, slot.name, meshAttachment.name, scopeOrWhole() ?? [])
        return touched > 0
      })
      onStatus(
        touched > 0
          ? t('已粘贴 {0} 个顶点的权重', touched)
          : t('粘贴没有改动任何顶点：骨骼名对不上，或权重本来就一样')
      )
    }

    return (
      <div className="flex flex-col">
        <FieldGroup title={t('插槽')}>
          <TextField
            label={t('名称')}
            value={slot.name}
            commitOnBlur
            onChange={(next) => rename('slot', slot.name, next, { label: t('插槽'), reselect: () => selection.selectSlot(next.trim()) })}
          />
          <SelectField
            label={t('骨骼')}
            value={slot.bone}
            options={document.bones.map((b) => ({ value: b.name, label: b.name }))}
            onChange={(value) =>
              update(t('修改插槽骨骼'), (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.bone = value
              })
            }
          />
          <SelectField
            label={t('混合')}
            value={String(slot.blendMode)}
            options={blendOptions()}
            onChange={(value) =>
              update(t('修改混合模式'), (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.blendMode = Number(value) as BlendMode
              })
            }
          />
          <NumberField
            label={t('层序')}
            value={slot.zOrder}
            step={1}
            precision={0}
            onChange={(value) =>
              update(t('修改插槽层序'), (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.zOrder = value
              })
            }
          />
          <ColorField
            label={t('颜色')}
            value={slot.color}
            onDragStart={() => useProjectStore.getState().beginTransaction(t('修改插槽颜色'))}
            onDragEnd={() => {
              useProjectStore.getState().endTransaction()
              usePreviewStore.getState().clearSlotColors()
            }}
            // 拖动中只写预览通道：视口按帧热更新颜色，文档 / 历史 / 面板一动不动（松手才提交一次）
            onPreview={(value) => usePreviewStore.getState().setSlotColor(slot.name, value)}
            onChange={(value) =>
              update(t('修改插槽颜色'), (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.color = value
              })
            }
          />
          <SelectField
            label={animating ? t('显示（关键帧）') : t('显示')}
            value={slot.attachment}
            options={[{ value: '', label: t('（不显示）') }, ...(skinSlot?.attachments ?? []).map((a) => ({ value: a.name, label: a.name }))]}
            onChange={(value) => {
              const attachments = skinSlot?.attachments ?? []
              const index = attachments.findIndex((item) => item.name === value)
              if (animating) {
                // 换装动画：Animate 态只写关键帧，不动绑定姿态
                update(t('关键帧：切换显示'), (draft) => {
                  const animation = draft.animations.find((item) => item.name === currentAnimation)
                  if (animation) keySlotDisplay(animation, slot.name, time, value ? index : -1, value)
                })
                onStatus(
                  value
                    ? t('已在 {0}s 打关键帧：插槽「{1}」显示「{2}」', [time.toFixed(3), slot.name, value])
                    : t('已在 {0}s 打关键帧：插槽「{1}」不显示', [time.toFixed(3), slot.name])
                )
                return
              }
              update(t('修改 setup 附件'), (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.attachment = value
              })
            }}
          />
          <div className="flex items-center gap-1">
            <ToggleField
              label={animating ? t('可见（关键帧）') : t('可见')}
              value={slot.visible}
              onChange={(value) =>
                animating
                  ? update(t('关键帧：切换可见性'), (draft) => {
                      const animation = draft.animations.find((item) => item.name === currentAnimation)
                      if (animation) keySlotVisible(animation, slot.name, time, value)
                    })
                  : update(t('修改插槽可见性'), (draft) => {
                      const target = draft.slots.find((s) => s.name === slot.name)
                      if (target) target.visible = value
                    })
              }
            />
          </div>
        </FieldGroup>

        {attachment ? (
          <FieldGroup title={t('附件 · {0}', attachment.type)}>
            <TextField
              label={t('名称')}
              value={attachment.name}
              commitOnBlur
              onChange={(next) =>
                rename('attachment', attachment.name, next, {
                  slot: slot.name,
                  label: t('附件'),
                  reselect: () => selection.selectAttachment(slot.name, next.trim())
                })
              }
            />
            {/*
              链接网格：几何（顶点 / 三角面 / 权重）全部来自源网格，这一条只决定贴图与 UV。
              改源在层级树右键菜单里（那里能按同插槽列出候选网格），这里给只读说明 + 解链出口。
            */}
            {linkedMesh ? (
              <FieldGroup title={t('链接网格')}>
                <p className="flex items-start gap-1 text-3xs leading-[16px] text-content-lo">
                  <Link2 size={11} className="mt-0.5 shrink-0" />
                  {linkedMeshView
                    ? t('几何来自「{0}」（{1}）：改形状请编辑源网格，这里只决定贴图与 UV', [
                        linkedMeshView.parent.name,
                        linkedMesh.linkedMeshSkin || t('默认皮肤')
                      ])
                    : t('找不到源网格：先修好源皮肤 / 源网格（层级树右键这条 display 可改源），或解链为独立网格')}
                </p>
                <SelectField
                  label={t('源网格')}
                  value={linkedMesh.linkedMeshAttachment || linkedMesh.name}
                  options={linkedParentOptions}
                  disabled={linkedParentOptions.length === 0}
                  onChange={(value) => {
                    let message = ''
                    update(t('修改链接源'), (draft) => {
                      const result = setLinkedMeshSource(draft, {
                        slot: slot.name,
                        attachment: linkedMesh.name,
                        skin: selection.skin,
                        sourceSkin: linkedMesh.linkedMeshSkin || '',
                        source: value
                      })
                      message = result.ok ? result.warning ?? t('已把源网格改成「{0}」', value) : result.reason
                    })
                    if (message) onStatus(message)
                  }}
                />
                <button
                  type="button"
                  className="hao-btn h-[20px] self-start px-2 text-3xs"
                  title={t('把源网格的几何 / 权重复制到这一条，之后与源网格无关（可 Ctrl+Z 撤销）')}
                  onClick={() => {
                    let message = ''
                    update(t('解链为独立网格'), (draft) => {
                      const result = unlinkLinkedMesh(draft, {
                        slot: slot.name,
                        attachment: linkedMesh.name,
                        skin: selection.skin
                      })
                      message = result.ok
                        ? t('已解链为独立网格（{0} 顶点）', result.vertices)
                        : result.reason
                    })
                    if (message) onStatus(message)
                  }}
                >
                  {t('解链为独立网格')}
                </button>
              </FieldGroup>
            ) : null}
            {/*
              嵌套骨架：引用的是**同工程里的另一个骨架**（按名字），不复制数据。
              默认动画 / 循环 / 偏移 / 倍速是 setup 值；时间轴上的「子骨架」通道会按帧覆盖它们。
            */}
            {attachment.type === 'armature' ? (
              <>
                <SelectField
                  label={t('引用骨架')}
                  value={attachment.subArmature}
                  options={[
                    { value: '', label: t('（未引用）') },
                    ...skeletons
                      .filter((item) => item.armatureName !== document.armatureName)
                      .map((item) => ({ value: item.armatureName, label: item.armatureName }))
                  ]}
                  onChange={(value) =>
                    update(t('修改嵌套骨架'), (draft) =>
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.subArmature = value
                        // 换了骨架，旧动画名基本不存在，清掉免得留一个无效默认值
                        a.subAnimation = ''
                      })
                    )
                  }
                />
                <SelectField
                  label={t('默认动画')}
                  value={attachment.subAnimation}
                  options={[
                    { value: '', label: t('（setup 姿态）') },
                    ...(nestedSkeleton?.animations ?? []).map((animation) => ({
                      value: animation.name,
                      label: animation.name
                    }))
                  ]}
                  onChange={(value) =>
                    update(t('修改子骨架默认动画'), (draft) =>
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.subAnimation = value
                      })
                    )
                  }
                />
                <NumberField
                  label={t('播放次数')}
                  value={attachment.subPlayTimes}
                  step={1}
                  precision={0}
                  // 0 / 负数 = 循环（-1 更直白）；正数 = 播几次后定格
                  onChange={(value) =>
                    update(t('修改子骨架播放次数'), (draft) =>
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.subPlayTimes = Math.round(value)
                      })
                    )
                  }
                />
                <NumberField
                  label={t('起始偏移')}
                  value={attachment.subOffset}
                  step={0.05}
                  suffix={t('秒')}
                  onChange={(value) =>
                    update(t('修改子骨架起始偏移'), (draft) =>
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.subOffset = value
                      })
                    )
                  }
                />
                <NumberField
                  label={t('倍速')}
                  value={attachment.subSpeed}
                  step={0.1}
                  min={0}
                  onChange={(value) =>
                    update(t('修改子骨架倍速'), (draft) =>
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.subSpeed = Math.max(0, value)
                      })
                    )
                  }
                />
              </>
            ) : null}
            {attachment.type !== 'clipping' ? (
              <>
                {attachment.type !== 'armature' ? (
                <SelectField
                  label={t('图片')}
                  value={attachment.image}
                  options={[
                    { value: '', label: t('（纯色）') },
                    ...document.images.map((image) => ({ value: image.name, label: image.name }))
                  ]}
                  onChange={(value) => {
                    /*
                     * 链接网格换图必须**只改这一条**并按新区域重算 UV：
                     * `patchAttachment` 会把所有皮肤的同名附件一起改（链接网格与源网格恰好同名），
                     * 直接把源网格的贴图也换掉。
                     */
                    if (attachment.type === 'linkedmesh') {
                      let message = ''
                      update(t('修改附件图片'), (draft) => {
                        const result = setLinkedMeshImage(draft, {
                          slot: slot.name,
                          attachment: attachment.name,
                          skin: selection.skin,
                          image: value
                        })
                        message = result.ok ? result.warning ?? '' : result.reason
                      })
                      if (message) onStatus(message)
                      return
                    }
                    update(t('修改附件图片'), (draft) => {
                      patchAttachment(draft, slot.name, attachment.name, (a) => {
                        a.image = value
                      })
                    })
                  }}
                />
                ) : null}
                {/* 同骨骼位置：按像素显示 / 输入（中键拖动 / 上下键按 10px 走），写回仍是世界单位 */}
                <Vector2Field
                  label={t('位置')}
                  value={attachment.position}
                  unitScale={PX_PER_UNIT}
                  step={10}
                  onChange={(value) => update(t('修改附件位置'), (draft) => patchSelected(draft, (a) => { a.position = value }))}
                />
                <NumberField
                  label={t('旋转')}
                  value={attachment.rotation}
                  suffix="°"
                  onChange={(value) => update(t('修改附件旋转'), (draft) => patchSelected(draft, (a) => { a.rotation = value }))}
                />
                <Vector2Field
                  label={t('缩放')}
                  value={attachment.scale}
                  step={0.1}
                  onChange={(value) => update(t('修改附件缩放'), (draft) => patchSelected(draft, (a) => { a.scale = value }))}
                />
              </>
            ) : null}
            {/*
              尺寸：**Region 的内容矩形**（图集里那块有像素的区域）—— 渲染的四边形与栅格网格按它走。
              被裁剪过的图，选中轮廓 / 变换手柄按**原图尺寸**走（下面那行只读提示），
              于是框包含被裁掉的空白 —— 与 DragonBones / Spine 编辑器的显示一致。
              网格附件不显示它：网格的形状完全由顶点决定（选中轮廓也走顶点），
              改这个数在视口里看不出任何变化，只会在「自动生成网格」按它映射尺寸时
              产生看不出来的偏差。原值仍留在数据里（「还原为 Region」与重新生成都要用）。
            */}
            {/*
              链接网格不显示尺寸：渲染尺寸取源网格的（改这里不会生效，只会让人以为改了没反应）。
            */}
            {attachment.type !== 'mesh' &&
            attachment.type !== 'linkedmesh' &&
            attachment.type !== 'clipping' &&
            attachment.type !== 'armature' ? (
              <Vector2Field
                label={t('尺寸')}
                value={attachment.size}
                unitScale={PX_PER_UNIT}
                step={5}
                onChange={(value) => update(t('修改附件尺寸'), (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.size = value }))}
                // 行尾小图标：一键恢复到图片大小（仅 Region；纯色附件没有图可恢复，不显示）
                action={
                  attachment.type === 'region' && attachment.image ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      title={t('恢复到图片大小（按图片像素 ÷ PPU 折算，与拖图创建时一致）')}
                      className="shrink-0 text-content-lo hover:text-content-hi"
                      onClick={() => resetAttachmentSize(slot.name, attachment.name, attachment.image)}
                    >
                      <RotateCcw size={11} />
                    </button>
                  ) : null
                }
              />
            ) : null}
            {attachment.frameSize.x > 1e-4 &&
            attachment.frameSize.y > 1e-4 &&
            (Math.abs(attachment.frameSize.x - attachment.size.x) > 1e-4 ||
              Math.abs(attachment.frameSize.y - attachment.size.y) > 1e-4) ? (
              <p className="text-3xs text-content-lo">
                {t('原图（含裁剪留白）：{0} × {1} px —— 选中轮廓/手柄按它走，渲染仍只有上面「尺寸」那块', [
                  unitsToPx(attachment.frameSize.x).toFixed(1),
                  unitsToPx(attachment.frameSize.y).toFixed(1)
                ])}
              </p>
            ) : null}
            {attachment.type !== 'clipping' ? (
              <ColorField
                label={t('颜色')}
                value={attachment.color}
                onDragStart={() => useProjectStore.getState().beginTransaction(t('修改附件颜色'))}
                onDragEnd={() => useProjectStore.getState().endTransaction()}
                onChange={(value) => update(t('修改附件颜色'), (draft) => patchSelected(draft, (a) => { a.color = value }))}
              />
            ) : null}
            {/*
              骨内FFD：**只在已经标成骨内空间时才出现**（正常流程不会产生 true）。
              导入器（spine / DragonBones）与编辑器的 FFD 工具写的都是显示空间，导出时
              compiler 还会把 true 换算回显示空间并清零（见 compile.normalizeBoneSpaceFfd）——
              所以平时藏起来；只有旧工程 / 外部数据带着 true 时它才冒出来，让人能看着并关掉。
            */}
            {attachment.type === 'mesh' && attachment.ffdInBoneSpace ? (
              <ToggleField
                label={t('骨内FFD')}
                value={attachment.ffdInBoneSpace}
                hint={t('偏移已按骨骼 bindpose 换算过；正常保持关闭')}
                onChange={(value) => update(t('修改FFD空间'), (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.ffdInBoneSpace = value }))}
              />
            ) : null}
            {attachment.type === 'mesh' ? (
              // 数字是**实时状态**（顶点 / 面 / 已加权），留着；怎么加点、怎么删这类说明收进 info 气泡
              <div className="flex items-start gap-1">
                <p className="min-w-0 flex-1 text-3xs leading-relaxed text-content-lo">
                  {t('顶点 {0} · 三角面 {1} · 加权 {2}', [
                    attachment.vertices.length,
                    Math.floor(attachment.triangles.length / 3),
                    attachment.vertices.filter((v) => v.weights.length > 0).length
                  ])}
                </p>
                <InfoHint
                  text={t('用网格 / FFD 工具在网格内 Alt+点击插入顶点，选中顶点后可在下面删除')}
                />
              </div>
            ) : null}

            {/* 链接网格的顶点只读（几何在源网格上），但仍可单独打 FFD 帧 */}
            {linkedMesh ? (
              <div className="flex items-start gap-1">
                <p className="min-w-0 flex-1 text-3xs leading-relaxed text-content-lo">
                  {linkedMeshView
                    ? t('顶点 {0} · 三角面 {1}（来自源网格，只读）', [
                        linkedMeshView.vertices.length,
                        Math.floor(linkedMeshView.triangles.length / 3)
                      ])
                    : t('顶点数未知：源网格缺失')}
                </p>
                <InfoHint text={t('链接网格的几何 / 权重在源网格上编辑；Animate 态仍可给这一条单独打 FFD 帧')} />
              </div>
            ) : null}

            {attachment.type === 'mesh' ? (
              <FieldGroup title={t('权重骨骼列表')}>
                {/*
                  「绑定骨骼」独占第一行（`basis-full` 撑满后强制换行）：它是进入这套流程的前提。
                  下面一行才是「算权重 + 选算法 + 说明」—— 三者本来就是一组动作，拆成三行会让这块高出一截。
                */}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    className="hao-btn h-[20px] basis-full px-2 text-3xs"
                    title={
                      pickingWeightBone
                        ? t('结束绑定：已点选的骨骼会保留在列表里')
                        : t('进入绑定骨骼状态后，在视口里点选骨骼加入列表（可以连续点选多根），右键或再点这个按钮结束')
                    }
                    onClick={() => {
                      if (pickingWeightBone) {
                        tools.setPendingWeightBone(null)
                        onStatus(t('已结束绑定骨骼'))
                        return
                      }
                      tools.setPendingWeightBone({ slot: slot.name, attachment: attachment.name })
                      onStatus(t('绑定骨骼：在视口里点选骨骼加入列表（可连续多根），完成后右键或再点这个按钮'))
                    }}
                  >
                    {pickingWeightBone ? t('完成绑定骨骼') : t('添加绑定骨骼')}
                  </button>
                  <button
                    type="button"
                    className="hao-btn h-[20px] shrink-0 px-2 text-3xs"
                    disabled={weightBones.length === 0}
                    title={t('按列表里的骨骼重算所有顶点权重：顶点离哪根骨骼近，它在那根骨骼上的权重就高（列表外的骨骼不参与）')}
                    onClick={() => {
                      const scene = getActiveScene()
                      if (!scene) return
                      if (mode !== 'pose') {
                        onStatus(t('自动计算权重写的是绑定姿态：请切到 Pose 状态'))
                        return
                      }
                      const result = runAutoWeightsForBones(
                        { scene, selection, tools, mode, time, status: onStatus },
                        slot.name,
                        attachment.name,
                        weightBones,
                        2
                      )
                      const touched = result.touched
                      // 有选中顶点时只重算它们（Spine 的 Auto 口径），状态栏要说明，免得以为坏了
                      const scoped = trimScope !== null && trimScope.length > 0
                      const message =
                        touched > 0
                          ? scoped
                            ? t('已按绑定骨骼重算选中的 {0} 个顶点', touched)
                            : t('已按绑定骨骼重算 {0} 个顶点的权重', touched)
                          : weightBones.length < 2
                            ? t('权重没有变化：列表里只有 {0} 根骨骼，结果就是全部 100%。先点「添加绑定骨骼」把相关骨骼加进来再算', weightBones.length)
                            : t('权重没有变化：当前权重已是最新结果')
                      // 降级要说出来：用户选了热扩散却拿到表面距离，不说会以为算法没生效
                      onStatus(
                        result.degraded
                          ? `${message}${t('（网格较大，本次实际用表面距离计算）')}`
                          : message
                      )
                    }}
                  >
                    {t('自动计算权重')}
                  </button>
                  {/*
                    算法口径（三选一）与它贴在同一行：热扩散最接近参考编辑器的效果，
                    表面距离是省时版本，直线距离只作兜底。
                    下拉不摆「自动权重算法」这行标签 —— 宽度不够，标签会把下拉挤成两行；
                    它的含义由选项文字（热扩散 / 表面距离 / 直线距离）本身表达，完整名称留在 title 里。
                    说明文字跟着选中项变，收进 info 气泡。
                  */}
                  <select
                    className="hao-field h-[18px] min-w-0 flex-1 cursor-pointer bg-ink-900 text-3xs disabled:cursor-not-allowed disabled:opacity-40"
                    value={tools.autoMethod}
                    title={t('自动权重算法')}
                    onChange={(event) => tools.setAutoMethod(event.target.value as AutoWeightMethod)}
                  >
                    <option value="heat">{t('热扩散（默认）')}</option>
                    <option value="geodesic">{t('表面距离')}</option>
                    <option value="distance">{t('直线距离')}</option>
                  </select>
                  <InfoHint
                    text={
                      tools.autoMethod === 'heat'
                        ? t('热扩散：沿网格表面平滑扩散，骨骼弯曲处也连续；最慢，网格太大时自动退回「表面距离」')
                        : tools.autoMethod === 'geodesic'
                          ? t('表面距离：沿网格表面量距离再按 1/d 衰减分配，比热扩散快，骨骼弯曲处过渡会有突跳')
                          : t('直线距离：按空间直线距离衰减，最快；手臂贴着身体这类贴身部件会串味，只作兜底')
                    }
                  />
                </div>
                {/*
                  Spine 的 Prune：丢掉过小的权重 + 把每顶点影响数压到上限。
                  导出/运行时每顶点只有 4 槽（compile.normalizeWeights → hao2dWriter），
                  所以上限默认就是 4 —— 面板百分比与导出结果从此对得上。
                  与 Spine 的差别：不实时改文档，只显示「将移除 N 个影响」的计数预览，点按钮才提交。
                */}
                <div className="flex flex-col gap-1">
                  {overInfluenced > 0 ? (
                    <div className="flex flex-col gap-1 rounded border border-warn/40 bg-warn/10 px-1.5 py-1">
                      <span className="text-3xs leading-relaxed text-warn">
                        {t('{0} 个顶点受超过 {1} 根骨骼影响：导出/运行时只保留权重最高的 {1} 根', [overInfluenced, 4])}
                      </span>
                      <button
                        type="button"
                        className="hao-btn h-[18px] w-full px-2 text-3xs"
                        title={t('只按上限修剪、不动阈值：直接把每顶点的影响骨骼数压到上限')}
                        onClick={() => runTrim(4, 0)}
                      >
                        {t('一键修剪到 {0} 根', 4)}
                      </button>
                    </div>
                  ) : null}
                  {/* 修剪按钮 + 上限 / 阈值 + 说明图标同一条线：它们说的本来就是同一件事，拆两行只是白占高度 */}
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      className="hao-btn h-[20px] min-w-0 flex-1 px-2 text-3xs"
                      disabled={!attachment.vertices.some((vertex) => vertex.weights.length > 0)}
                      title={t('修剪：丢掉小于阈值的权重，并把每个顶点的影响骨骼数压到上限；有选中顶点时只处理选中的那些。移除的权重按比例分给剩下的骨骼')}
                      onClick={() => runTrim(tools.trim.maxInfluences, tools.trim.threshold / 100)}
                    >
                      {t('修剪权重（{0} 骨）', tools.trim.maxInfluences)}
                    </button>
                    <span className="shrink-0 text-3xs text-content-lo">{t('上限')}</span>
                    <CommitTextField
                      className="hao-field h-[18px] w-[34px] shrink-0 text-right font-mono text-3xs"
                      value={String(tools.trim.maxInfluences)}
                      inputMode="numeric"
                      scrub
                      title={t('每顶点最多保留几根骨骼（1~4）：运行时与导出固定只有 4 槽，调小是给「骨骼越少越省」的管线留余量')}
                      sanitize={(raw) => {
                        const next = Math.round(Number(raw))
                        return Number.isFinite(next) ? String(Math.min(4, Math.max(1, next))) : null
                      }}
                      onCommit={(next) => tools.setTrim({ maxInfluences: Number(next) })}
                    />
                    <span className="shrink-0 text-3xs text-content-lo">{t('阈值')}</span>
                    <CommitTextField
                      className="hao-field h-[18px] w-[40px] shrink-0 text-right font-mono text-3xs"
                      value={String(tools.trim.threshold)}
                      inputMode="numeric"
                      scrub
                      title={t('丢掉小于这个百分比的权重（0 = 只按上限截断）；每个顶点至少保留权重最大的一项')}
                      sanitize={(raw) => {
                        const next = Math.round(Number(raw))
                        return Number.isFinite(next) ? String(Math.min(100, Math.max(0, next))) : null
                      }}
                      onCommit={(next) => tools.setTrim({ threshold: Number(next) })}
                    />
                    <span className="shrink-0 text-3xs text-content-lo">%</span>
                    <InfoHint
                      text={t('导出/运行时每顶点只取 4 根骨骼：先在这里修剪，刷出来的百分比才和导出结果一致')}
                    />
                  </div>
                  {/* 只留实时预览：这是「点下去会改几个顶点」的反馈，不能藏进气泡 */}
                  {trimPreview && trimPreview.touched > 0 ? (
                    <p className="text-3xs leading-relaxed text-content-lo">
                      {t('将移除 {0} 个骨骼影响，{1} 个顶点会被改写（点上面的按钮才生效）', [
                        trimPreview.removed,
                        trimPreview.touched
                      ])}
                    </p>
                  ) : null}
                </div>
                {/*
                  不加高度上限、也不给滚动条：绑定骨骼可能十几根，列表被截断的话
                  得先滚动才看得到自己在调哪一根（尤其是选中顶点后每行都带滑块的时候）。
                  面板本身可以滚，整份列表跟着走就行。
                */}
                <div className="flex flex-col gap-0.5 rounded border border-line bg-ink-900/60 p-1">
                  {weightBones.length === 0 ? (
                    <span className="px-1 py-0.5 text-3xs leading-relaxed text-content-lo">
                      {t('还没有绑定骨骼：点上面的按钮进入绑定状态，再在视口里点选骨骼（可连续点选多根）')}
                    </span>
                  ) : (
                    weightBones.map((name, index) => {
                      /*
                       * 选中某个顶点时，这一行**就地**变成「该顶点在这根骨骼上的权重」：
                       * 色块 + 骨骼名 + 滑块 + 百分比（未选中顶点时是色块 + 名字 + 移除按钮）。
                       *
                       * 列表与顶点权重本来就是同一份数据的两面，拆成上下两块只会让人对着
                       * 两遍同样的骨骼名来回找对应关系。
                       */
                      const vertexSelected =
                        selection.vertex >= 0 && selection.vertex < attachment.vertices.length
                      const percent = vertexSelected
                        ? Math.round(
                            (attachment.vertices[selection.vertex].weights.find((item) => item.bone === name)
                              ?.weight ?? 0) * 100
                          )
                        : 0
                      // 只绑了一根骨骼时它必然是 100%，滑块没有可调空间
                      const locked = weightBones.length < 2
                      return (
                        <div
                          key={name}
                          className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-ink-700/60"
                        >
                          {/* 色块与视口的顶点着色同源（按列表位置取色），两边能一眼对上 */}
                          <span
                            className="size-2.5 shrink-0 rounded-[2px] border border-black/40"
                            style={{ background: weightPaletteColor(index) }}
                          />
                          <span className="min-w-0 flex-1 truncate text-3xs" title={name}>
                            {name}
                          </span>
                          {vertexSelected ? (
                            <>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={percent}
                                disabled={locked}
                                className="h-[14px] w-[72px] shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
                                title={
                                  locked
                                    ? t('这个网格只绑了一根骨骼：它在每个顶点上必然是 100%')
                                    : t('「{0}」在顶点 #{1} 上的权重（其余骨骼按比例分享剩余部分）', [name, selection.vertex])
                                }
                                // 一次拖动 = 一条撤销记录：按下开事务，松开收尾，中途只 updateSilent
                                onPointerDown={() => useProjectStore.getState().beginTransaction(t('修改顶点权重'))}
                                onPointerUp={() => useProjectStore.getState().endTransaction()}
                                onChange={(event) =>
                                  useProjectStore.getState().updateSilent((draft) => {
                                    setVertexWeight(
                                      draft,
                                      slot.name,
                                      attachment.name,
                                      selection.vertex,
                                      name,
                                      Number(event.target.value) / 100
                                    )
                                  })
                                }
                              />
                              <CommitTextField
                                className="hao-field h-[20px] w-[44px] shrink-0 text-right font-mono text-3xs"
                                value={String(percent)}
                                disabled={locked}
                                inputMode="numeric"
                                scrub
                                title={t('权重百分比：失焦 / 回车生效；中键左右拖动可调')}
                                sanitize={(raw) => {
                                  const next = Math.round(Number(raw))
                                  return Number.isFinite(next)
                                    ? String(Math.min(100, Math.max(0, next)))
                                    : null
                                }}
                                onCommit={(next) =>
                                  update(t('修改顶点权重'), (draft) => {
                                    setVertexWeight(
                                      draft,
                                      slot.name,
                                      attachment.name,
                                      selection.vertex,
                                      name,
                                      Number(next) / 100
                                    )
                                  })
                                }
                              />
                              <span className="shrink-0 text-3xs text-content-lo">%</span>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 text-3xs text-content-lo hover:text-danger"
                              title={t('从列表移除，并清掉该骨骼在所有顶点上的权重')}
                              onClick={() => {
                                let removed = false
                                update(t('移除权重骨骼'), (draft) => {
                                  removed = removeWeightBone(draft, slot.name, attachment.name, name)
                                })
                                onStatus(removed ? t('已移除权重骨骼「{0}」', name) : t('「{0}」不在权重列表里', name))
                              }}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </FieldGroup>
            ) : null}

            {/*
              Spine 权重工具里的三个辅助动作：Swap / 复制 / 粘贴。
              范围与修剪一致 —— 选中顶点优先，否则整块网格（Spine 也是这个口径）。
            */}
            {attachment.type === 'mesh' ? (
              <FieldGroup
                title={t('权重操作')}
                actions={
                  <InfoHint
                    text={t('交换 / 粘贴都只改绑定姿态下的权重；复制的内容不写进工程文件')}
                  />
                }
              >
                <SelectField
                  label={t('交换 A')}
                  value={swapBones.a || weightBones[0] || ''}
                  options={weightBones.map((name) => ({ value: name, label: name }))}
                  onChange={(value) => setSwapBones((prev) => ({ ...prev, a: value }))}
                />
                <SelectField
                  label={t('交换 B')}
                  value={swapBones.b || weightBones[1] || ''}
                  options={weightBones.map((name) => ({ value: name, label: name }))}
                  onChange={(value) => setSwapBones((prev) => ({ ...prev, b: value }))}
                />
                <button
                  type="button"
                  className="hao-btn h-[20px] w-full px-2 text-3xs"
                  disabled={weightBones.length < 2}
                  title={t('在选中顶点上交换这两根骨骼的权重；没选顶点时改整块网格')}
                  onClick={runSwap}
                >
                  {t('交换这两根骨骼的权重')}
                </button>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="hao-btn h-[20px] flex-1 px-2 text-3xs"
                    title={t('复制选中顶点的权重（没选就整块网格），可粘到别的顶点或别的网格；目标网格没绑的骨骼会被丢掉')}
                    onClick={runCopyWeights}
                  >
                    {t('复制顶点权重')}
                  </button>
                  <button
                    type="button"
                    className="hao-btn h-[20px] flex-1 px-2 text-3xs"
                    disabled={clipboardCount === 0}
                    title={t('把剪贴板按顺序贴到选中顶点；数量不一致时只贴前面能对上的那些')}
                    onClick={runPasteWeights}
                  >
                    {t('粘贴顶点权重')}
                  </button>
                </div>
                {/* 剪贴板有内容时才提示（这是状态，不是说明）；静态说明已收进上面的 info 气泡 */}
                {clipboardCount > 0 ? (
                  <p className="text-3xs leading-relaxed text-content-lo">
                    {t('剪贴板里有 {0} 个顶点的权重（不写进工程文件）', clipboardCount)}
                  </p>
                ) : null}
              </FieldGroup>
            ) : null}

            {attachment.type === 'clipping' ? (
              <FieldGroup title={t('遮罩')}>
                <SelectField
                  label={t('结束插槽')}
                  value={attachment.clipEndSlot}
                  options={(() => {
                    const order = [...document.slots].sort((a, b) => a.zOrder - b.zOrder)
                    const at = order.findIndex((item) => item.name === slot.name)
                    return [
                      { value: '', label: t('到末尾') },
                      ...order.slice(at + 1).map((item) => ({ value: item.name, label: item.name }))
                    ]
                  })()}
                  onChange={(value) =>
                    update(t('修改遮罩结束插槽'), (draft) => {
                      patchAttachment(draft, slot.name, attachment.name, (item) => {
                        item.clipEndSlot = value
                      })
                    })
                  }
                />
                <ToggleField
                  label={t('反向遮罩')}
                  value={attachment.clipInverse}
                  hint={t('只保留多边形外部；Spine 要求此时按凸形处理')}
                  onChange={(value) =>
                    update(t('修改遮罩反向'), (draft) => {
                      patchAttachment(draft, slot.name, attachment.name, (item) => {
                        item.clipInverse = value
                        if (value) item.clipConvex = true
                      })
                    })
                  }
                />
                <ToggleField
                  label={t('凸多边形')}
                  value={attachment.clipConvex}
                  hint={t('多边形是凸的时候打开可加速；凹多边形请关掉')}
                  onChange={(value) =>
                    update(t('修改遮罩凸形'), (draft) => {
                      patchAttachment(draft, slot.name, attachment.name, (item) => {
                        item.clipConvex = value
                      })
                    })
                  }
                />
                <p className="text-3xs leading-relaxed text-content-lo">
                  {t('控制点 {0} 个 · 遮罩只影响绘制顺序中它之后、结束插槽之前的附件', [
                    attachment.vertices.length
                  ])}
                </p>
                <p className="text-3xs leading-relaxed text-content-lo/80">
                  {t('Animate 态用顶点工具（D）拖这些控制点写 FFD 关键帧')}
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="hao-btn h-[20px] flex-1 px-2 text-3xs"
                    onClick={() => {
                      tools.setTool('mask')
                      selection.selectAttachment(slot.name, attachment.name)
                      onStatus(t('遮罩工具：点边线插入点；拖点移动；Delete 删除；点空白取消选中'))
                    }}
                  >
                    {t('编辑遮罩点')}
                  </button>
                </div>
              </FieldGroup>
            ) : null}

            <div className="flex flex-wrap gap-1 pt-0.5">
              {/* 这里只留网格编辑操作（删顶点 / 还原为 Region / 删附件）；
                  「转为网格 / 自动生成网格」在同一面板最下面的「网格 / FFD」那一栏 ——
                  那边能现场改密度，是生成网格的统一入口，这里不再重复第二份 */}
              {attachment.type === 'mesh' ? (
                <>
                  {/*
                    删顶点是**顶点编辑**动作：只在网格 / FFD 工具下才显示。
                    别的时候它永远是灰的（选不中顶点，自然也删不了），摆在面板里只是噪音。
                    「还原为 Region / 删除附件」不算顶点编辑（不需要选中顶点），保持常显。
                  */}
                  {tools.tool === 'ffd' ? (
                    <button
                      type="button"
                      className="hao-btn h-[20px] px-2 text-3xs"
                      disabled={selection.vertices.length === 0}
                      title={
                        selection.vertices.length === 0
                          ? t('先在视口里点选一个顶点（网格 / FFD 工具）')
                          : t('删除选中的顶点，并用它的邻居重新三角化补洞')
                      }
                      onClick={() => {
                        const vertex = selection.vertices[0]
                        if (vertex === undefined) return
                        // 选中的是**共享缓冲**下标：换算成附件自己的顶点下标，
                        // 并以它为准确定附件（点选顶点不会改「选中的附件」，可能还停在上一个）
                        const ref = getActiveScene()?.vertexRefAt(vertex) ?? null
                        if (!ref) {
                          onStatus(t('顶点信息已过期：请在视口里重新点选顶点'))
                          return
                        }
                        let removed = false
                        update(t('删除网格顶点'), (draft) => {
                          removed = deleteMeshVertex(draft, ref.slot, ref.attachment, ref.vertex)
                        })
                        if (removed) selection.selectVertices([])
                        onStatus(
                          removed
                            ? t('已删除「{0}」的顶点 #{1}', [ref.attachment, ref.vertex])
                            : t('删除失败：顶点不存在或网格至少需要保留 3 个顶点')
                        )
                      }}
                    >
                      {t('删除选中顶点')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="hao-btn h-[20px] px-2 text-3xs"
                    title={t('清空网格顶点，退回成一张图片显示（由 Region 转来的会精确还原原尺寸与 UV）')}
                    onClick={() => {
                      let restored = false
                      update(t('还原为 Region'), (draft) => {
                        restored = convertMeshToRegion(draft, slot.name, attachment.name)
                      })
                      onStatus(
                        restored
                          ? t('已把「{0}」还原为 Region（顶点与 FFD 帧已一并清空）', attachment.name)
                          : t('还原失败（附件类型不是网格）')
                      )
                    }}
                  >
                    {t('还原为 Region')}
                  </button>
                </>
              ) : null}
              {mode === 'pose' &&
              (attachment.type === 'region' || attachment.type === 'mesh' || attachment.type === 'linkedmesh') ? (
                <button
                  type="button"
                  className="hao-btn h-[20px] px-2 text-3xs"
                  title={t('把当前显示转成多边形遮罩（保留附件名；加权网格暂不支持）')}
                  onClick={() => {
                    // 转为遮罩改的是绑定数据：Animate 态不要偷偷写 setup
                    if (mode !== 'pose') {
                      onStatus(t('切到 Pose 状态才能把附件转为遮罩'))
                      return
                    }
                    let converted = false
                    update(t('转为遮罩'), (draft) => {
                      converted = convertAttachmentToClipping(draft, slot.name, attachment.name)
                    })
                    if (converted) {
                      // 转换后立即进入遮罩工具：接着就能点边线插点 / 拖控制点
                      selection.selectAttachment(slot.name, attachment.name)
                      tools.setTool('mask')
                    }
                    onStatus(
                      converted
                        ? t('已把「{0}」转为遮罩并切换到遮罩工具：点边线插点、拖点调整、Delete 删除', [
                            attachment.name
                          ])
                        : t('转换失败：加权网格暂不支持，请先解除权重或手工绘制遮罩')
                    )
                  }}
                >
                  {t('转为遮罩')}
                </button>
              ) : null}
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs hover:border-danger/50 hover:text-danger"
                onClick={() => {
                  update(t('删除附件'), (draft) => {
                    deleteAttachment(draft, slot.name, attachment.name)
                  })
                  selection.selectSlot(slot.name)
                  onStatus(t('已删除附件「{0}」', attachment.name))
                }}
              >
                {t('删除附件')}
              </button>
            </div>
          </FieldGroup>
        ) : null}
        {/*
          网格 / FFD：把选中的 displayObject 转成网格的入口 + 密度参数，放在属性面板**最下面**。

          **只要选中的还不是 Mesh 就显示**，与当前工具无关 —— 想转网格时不必先切到网格工具；
          已经转成 Mesh 的附件不再显示它，改由上面的网格编辑操作（删顶点 / 还原为 Region /
          删除附件）接手。
          密度 = 生成 / 重设网格时的栅格细分（Region → 规则栅格网格，或沿不透明轮廓重设为贴合网格）。

          Animate 态整个右栏是收起的（见 App），所以不必再写「请切到 Pose 态」的提示。
        */}
        {/*
          遮罩不能用「转为网格 / 自动生成网格」：它的点是多边形控制点，不是可蒙皮的渲染网格。
          遮罩的 FFD 直接走顶点工具（D）写 deform 轨道，不需要这一栏。
        */}
        {/*
          链接网格也不给这一栏：几何来自源网格，转网格 / 按轮廓生成都只能对图片（Region）做，
          摆出来只会点出一个「只有图片能转网格」的报错。
        */}
        {attachment && attachment.type !== 'mesh' && attachment.type !== 'linkedmesh' && attachment.type !== 'clipping' ? (
          <FieldGroup title={t('网格 / FFD')}>
            <NumberField
              label={t('密度')}
              value={tools.gridDivisions}
              step={1}
              min={1}
              max={24}
              precision={0}
              onChange={(value) => tools.setGridDivisions(value)}
            />
            <p className="flex items-center gap-1 text-3xs text-content-lo">
              <Grid3x3 size={10} />
              {t('生成 / 重设网格时的栅格细分（{0}×{1}）：越大顶点越密、越贴合形状', [tools.gridDivisions, tools.gridDivisions])}
            </p>
            <div className="flex flex-wrap gap-1 pt-0.5">
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs"
                title={t('把选中的图片（Region）按密度切分成规则栅格网格并三角化，之后可用权重刷 / 顶点工具编辑')}
                onClick={() => onStatus(buildGridMesh(tools.gridDivisions).message)}
              >
                {t('转为网格（{0}×{1}）', [tools.gridDivisions, tools.gridDivisions])}
              </button>
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs"
                title={t('沿图片不透明像素的轮廓生成贴合网格（透明区域不占三角形）；密度控制顶点数量级，也可用来重设手动编辑过的网格')}
                onClick={() => onStatus(buildOutlineMesh(tools.gridDivisions).message)}
              >
                {t('自动生成网格')}
              </button>
            </div>
          </FieldGroup>
        ) : null}
        {toolSections}
      </div>
    )
  }

  const constraint = document.constraints.find((c) => c.name === selection.constraint)
  if (!constraint) return <PanelEmpty title={t('约束不存在')} description={t('该约束可能已被删除，请重新选择。')} />

  return (
    <div className="flex flex-col">
      {/*
        专用「约束」页：从时间轴轨道 / 根层孤儿行进入（物理约束、目标或驱动骨缺失的约束）。
        字段与宿主面板的内嵌分组同源（见 ConstraintEditor），这里补上名称与顺序两项目录信息
      */}
      <ConstraintEditor
        document={document}
        constraint={constraint}
        update={update}
        revealBone={revealBone}
        nameField={
          <TextField
            label={t('名称')}
            value={constraint.name}
            commitOnBlur
            onChange={(next) =>
              rename('constraint', constraint.name, next, {
                label: t('约束'),
                reselect: () => selection.selectConstraint(next.trim())
              })
            }
          />
        }
        orderField={
          <NumberField
            label={t('顺序')}
            value={constraint.order}
            precision={0}
            onChange={(value) => update(t('修改约束顺序'), (draft) => { const item = draft.constraints.find((c) => c.name === constraint.name); if (item) item.order = value })}
          />
        }
      />
      {toolSections}
    </div>
  )
}

