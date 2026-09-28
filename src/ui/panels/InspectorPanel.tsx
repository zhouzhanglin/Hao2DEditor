import { BlendMode } from '@core/model/types'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { convertRegionToMesh, deleteAttachment } from '@editor/commands/authoringCommands'
import { ColorField, FieldGroup, NumberField, SelectField, TextField, ToggleField, Vector2Field } from '@ui/widgets/fields'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { BLEND_OPTIONS, CONSTRAINT_LABEL } from '@ui/widgets/constants'

export interface InspectorPanelProps {
  onStatus?: (text: string) => void
}

/** 属性检查器：骨骼 / 插槽 / 附件 / 约束四类选中对象的属性编辑 */
export default function InspectorPanel({ onStatus = () => undefined }: InspectorPanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const gridDivisions = useToolStore((s) => s.gridDivisions)

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
    return (
      <div className="flex flex-col">
        <FieldGroup title="骨骼">
          <TextField label="名称" value={bone.name} onChange={() => undefined} />
          <SelectField
            label="父级"
            value={bone.parent}
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
            onChange={(value) =>
              update('修改骨骼长度', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.length = value
              })
            }
          />
        </FieldGroup>

        <FieldGroup title="局部变换（Setup）">
          <Vector2Field
            label="位置"
            value={bone.localPosition}
            onChange={(value) =>
              update('修改骨骼位置', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.localPosition = value
              })
            }
          />
          <NumberField
            label="旋转"
            value={bone.rotation}
            step={1}
            suffix="°"
            onChange={(value) =>
              update('修改骨骼旋转', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.rotation = value
              })
            }
          />
          <Vector2Field
            label="缩放"
            value={bone.localScale}
            step={0.1}
            onChange={(value) =>
              update('修改骨骼缩放', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.localScale = value
              })
            }
          />
          <Vector2Field
            label="错切"
            value={bone.localShear}
            onChange={(value) =>
              update('修改骨骼错切', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.localShear = value
              })
            }
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
          <SelectField
            label="画法"
            value={bone.hollow ? 'hollow' : 'filled'}
            options={[
              { value: 'filled', label: '实心' },
              { value: 'hollow', label: '空心' }
            ]}
            onChange={(value) =>
              update('修改骨骼画法', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.hollow = value === 'hollow'
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

    return (
      <div className="flex flex-col">
        <FieldGroup title="插槽">
          <TextField label="名称" value={slot.name} onChange={() => undefined} />
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
            label="setup"
            value={slot.attachment}
            options={[{ value: '', label: '（不显示）' }, ...(skinSlot?.attachments ?? []).map((a) => ({ value: a.name, label: a.name }))]}
            onChange={(value) =>
              update('修改 setup 附件', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.attachment = value
              })
            }
          />
        </FieldGroup>

        {attachment ? (
          <FieldGroup title={`附件 · ${attachment.type}`}>
            <TextField label="名称" value={attachment.name} onChange={() => undefined} />
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
              <p className="text-3xs text-content-lo">
                顶点 {attachment.vertices.length} · 三角面 {Math.floor(attachment.triangles.length / 3)} ·
                加权 {attachment.vertices.filter((v) => v.weights.length > 0).length}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-1 pt-0.5">
              {attachment.type === 'region' ? (
                <button
                  type="button"
                  className="hao-btn h-[20px] px-2 text-3xs"
                  title={`按 ${gridDivisions}×${gridDivisions} 栅格切分网格并三角化，之后可用权重刷 / FFD 工具编辑`}
                  onClick={() => {
                    let result: { vertices: number; triangles: number } | null = null
                    update('Region 转网格', (draft) => {
                      result = convertRegionToMesh(draft, slot.name, attachment.name, gridDivisions)
                    })
                    onStatus(
                      result
                        ? `已转为网格：${(result as { vertices: number }).vertices} 顶点 / ${
                            (result as { triangles: number }).triangles
                          } 三角面`
                        : '转换失败（附件类型不是 Region）'
                    )
                  }}
                >
                  转为网格（{gridDivisions}×{gridDivisions}）
                </button>
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
        <TextField label="名称" value={constraint.name} onChange={() => undefined} />
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
              ['mixShearY', '错切']
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

function patchAttachment(
  draft: ReturnType<typeof useProjectStore.getState>['document'],
  slotName: string,
  attachmentName: string,
  patch: (attachment: import('@core/model/authoring').AuthoringAttachment) => void
): void {
  for (const skin of draft.skins) {
    const skinSlot = skin.slots.find((s) => s.slot === slotName)
    if (!skinSlot) continue
    const attachment = skinSlot.attachments.find((a) => a.name === attachmentName)
    if (attachment) patch(attachment)
  }
}
