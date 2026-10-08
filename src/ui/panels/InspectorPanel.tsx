import { BlendMode } from '@core/model/types'
import { curvePercent } from '@core/anim/interpolation'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { getActiveScene } from '@editor/activeScene'
import { keyBoneChannel, keySlotDisplay, keySlotVisible } from '@editor/commands/animationCommands'
import {
  applyRename,
  checkRename,
  convertMeshToRegion,
  deleteAttachment,
  deleteMeshVertex,
  patchAttachment,
  removeWeightBone,
  weightBonesOf
} from '@editor/commands/authoringCommands'
import { runAutoWeightsForBones } from '@editor/tools/authoringTools'
import type { RenameKind } from '@editor/commands/authoringCommands'
import {
  CheckboxField,
  ColorField,
  FieldGroup,
  NumberField,
  SelectField,
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

/** 属性检查器：骨骼 / 插槽 / 附件 / 约束四类选中对象的属性编辑 */
export default function InspectorPanel({ onStatus = () => undefined }: InspectorPanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const tools = useToolStore()
  const mode = useModeStore((s) => s.mode)
  const time = useTimelineStore((s) => s.time)
  const currentAnimation = useTimelineStore((s) => s.currentAnimation)
  /** Animate 态切显示附件 = 打 displayIndex 关键帧；Pose 态才是改绑定姿态 */
  const animating = mode === 'animate' && !!currentAnimation

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
          <SelectField
            label="父级"
            value={bone.parent}
            disabled={animating}
            options={[{ value: '', label: '（无 / 根骨骼）' }, ...document.bones.filter((b) => b.name !== bone.name).map((b) => ({ value: b.name, label: b.name }))]}
            onChange={(value) =>
              update('修改骨骼父级', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.parent = value
              })
            }
          />
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
          <Vector2Field
            label="位置"
            value={shown.position}
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
      </div>
    )
  }

  if (selection.kind === 'slot' || selection.kind === 'attachment') {
    const slot = document.slots.find((s) => s.name === selection.slot)
    if (!slot) return <PanelEmpty title="插槽不存在" description="该插槽可能已被删除，请重新选择。" />
    const skinSlot = document.skins.find((s) => s.name === selection.skin)?.slots.find((s) => s.slot === slot.name)
      ?? document.skins[0]?.slots.find((s) => s.slot === slot.name)
    const attachment = skinSlot?.attachments.find((a) => a.name === selection.attachment)
    // 权重骨骼列表：优先用附件上显式绑定的（老数据按顶点权重推断，见 weightBonesOf）
    const weightBones = attachment && attachment.type === 'mesh' ? weightBonesOf(attachment) : []
    const boneColorOf = (name: string): string =>
      document.bones.find((bone) => bone.name === name)?.color ?? '#F97316'
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
            <Vector2Field
              label="位置"
              value={attachment.position}
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
            <Vector2Field
              label="尺寸"
              value={attachment.size}
              step={0.05}
              onChange={(value) => update('修改附件尺寸', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.size = value }))}
            />
            <ColorField
              label="颜色"
              value={attachment.color}
              onChange={(value) => update('修改附件颜色', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.color = value }))}
            />
            <ToggleField
              label="骨内FFD"
              value={attachment.ffdInBoneSpace}
              onChange={(value) => update('修改FFD空间', (draft) => patchAttachment(draft, slot.name, attachment.name, (a) => { a.ffdInBoneSpace = value }))}
            />
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
                <button
                  type="button"
                  className="hao-btn h-[20px] w-full px-2 text-3xs"
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
                <div className="flex max-h-[160px] flex-col gap-0.5 overflow-y-auto rounded border border-line bg-ink-900/60 p-1">
                  {weightBones.length === 0 ? (
                    <span className="px-1 py-0.5 text-3xs leading-relaxed text-content-lo">
                      还没有绑定骨骼：点上面的按钮进入绑定状态，再在视口里点选骨骼（可连续点选多根）
                    </span>
                  ) : (
                    weightBones.map((name) => (
                      <div
                        key={name}
                        className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-ink-700/60"
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-[2px] border border-black/40"
                          style={{ background: boneColorOf(name) }}
                        />
                        <span className="min-w-0 flex-1 truncate text-3xs" title={name}>
                          {name}
                        </span>
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
                      </div>
                    ))
                  )}
                </div>
                <button
                  type="button"
                  className="hao-btn h-[20px] w-full px-2 text-3xs"
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
                        : '没有可计算权重的顶点（Region 请先转为网格）'
                    )
                  }}
                >
                  自动计算权重
                </button>
              </FieldGroup>
            ) : null}

            <div className="flex flex-wrap gap-1 pt-0.5">
              {/* 「转为网格 / 自动生成网格」只在网格工具的工具选项面板里（那边能现场改密度，
                  也是生成网格的统一入口）；检查器这里不再重复一份，只留网格编辑操作 */}
              {attachment.type === 'mesh' ? (
                <>
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
      </div>
    )
  }

  const constraint = document.constraints.find((c) => c.name === selection.constraint)
  if (!constraint) return <PanelEmpty title="约束不存在" description="该约束可能已被删除，请重新选择。" />

  return (
    <div className="flex flex-col">
      <FieldGroup title={`${CONSTRAINT_LABEL[constraint.type]}约束`}>
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
        <NumberField
          label="顺序"
          value={constraint.order}
          precision={0}
          onChange={(value) => update('修改约束顺序', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t) t.order = value })}
        />
        <ToggleField
          label="启用"
          value={constraint.enabled}
          onChange={(value) => update('启停约束', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t) t.enabled = value })}
        />
        <SelectField
          label="目标"
          value={constraint.target}
          options={[{ value: '', label: '（无）' }, ...document.bones.map((b) => ({ value: b.name, label: b.name }))]}
          onChange={(value) => update('修改约束目标', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t) t.target = value })}
        />
        <p className="text-3xs text-content-lo">
          受约束骨骼：{constraint.bones.join(' → ') || '（未设置）'}
          {constraint.type === 'physics' ? ' · 物理约束仅保留数据，不参与求解' : ''}
        </p>
      </FieldGroup>

      {constraint.type === 'ik' ? (
        <FieldGroup title="IK 参数">
          <NumberField
            label="混合"
            value={constraint.mix}
            step={0.05}
            min={0}
            max={1}
            onChange={(value) => update('修改IK混合', (draft) => { const t = draft.constraints.find((c) => c.name === constraint.name); if (t && t.type === 'ik') t.mix = value })}
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
    </div>
  )
}
