import { Brush, Grid3x3, Layers, Sparkles, Wind } from 'lucide-react'
import { useToolStore } from '@editor/store/toolStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useThrottledPlayheadTime } from '@editor/store/playheadStore'
import { useProjectStore } from '@editor/store/projectStore'
import { ColorField, FieldGroup, NumberField, SelectField } from '@ui/widgets/fields'
import { getActiveScene } from '@editor/activeScene'
import { runAutoWeights } from '@editor/tools/authoringTools'
import { buildGridMesh, buildOutlineMesh } from '@editor/commands/meshActions'
import { removeDeformKeyframe } from '@editor/commands/animationCommands'

export interface ToolOptionsPanelProps {
  onStatus?: (text: string) => void
}

/** 工具选项：权重刷参数、网格构建参数、FFD 复位、整体染色 */
export default function ToolOptionsPanel({ onStatus = () => undefined }: ToolOptionsPanelProps) {
  const tools = useToolStore()
  const selection = useSelectionStore()
  const mode = useModeStore((s) => s.mode)
  // 节流跟随播放头：同属性面板，读数不需要每帧重渲染
  const time = useThrottledPlayheadTime(400)
  const animation = useTimelineStore((s) => s.currentAnimation)
  const update = useProjectStore((s) => s.update)

  const targetBone = selection.kind === 'bone' && selection.bone ? selection.bone : ''
  const hasAttachment = Boolean(selection.slot && selection.attachment)

  const doAutoWeights = (): void => {
    const scene = getActiveScene()
    if (!scene) return
    if (!targetBone) {
      onStatus('自动权重需要先在层级树里选中骨骼（作为主骨骼）')
      return
    }
    if (!hasAttachment) {
      onStatus('自动权重需要先选中一个网格附件')
      return
    }
    const touched = runAutoWeights(
      {
        scene,
        selection,
        tools,
        mode,
        time,
        status: onStatus
      },
      tools.brush.mode === 'subtract' ? 1 : 2
    )
    onStatus(
      touched > 0
        ? `已为重算 ${touched} 个顶点的权重`
        : '权重没有变化（Region 请先转为网格；影响范围仍是「选中骨骼 + 其直接子骨骼」）'
    )
  }

  const resetFfd = (): void => {
    if (!animation || !hasAttachment) {
      onStatus('请先选择动画与网格附件')
      return
    }
    let removed = false
    update('重置 FFD', (draft) => {
      const target = draft.animations.find((item) => item.name === animation)
      if (target) removed = removeDeformKeyframe(target, selection.slot, selection.attachment, time)
    })
    onStatus(removed ? '已删除当前时间点的 FFD 关键帧' : '当前时间点没有 FFD 关键帧')
  }

  // 各分组只在「当前状态下真的有用」时才显示，避免 Animate 态下摆一堆用不上的绑定期参数
  const weightTool = tools.tool === 'weight' && mode === 'pose'
  /** 网格 / FFD 工具：密度参数与生成入口在两种模式下都显示（Animate 态拖顶点写 FFD 帧时也要能看 / 调密度） */
  const meshTool = tools.tool === 'ffd'
  const showFfdReset = mode === 'animate' && hasAttachment
  const bindingToolIdle = mode !== 'pose' && (tools.tool === 'weight' || tools.tool === 'bone')

  return (
    <div className="flex flex-col">
      {weightTool ? (
        <FieldGroup title="权重刷">
          <NumberField
            label="半径"
            value={tools.brush.radius}
            step={4}
            min={2}
            precision={0}
            suffix="px"
            onChange={(value) => tools.setBrush({ radius: value })}
          />
          <NumberField
            label="强度"
            value={tools.brush.strength}
            step={0.05}
            min={0.05}
            max={1}
            onChange={(value) => tools.setBrush({ strength: value })}
          />
          <SelectField
            label="模式"
            value={tools.brush.mode}
            options={[
              { value: 'add', label: '增加权重' },
              { value: 'subtract', label: '减少权重' },
              { value: 'replace', label: '替换（按衰减比例）' }
            ]}
            onChange={(value) => tools.setBrush({ mode: value as 'add' | 'subtract' | 'replace' })}
          />
          <p className="flex items-center gap-1 text-3xs text-content-lo">
            <Brush size={10} />
            目标骨骼：{targetBone || '（先在层级树选中骨骼）'}
          </p>
          <button
            type="button"
            className="hao-btn h-[20px] px-2 text-3xs"
            title="按顶点到骨骼线段的距离衰减，自动分配到最近的 4 根骨骼（需要选中骨骼 + 网格附件，且处于 Pose 状态）"
            onClick={doAutoWeights}
          >
            <Sparkles size={11} className="mr-1 inline" />
            自动权重（选中骨骼 + 网格附件）
          </button>
        </FieldGroup>
      ) : null}

      {meshTool ? (
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
          {mode !== 'pose' ? (
            <p className="text-3xs text-content-lo">
              Animate 态拖顶点写的是 FFD 帧；生成 / 重设绑定网格请切到 Pose 状态
            </p>
          ) : null}
        </FieldGroup>
      ) : null}

      {showFfdReset ? (
        <FieldGroup title="FFD">
          <button
            type="button"
            className="hao-btn h-[20px] px-2 text-3xs"
            title="删除当前时间点的 FFD 关键帧，让该附件回到绑定姿态"
            onClick={resetFfd}
          >
            <Wind size={11} className="mr-1 inline" />
            重置当前时间点的 FFD
          </button>
          <p className="flex items-center gap-1 text-3xs text-content-lo">
            <Wind size={10} />
            当前时间点：{time.toFixed(3)}s
          </p>
        </FieldGroup>
      ) : null}

      {bindingToolIdle ? (
        <FieldGroup title="工具选项">
          <p className="flex items-center gap-1 text-3xs text-content-lo">
            <Brush size={10} />
            权重刷 / 网格 / 绑骨骼属于绑定工具，只在 Pose 状态可用（Tab 切换）
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
    </div>
  )
}
