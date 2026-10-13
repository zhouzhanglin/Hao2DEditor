import { Brush, Crosshair, Grid3x3, Layers, RotateCcw, Trash2 } from 'lucide-react'
import { BlendMode } from '@core/model/types'
import { curvePercent } from '@core/anim/interpolation'
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
  convertMeshToRegion,
  deleteAttachment,
  deleteMeshVertex,
  patchAttachment,
  PPU,
  removeWeightBone,
  resolveAttachment,
  setVertexWeight,
  weightBonesOf
} from '@editor/commands/authoringCommands'
import { runAutoWeightsForBones } from '@editor/tools/authoringTools'
import { buildGridMesh, buildOutlineMesh } from '@editor/commands/meshActions'
import type { RenameKind } from '@editor/commands/authoringCommands'
import type { AuthoringConstraint, EditorDocument } from '@core/model/authoring'
import { rootBoneName } from '@core/model/authoring'
import { isDescendantOf } from '@editor/commands/hierarchyCommands'
import { weightPaletteColor } from '@core/weightPalette'
import {
  CheckboxField,
  ColorField,
  CommitTextField,
  FieldGroup,
  NumberField,
  SelectField,
  SliderField,
  TextField,
  ToggleField,
  Vector2Field
} from '@ui/widgets/fields'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { BLEND_OPTIONS, CONSTRAINT_LABEL } from '@ui/widgets/constants'

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
  update('删除约束', (draft) => {
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

  /** 「目标」的写入口：下拉选择与「从层级树拖骨骼进来」共用（拖进来的骨骼一定存在） */
  const setTargetBone = (name: string): void => {
    if (name === constraint.target) return
    update('修改约束目标', (draft) => {
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
      const t = draft.constraints.find((c) => c.name === constraint.name)
      if (t && t.type === 'ik') t.mix = value
    }
    if (silent) useProjectStore.getState().updateSilent(mutate)
    else update('修改IK权重', mutate)
  }

  /** 链内换位：越靠前越接近链根，越靠后越接近链尾 */
  const moveChainBone = (from: number, to: number) => (): void => {
    editChain('调整受约束骨骼顺序', (bones) => {
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
            ? `${CONSTRAINT_LABEL[constraint.type]}约束 · ${constraint.name}`
            : `${CONSTRAINT_LABEL[constraint.type]}约束`
        }
      >
        {nameField}
        {orderField}
        <ToggleField
          label="启用"
          value={constraint.enabled}
          onChange={(value) => update('启停约束', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t) t.enabled = value })}
        />
        {/*
          内嵌的 IK 不显示「目标」：目标就是宿主骨骼本身（「目标骨即 IK 节点」）。
          要把 IK 挪到别的骨上，走「约束」页（时间轴轨道点进去）或删了重配
        */}
        {(!embedded || constraint.type !== 'ik') ? (
          <SelectField
            label="目标"
            value={constraint.target}
            options={[{ value: '', label: '（无）' }, ...document.bones.map((b) => ({ value: b.name, label: b.name }))]}
            onChange={setTargetBone}
            onDropBone={setTargetBone}
            trailing={
              <button
                type="button"
                disabled={!targetBoneExists}
                title={
                  targetBoneExists
                    ? `在层级树里定位「${constraint.target}」`
                    : '还没有可定位的目标骨骼'
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
          IK 静默失效的两个坑：「没选目标」和「链是空的」——求解器直接返回，
          视口里看不出任何异常。这里就地提醒，比等编译告警直观
        */}
        {constraint.type === 'ik' && !targetBoneExists ? (
          <span className="text-3xs text-warn">
            {constraint.target ? `目标骨骼「${constraint.target}」不存在，IK 不会生效` : '没有目标骨骼，IK 不会生效'}
          </span>
        ) : null}
        {constraint.type === 'ik' && chainBones.length === 0 ? (
          <span className="text-3xs text-warn">受约束骨骼链是空的，IK 不会生效</span>
        ) : null}
        <div className="flex flex-col gap-1">
          <span className="text-3xs text-content-lo">
            受约束骨骼链（
            {/*
              求解器对任何非空链都生效：单骨 = 让链尾指向目标（CCD），两骨走解析解，
              更长的链走 CCD 迭代。原来写「至少要两根」与实现不符（单骨也能求解）。
            */}
            {constraint.type === 'ik' ? '链根 → 链尾，IK 按这个顺序驱动（单骨 = 让链尾指向目标，两骨及以上逐节弯曲）' : '按顺序排布'}
            ）
            {constraint.type === 'physics' ? ' · 物理约束仅保留数据，不参与求解' : ''}
          </span>
          {chainBones.length === 0 ? <span className="text-3xs text-content-lo">（未设置）</span> : null}
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
                title={`在层级树里定位「${name}」`}
                onClick={() => revealBone(name)}
              >
                <Crosshair size={11} />
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-content-hi disabled:opacity-30 disabled:hover:text-content-lo"
                disabled={index === 0}
                title="上移（越靠前越接近链根）"
                onClick={moveChainBone(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-content-hi disabled:opacity-30 disabled:hover:text-content-lo"
                disabled={index === chainBones.length - 1}
                title="下移（越靠后越接近链尾）"
                onClick={moveChainBone(index, index + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="shrink-0 text-3xs text-content-lo hover:text-danger"
                title="从受约束骨骼链里移除（约束本身不受影响）"
                onClick={() => editChain('移除受约束骨骼', (bones) => {
                  const at = bones.indexOf(name)
                  if (at >= 0) bones.splice(at, 1)
                })}
              >
                ×
              </button>
            </div>
          ))}
          <SelectField
            label="添加骨骼"
            value=""
            disabled={chainCandidates.length === 0}
            options={[
              { value: '', label: chainCandidates.length > 0 ? '（选择骨骼加到链尾）' : '（没有可添加的骨骼）' },
              ...chainCandidates.map((bone) => ({ value: bone.name, label: bone.name }))
            ]}
            onChange={(value) => {
              if (!value) return
              editChain('添加受约束骨骼', (bones) => bones.push(value))
            }}
            // 从层级树直接拖骨骼过来 = 加到链尾，省得在下拉里翻
            onDropBone={(name) => {
              if (chainBones.includes(name)) return
              editChain('添加受约束骨骼', (bones) => bones.push(name))
            }}
          />
          <span className="text-3xs text-content-lo">「目标」和「添加骨骼」都能从层级树拖骨骼进来</span>
        </div>
      </FieldGroup>

      {constraint.type === 'ik' ? (
        <FieldGroup title="IK 参数">
          <SliderField
            label="权重"
            value={constraint.mix}
            step={0.05}
            min={0}
            max={1}
            transaction="修改IK权重"
            onChange={editIkMix}
          />
          <SelectField
            label="弯曲"
            value={String(constraint.bendSign)}
            options={[{ value: '1', label: '正向 (+1)' }, { value: '-1', label: '反向 (-1)' }]}
            onChange={(value) => update('修改IK弯曲方向', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'ik') t.bendSign = Number(value) })}
          />
          <ToggleField
            label="用骨长"
            value={constraint.useBoneLength}
            onChange={(value) => update('修改IK长度取法', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'ik') t.useBoneLength = value })}
          />
        </FieldGroup>
      ) : null}

      {constraint.type === 'transform' ? (
        <FieldGroup title="变换混合">
          {(
            [
              ['mixRotate', '旋转'],
              ['mixX', 'X 位移'],
              ['mixY', 'Y 位移'],
              ['mixScaleX', 'X 缩放'],
              ['mixScaleY', 'Y 缩放'],
              ['mixShearY', '斜切']
            ] as const
          ).map(([key, label]) => (
            <NumberField
              key={key}
              label={label}
              value={constraint[key]}
              step={0.05}
              min={0}
              max={1}
              onChange={(value) =>
                update('修改变换约束', (draft) => {
                  const t = draft.constraints.find((c) => c.name === constraint.name)
                  if (t && t.type === 'transform') t[key] = value
                })
              }
            />
          ))}
        </FieldGroup>
      ) : null}

      {constraint.type === 'path' ? (
        <FieldGroup title="路径参数">
          <NumberField
            label="位置"
            value={constraint.position}
            step={0.02}
            onChange={(value) => update('修改路径位置', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'path') t.position = value })}
          />
          <NumberField
            label="间距"
            value={constraint.spacing}
            step={0.02}
            onChange={(value) => update('修改路径间距', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'path') t.spacing = value })}
          />
          <NumberField
            label="旋转混合"
            value={constraint.rotateMix}
            step={0.05}
            min={0}
            max={1}
            onChange={(value) => update('修改路径旋转混合', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'path') t.rotateMix = value })}
          />
          <NumberField
            label="位移混合"
            value={constraint.translateMix}
            step={0.05}
            min={0}
            max={1}
            onChange={(value) => update('修改路径位移混合', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'path') t.translateMix = value })}
          />
        </FieldGroup>
      ) : null}

      {/*
        内嵌分组的移除入口：树里已没有 IK / 变换 / 路径约束行，得有个明确的「拆除」按钮 ——
        移除后宿主骨骼还原为普通骨骼（行首图标自动变回骨骼），该约束在时间轴上的轨道一并清掉
      */}
      {embedded && onDelete ? (
        <div className="px-2 py-2">
          <button
            type="button"
            title="移除这条约束：本骨骼还原为普通骨骼；它在时间轴上的关键帧轨道一并删除"
            className="hao-btn flex h-[22px] w-full items-center justify-center gap-1 border-danger/40 text-danger/90 hover:border-danger hover:bg-danger/10"
            onClick={onDelete}
          >
            <Trash2 size={11} />
            <span>移除{CONSTRAINT_LABEL[constraint.type]}约束</span>
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
  const selection = useSelectionStore()
  const tools = useToolStore()
  const mode = useModeStore((s) => s.mode)
  // 节流跟随播放头：这里只是「当前时间」的取值，没必要每帧重渲染整块属性面板
  const time = useThrottledPlayheadTime(400)
  const currentAnimation = useTimelineStore((s) => s.currentAnimation)
  /** Animate 态切显示附件 = 打 displayIndex 关键帧；Pose 态才是改绑定姿态 */
  const animating = mode === 'animate' && !!currentAnimation
  /** 「定位」：让层级树滚到某根骨骼并闪一下（只提示位置，不改选中 —— 见 locateBone） */
  const revealBone = useRevealStore((s) => s.revealBone)

  /**
   * 删除寄宿在骨骼面板里的约束：Animate 态拒绝（改的是绑定数据，与层级树同一套保护）。
   * 树里已没有 IK / 变换 / 路径约束行，这个按钮是它们的删除入口。
   */
  const deleteHostedConstraint = (name: string): void => {
    if (mode !== 'pose') {
      onStatus('切到 Pose 状态才能改绑定数据（骨骼 / 插槽 / display / 约束）')
      return
    }
    removeConstraint(update, name)
    onStatus(`已删除约束「${name}」`)
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
    update(`重命名${label}`, (draft) => {
      applyRename(draft, { kind, slot: options?.slot }, oldName, next)
    })
    options?.reselect?.()
    onStatus(`「${oldName}」已重命名为「${next}」`)
  }

  /**
   * 把 Region 附件的「尺寸」恢复到它的图片大小：像素 ÷ PPU，与拖图创建时
   * `regionAttachmentFromImage` 算出的初始值同一口径。改乱了想找回原尺寸时点一下。
   */
  const resetAttachmentSize = (slotName: string, attachmentName: string, imageName: string): void => {
    const image = document.images.find((item) => item.name === imageName)
    if (!image) {
      onStatus(`找不到图片「${imageName}」：它可能已被删除，先在「图片」下拉里换一张`)
      return
    }
    const size = { x: Math.max(1, image.width) / PPU, y: Math.max(1, image.height) / PPU }
    update('恢复附件尺寸', (draft) => {
      patchAttachment(draft, slotName, attachmentName, (a) => {
        a.size = size
      })
    })
    onStatus(`已把「${attachmentName}」的尺寸恢复到图片大小（${image.width} × ${image.height} px）`)
  }

  /**
   * 权重刷的目标骨骼 —— 就是选中数据里的 `bone` 字段，**与 `kind` 无关**：
   * 刷权重时 kind 常常是 attachment（那才是要刷的网格），骨骼只作"刷哪一根"用；
   * 这里若按 kind 过滤，面板的 Bone 就会在真正开刷时显示成「（未选）」。
   */
  const brushBone = selection.bone

  /**
   * 「工具选项」面板（已删除）里原本剩下的两块设置，并到属性面板底部。
   *
   * - **权重刷**：只在权重刷工具 + Pose 态显示 —— 工具本身只在 Pose 态可用，其余时候摆出来是噪音；
   * - **显示 / 整体染色**：随时可调，用来快速检查插槽色 / 附件色的叠加效果。
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
        <FieldGroup title="权重刷">
          {/* 参数与 Unity 2D Animation 的 Weight Brush 面板同名：Mode / Bone / Normalize / Size / Hardness */}
          <SelectField
            label="Mode"
            value={tools.brush.mode}
            options={[
              { value: 'addSubtract', label: 'Add and Subtract（增加 / Alt 减少）' },
              { value: 'growShrink', label: 'Grow and Shrink（只动已受影响的顶点）' },
              { value: 'smooth', label: 'Smooth（朝邻居平均）' }
            ]}
            onChange={(value) => tools.setBrush({ mode: value as BrushModeSetting })}
          />
          {/* Bone 只改「刷哪根骨骼」，不动当前选中对象 —— 权重刷要求附件保持选中（那才是要刷的网格） */}
          <SelectField
            label="Bone"
            value={brushBone}
            options={[
              { value: '', label: '（未选）' },
              ...document.bones.map((bone) => ({ value: bone.name, label: bone.name }))
            ]}
            onChange={(value) => useSelectionStore.getState().select({ bone: value })}
          />
          <CheckboxField
            label="Normalize"
            value={tools.brush.normalize}
            onChange={(value) => tools.setBrush({ normalize: value })}
            hint="刷过的顶点权重归一到 1；关掉就只改目标骨骼，权重和可能不等于 1"
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
            label="Hardness"
            value={tools.brush.hardness}
            step={0.5}
            min={0.1}
            max={100}
            onChange={(value) => tools.setBrush({ hardness: value })}
          />
          <p className="flex items-center gap-1 text-3xs text-content-lo">
            <Brush size={10} />
            Hardness 100 = 一次刷满；按住修饰键临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长
          </p>
        </FieldGroup>
      ) : null}
      <FieldGroup title="显示">
        <ColorField
          label="整体染色"
          value="#FFFFFFFF"
          onChange={(value) => {
            const scene = getActiveScene()
            if (!scene) return
            const hex = value.replace('#', '')
            const at = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255
            scene.setTint({ r: at(0), g: at(2), b: at(4), a: hex.length >= 8 ? at(6) : 1 })
          }}
        />
        <p className="flex items-center gap-1 text-3xs text-content-lo">
          <Layers size={10} />
          染色与插槽色、附件色相乘，用于快速检查叠加效果
        </p>
      </FieldGroup>
    </>
  )

  if (selection.kind === 'none') {
    return (
      <PanelEmpty
        title="未选中对象"
        description="在层级树或视口中选中骨骼、插槽、附件或约束后，可在此编辑其属性。"
      />
    )
  }

  if (selection.kind === 'bone') {
    const bone = document.bones.find((b) => b.name === selection.bone)
    if (!bone) return <PanelEmpty title="骨骼不存在" description="该骨骼可能已被删除，请重新选择。" />
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
        update(`${label}（${time.toFixed(2)}s 打关键帧）`, (draft) => {
          const target = draft.animations.find((item) => item.name === currentAnimation)
          if (target) keyBoneChannel(target, bone.name, channel, time, value as never)
        })
        return
      }
      update(`修改骨骼${label}`, (draft) => {
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
        <FieldGroup title="骨骼">
          <TextField
            label="名称"
            value={bone.name}
            commitOnBlur
            onChange={(next) => rename('bone', bone.name, next, { label: '骨骼', reselect: () => selection.selectBone(next.trim()) })}
          />
          {/*
            父级下拉只列**层级树里能拖成的那些组合**：层级根骨骼不可选父级（其他骨骼都在它之下），
            其余骨骼也只列「不是自己、也不在自己子树里」的目标 —— 拖进自己的后代会把层级绕成环。
          */}
          <SelectField
            label="父级"
            value={bone.parent}
            disabled={animating || isRootBone}
            options={[
              ...(isRootBone
                ? [{ value: '', label: '（层级根骨骼）' }]
                : bone.parent
                  ? []
                  : [{ value: '', label: '（未挂载）' }]),
              ...document.bones
                .filter((b) => b.name !== bone.name && !isDescendantOf(document.bones, b.name, bone.name))
                .map((b) => ({ value: b.name, label: b.name }))
            ]}
            onChange={(value) =>
              update('修改骨骼父级', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.parent = value
              })
            }
          />
          {isRootBone ? (
            <p className="text-3xs text-content-lo">层级根骨骼：其他骨骼都在它之下，它没有父级</p>
          ) : null}
          <NumberField
            label="长度"
            value={bone.length}
            step={0.05}
            min={0}
            precision={3}
            disabled={animating}
            onChange={(value) =>
              update('修改骨骼长度', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.length = value
              })
            }
          />
          {animating ? (
            <p className="text-3xs text-content-lo">父级 / 长度属于绑定数据，切到 Pose 状态再改</p>
          ) : null}
        </FieldGroup>

        <FieldGroup
          title={animating ? `动画变换 · ${time.toFixed(2)}s（改动即打关键帧）` : '局部变换（Setup）'}
        >
          {/* 位置是浮点值：中键拖动 / 上下键都按 0.1 走（不写 step 会用 Vector2Field 的默认值 1，拖起来只能整数跳） */}
          <Vector2Field
            label="位置"
            value={shown.position}
            step={0.1}
            onChange={(value) => writeTransform('translate', value, '位置')}
          />
          <NumberField
            label="旋转"
            value={shown.rotation}
            step={1}
            suffix="°"
            onChange={(value) => writeTransform('rotate', value, '旋转')}
          />
          <Vector2Field
            label="缩放"
            value={shown.scale}
            step={0.1}
            onChange={(value) => writeTransform('scale', value, '缩放')}
          />
          <Vector2Field
            label="斜切"
            value={shown.shear}
            step={0.1}
            onChange={(value) => writeTransform('shear', value, '斜切')}
          />
        </FieldGroup>

        <FieldGroup title="继承">
          <ToggleField
            label="继承旋转"
            value={bone.inheritRotation}
            onChange={(value) =>
              update('修改继承旋转', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.inheritRotation = value
              })
            }
          />
          <ToggleField
            label="继承缩放"
            value={bone.inheritScale}
            onChange={(value) =>
              update('修改继承缩放', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.inheritScale = value
              })
            }
          />
          <ColorField
            label="显示色"
            value={bone.color}
            onChange={(value) =>
              update('修改骨骼颜色', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.color = value
              })
            }
          />
          <CheckboxField
            label="画法"
            value={bone.hollow === true}
            hint="空心（默认实心）"
            onChange={(value) =>
              update('修改骨骼画法', (draft) => {
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
    if (!slot) return <PanelEmpty title="插槽不存在" description="该插槽可能已被删除，请重新选择。" />
    const skinSlot = document.skins.find((s) => s.name === selection.skin)?.slots.find((s) => s.slot === slot.name)
      ?? document.skins[0]?.slots.find((s) => s.slot === slot.name)
    // 附件解析走「皮肤优先、跨皮肤兜底」：切过皮肤后不该让检查器整段空掉（与视口同一套规则）
    const attachment = resolveAttachment(document, slot.name, selection.attachment, selection.skin)
    // 权重骨骼列表：优先用附件上显式绑定的（老数据按顶点权重推断，见 weightBonesOf）
    const weightBones = attachment && attachment.type === 'mesh' ? weightBonesOf(attachment) : []
    /** 是否正在为**这个**附件等待点选骨骼（等待态是全局的，按钮只在目标附件上高亮） */
    const pickingWeightBone =
      tools.pendingWeightBone?.slot === selection.slot &&
      tools.pendingWeightBone?.attachment === selection.attachment

    return (
      <div className="flex flex-col">
        <FieldGroup title="插槽">
          <TextField
            label="名称"
            value={slot.name}
            commitOnBlur
            onChange={(next) => rename('slot', slot.name, next, { label: '插槽', reselect: () => selection.selectSlot(next.trim()) })}
          />
          <SelectField
            label="骨骼"
            value={slot.bone}
            options={document.bones.map((b) => ({ value: b.name, label: b.name }))}
            onChange={(value) =>
              update('修改插槽骨骼', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.bone = value
              })
            }
          />
          <SelectField
            label="混合"
            value={String(slot.blendMode)}
            options={BLEND_OPTIONS}
            onChange={(value) =>
              update('修改混合模式', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.blendMode = Number(value) as BlendMode
              })
            }
          />
          <NumberField
            label="层序"
            value={slot.zOrder}
            step={1}
            precision={0}
            onChange={(value) =>
              update('修改插槽层序', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.zOrder = value
              })
            }
          />
          <ColorField
            label="颜色"
            value={slot.color}
            onChange={(value) =>
              update('修改插槽颜色', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.color = value
              })
            }
          />
          <SelectField
            label={animating ? '显示（关键帧）' : 'setup 显示'}
            value={slot.attachment}
            options={[{ value: '', label: '（不显示）' }, ...(skinSlot?.attachments ?? []).map((a) => ({ value: a.name, label: a.name }))]}
            onChange={(value) => {
              const attachments = skinSlot?.attachments ?? []
              const index = attachments.findIndex((item) => item.name === value)
              if (animating) {
                // 换装动画：Animate 态只写关键帧，不动绑定姿态
                update('关键帧：切换显示', (draft) => {
                  const animation = draft.animations.find((item) => item.name === currentAnimation)
                  if (animation) keySlotDisplay(animation, slot.name, time, value ? index : -1, value)
                })
                onStatus(
                  value
                    ? `已在 ${time.toFixed(3)}s 打关键帧：插槽「${slot.name}」显示「${value}」`
                    : `已在 ${time.toFixed(3)}s 打关键帧：插槽「${slot.name}」不显示`
                )
                return
              }
              update('修改 setup 附件', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.attachment = value
              })
            }}
          />
          <div className="flex items-center gap-1">
            <ToggleField
              label={animating ? '可见（关键帧）' : '可见'}
              value={slot.visible}
              onChange={(value) =>
                animating
                  ? update('关键帧：切换可见性', (draft) => {
                      const animation = draft.animations.find((item) => item.name === currentAnimation)
                      if (animation) keySlotVisible(animation, slot.name, time, value)
                    })
                  : update('修改插槽可见性', (draft) => {
                      const target = draft.slots.find((s) => s.name === slot.name)
                      if (target) target.visible = value
                    })
              }
            />
          </div>
        </FieldGroup>

        {attachment ? (
          <FieldGroup title={`附件 · ${attachment.type}`}>
            <TextField
              label="名称"
              value={attachment.name}
              commitOnBlur
              onChange={(next) =>
                rename('attachment', attachment.name, next, {
                  slot: slot.name,
                  label: '附件',
                  reselect: () => selection.selectAttachment(slot.name, next.trim())
                })
              }
            />
            <SelectField
              label="图片"
              value={attachment.image}
              options={[
                { value: '', label: '（纯色）' },
                ...document.images.map((image) => ({ value: image.name, label: image.name }))
              ]}
              onChange={(value) =>
                update('修改附件图片', (draft) => {
                  patchAttachment(draft, slot.name, attachment.name, (a) => {
                    a.image = value
                  })
                })
              }
            />
            {/* 同骨骼位置：浮点值按 0.1 拖（默认 1 会让中键拖动只能整数跳） */}
            <Vector2Field
              label="位置"
              value={attachment.position}
              step={0.1}
              onChange={(value) => update('修改附件位置', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.position = value }))}
            />
            <NumberField
              label="旋转"
              value={attachment.rotation}
              suffix="°"
              onChange={(value) => update('修改附件旋转', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.rotation = value }))}
            />
            <Vector2Field
              label="缩放"
              value={attachment.scale}
              step={0.1}
              onChange={(value) => update('修改附件缩放', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.scale = value }))}
            />
            {/*
              尺寸：**Region 的内容矩形**（图集里那块有像素的区域）—— 渲染的四边形与栅格网格按它走。
              被裁剪过的图，选中轮廓 / 变换手柄按**原图尺寸**走（下面那行只读提示），
              于是框包含被裁掉的空白 —— 与 DragonBones / Spine 编辑器的显示一致。
              网格附件不显示它：网格的形状完全由顶点决定（选中轮廓也走顶点），
              改这个数在视口里看不出任何变化，只会在「自动生成网格」按它映射尺寸时
              产生看不出来的偏差。原值仍留在数据里（「还原为 Region」与重新生成都要用）。
            */}
            {attachment.type !== 'mesh' ? (
              <Vector2Field
                label="尺寸"
                value={attachment.size}
                step={0.05}
                onChange={(value) => update('修改附件尺寸', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.size = value }))}
                // 行尾小图标：一键恢复到图片大小（仅 Region；纯色附件没有图可恢复，不显示）
                action={
                  attachment.type === 'region' && attachment.image ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      title="恢复到图片大小（按图片像素 ÷ PPU 折算，与拖图创建时一致）"
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
                原图（含裁剪留白）：{attachment.frameSize.x.toFixed(2)} × {attachment.frameSize.y.toFixed(2)} ——
                选中轮廓/手柄按它走，渲染仍只有上面「尺寸」那块
              </p>
            ) : null}
            <ColorField
              label="颜色"
              value={attachment.color}
              onChange={(value) => update('修改附件颜色', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.color = value }))}
            />
            {/*
              骨内FFD：**只在已经标成骨内空间时才出现**（正常流程不会产生 true）。
              导入器（spine / DragonBones）与编辑器的 FFD 工具写的都是显示空间，导出时
              compiler 还会把 true 换算回显示空间并清零（见 compile.normalizeBoneSpaceFfd）——
              所以平时藏起来；只有旧工程 / 外部数据带着 true 时它才冒出来，让人能看着并关掉。
            */}
            {attachment.type === 'mesh' && attachment.ffdInBoneSpace ? (
              <ToggleField
                label="骨内FFD"
                value={attachment.ffdInBoneSpace}
                hint="偏移已按骨骼 bindpose 换算过；正常保持关闭"
                onChange={(value) => update('修改FFD空间', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.ffdInBoneSpace = value }))}
              />
            ) : null}
            {attachment.type === 'mesh' ? (
              <p className="text-3xs leading-relaxed text-content-lo">
                顶点 {attachment.vertices.length} · 三角面 {Math.floor(attachment.triangles.length / 3)} ·
                加权 {attachment.vertices.filter((v) => v.weights.length > 0).length}
                <br />
                用网格 / FFD 工具在网格内 Alt+点击插入顶点，选中顶点后可在下面删除
              </p>
            ) : null}

            {attachment.type === 'mesh' ? (
              <FieldGroup title="权重骨骼列表">
                {/* 两个入口并排一行，都放在列表**上方**：绑定骨骼与按列表重算权重是这块的常用动作 */}
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="hao-btn h-[20px] flex-1 px-2 text-3xs"
                    title={
                      pickingWeightBone
                        ? '结束绑定：已点选的骨骼会保留在列表里'
                        : '进入绑定骨骼状态后，在视口里点选骨骼加入列表（可以连续点选多根），右键或再点这个按钮结束'
                    }
                    onClick={() => {
                      if (pickingWeightBone) {
                        tools.setPendingWeightBone(null)
                        onStatus('已结束绑定骨骼')
                        return
                      }
                      tools.setPendingWeightBone({ slot: slot.name, attachment: attachment.name })
                      onStatus('绑定骨骼：在视口里点选骨骼加入列表（可连续多根），完成后右键或再点这个按钮')
                    }}
                  >
                    {pickingWeightBone ? '完成绑定骨骼' : '添加绑定骨骼'}
                  </button>
                  <button
                    type="button"
                    className="hao-btn h-[20px] flex-1 px-2 text-3xs"
                    disabled={weightBones.length === 0}
                    title="按列表里的骨骼重算所有顶点权重：顶点离哪根骨骼近，它在那根骨骼上的权重就高（列表外的骨骼不参与）"
                    onClick={() => {
                      const scene = getActiveScene()
                      if (!scene) return
                      if (mode !== 'pose') {
                        onStatus('自动计算权重写的是绑定姿态：请切到 Pose 状态')
                        return
                      }
                      const touched = runAutoWeightsForBones(
                        { scene, selection, tools, mode, time, status: onStatus },
                        slot.name,
                        attachment.name,
                        weightBones,
                        2
                      )
                      onStatus(
                        touched > 0
                          ? `已按绑定骨骼重算 ${touched} 个顶点的权重`
                          : weightBones.length < 2
                            ? `权重没有变化：列表里只有 ${weightBones.length} 根骨骼，结果就是全部 100%。先点「添加绑定骨骼」把相关骨骼加进来再算`
                            : '权重没有变化：当前权重已是最新结果'
                      )
                    }}
                  >
                    自动计算权重
                  </button>
                </div>
                {/*
                  不加高度上限、也不给滚动条：绑定骨骼可能十几根，列表被截断的话
                  得先滚动才看得到自己在调哪一根（尤其是选中顶点后每行都带滑块的时候）。
                  面板本身可以滚，整份列表跟着走就行。
                */}
                <div className="flex flex-col gap-0.5 rounded border border-line bg-ink-900/60 p-1">
                  {weightBones.length === 0 ? (
                    <span className="px-1 py-0.5 text-3xs leading-relaxed text-content-lo">
                      还没有绑定骨骼：点上面的按钮进入绑定状态，再在视口里点选骨骼（可连续点选多根）
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
                                    ? '这个网格只绑了一根骨骼：它在每个顶点上必然是 100%'
                                    : `「${name}」在顶点 #${selection.vertex} 上的权重（其余骨骼按比例分享剩余部分）`
                                }
                                // 一次拖动 = 一条撤销记录：按下开事务，松开收尾，中途只 updateSilent
                                onPointerDown={() => useProjectStore.getState().beginTransaction('修改顶点权重')}
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
                                title="权重百分比：失焦 / 回车生效；中键左右拖动可调"
                                sanitize={(raw) => {
                                  const next = Math.round(Number(raw))
                                  return Number.isFinite(next)
                                    ? String(Math.min(100, Math.max(0, next)))
                                    : null
                                }}
                                onCommit={(next) =>
                                  update('修改顶点权重', (draft) => {
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
                              title="从列表移除，并清掉该骨骼在所有顶点上的权重"
                              onClick={() => {
                                let removed = false
                                update('移除权重骨骼', (draft) => {
                                  removed = removeWeightBone(draft, slot.name, attachment.name, name)
                                })
                                onStatus(removed ? `已移除权重骨骼「${name}」` : `「${name}」不在权重列表里`)
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
                          ? '先在视口里点选一个顶点（网格 / FFD 工具）'
                          : '删除选中的顶点，并用它的邻居重新三角化补洞'
                      }
                      onClick={() => {
                        const vertex = selection.vertices[0]
                        if (vertex === undefined) return
                        // 选中的是**共享缓冲**下标：换算成附件自己的顶点下标，
                        // 并以它为准确定附件（点选顶点不会改「选中的附件」，可能还停在上一个）
                        const ref = getActiveScene()?.vertexRefAt(vertex) ?? null
                        if (!ref) {
                          onStatus('顶点信息已过期：请在视口里重新点选顶点')
                          return
                        }
                        let removed = false
                        update('删除网格顶点', (draft) => {
                          removed = deleteMeshVertex(draft, ref.slot, ref.attachment, ref.vertex)
                        })
                        if (removed) selection.selectVertices([])
                        onStatus(
                          removed
                            ? `已删除「${ref.attachment}」的顶点 #${ref.vertex}`
                            : '删除失败：顶点不存在或网格至少需要保留 3 个顶点'
                        )
                      }}
                    >
                      删除选中顶点
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="hao-btn h-[20px] px-2 text-3xs"
                    title="清空网格顶点，退回成一张图片显示（由 Region 转来的会精确还原原尺寸与 UV）"
                    onClick={() => {
                      let restored = false
                      update('还原为 Region', (draft) => {
                        restored = convertMeshToRegion(draft, slot.name, attachment.name)
                      })
                      onStatus(
                        restored
                          ? `已把「${attachment.name}」还原为 Region（顶点与 FFD 帧已一并清空）`
                          : '还原失败（附件类型不是网格）'
                      )
                    }}
                  >
                    还原为 Region
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs hover:border-danger/50 hover:text-danger"
                onClick={() => {
                  update('删除附件', (draft) => {
                    deleteAttachment(draft, slot.name, attachment.name)
                  })
                  selection.selectSlot(slot.name)
                  onStatus(`已删除附件「${attachment.name}」`)
                }}
              >
                删除附件
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
        {attachment && attachment.type !== 'mesh' ? (
          <FieldGroup title="网格 / FFD">
            <NumberField
              label="密度"
              value={tools.gridDivisions}
              step={1}
              min={1}
              max={24}
              precision={0}
              onChange={(value) => tools.setGridDivisions(value)}
            />
            <p className="flex items-center gap-1 text-3xs text-content-lo">
              <Grid3x3 size={10} />
              生成 / 重设网格时的栅格细分（{tools.gridDivisions}×{tools.gridDivisions}）：越大顶点越密、越贴合形状
            </p>
            <div className="flex flex-wrap gap-1 pt-0.5">
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs"
                title="把选中的图片（Region）按密度切分成规则栅格网格并三角化，之后可用权重刷 / 顶点工具编辑"
                onClick={() => onStatus(buildGridMesh(tools.gridDivisions).message)}
              >
                转为网格（{tools.gridDivisions}×{tools.gridDivisions}）
              </button>
              <button
                type="button"
                className="hao-btn h-[20px] px-2 text-3xs"
                title="沿图片不透明像素的轮廓生成贴合网格（透明区域不占三角形）；密度控制顶点数量级，也可用来重设手动编辑过的网格"
                onClick={() => onStatus(buildOutlineMesh(tools.gridDivisions).message)}
              >
                自动生成网格
              </button>
            </div>
          </FieldGroup>
        ) : null}
        {toolSections}
      </div>
    )
  }

  const constraint = document.constraints.find((c) => c.name === selection.constraint)
  if (!constraint) return <PanelEmpty title="约束不存在" description="该约束可能已被删除，请重新选择。" />

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
            label="名称"
            value={constraint.name}
            commitOnBlur
            onChange={(next) =>
              rename('constraint', constraint.name, next, {
                label: '约束',
                reselect: () => selection.selectConstraint(next.trim())
              })
            }
          />
        }
        orderField={
          <NumberField
            label="顺序"
            value={constraint.order}
            precision={0}
            onChange={(value) => update('修改约束顺序', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t) t.order = value })}
          />
        }
      />
      {toolSections}
    </div>
  )
}

