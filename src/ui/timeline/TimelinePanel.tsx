import { useMemo } from 'react'
import { KeyRound, Pause, Play, Repeat, SkipBack, SkipForward, Square, Timer, Trash2, Zap } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { animationDuration } from '@editor/runtime'
import { getActiveScene } from '@editor/activeScene'
import { buildTimeline, setKeyEasing, setKeysTimes } from '@editor/timeline/model'
import { keyframeNow, removeSelectedKeys } from '@editor/timeline/actions'
import type { KeyKind, KeySelector, TimelineTrack } from '@editor/timeline/model'
import DopeSheet from './DopeSheet'
import CurveEditor from './CurveEditor'
import KeyframeCard from '@ui/panels/KeyframeCard'

export interface TimelinePanelProps {
  onStatus?: (text: string) => void
}

/** 时间轴：播放条 + 轨道列表 + dope sheet + 曲线编辑器（仅在 Animate 状态渲染） */
export default function TimelinePanel({ onStatus = () => undefined }: TimelinePanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const mode = useModeStore((s) => s.mode)
  const timeline = useTimelineStore()

  const animation = document.animations.find((a) => a.name === timeline.currentAnimation) ?? null
  /** 动画时长（真实长度，决定播放与擦洗上限） */
  const duration = animationDuration(document, timeline.currentAnimation)
  /**
   * 时间轴显示长度 = 动画时长 + 尾部留白（至少 8% 或 0.2s）。
   * 留白区允许把关键帧往后拖，拖过去会自动延长动画时长，因此不存在「没地方加帧」的问题。
   */
  const axis = Math.max(duration * 1.08, duration + 0.2)
  const tracks = useMemo(() => buildTimeline(animation), [animation])

  const frame = Math.round(timeline.time * document.frameRate)
  const totalFrames = Math.max(1, Math.round(duration * document.frameRate))
  const selectedKeys = timeline.selectedKeys

  const activeKey = useMemo(() => {
    if (selectedKeys.length === 0) return null
    const selector = selectedKeys[0]
    for (const track of tracks) {
      const found = track.keys.find(
        (key) =>
          key.kind === selector.kind &&
          key.target === selector.target &&
          key.channel === selector.channel &&
          Math.abs(key.time - selector.time) < 1e-4
      )
      if (found) return found
    }
    return null
  }, [selectedKeys, tracks])

  const stepFrame = (delta: number): void => {
    const next = Math.max(0, Math.min(totalFrames, frame + delta)) / document.frameRate
    timeline.setTime(Number(next.toFixed(4)))
  }

  const keyCurrent = (): void => {
    const result = animation ? keyframeNow() : { message: '请先在时间轴选择动画' }
    onStatus(result.message)
  }

  const removeSelected = (): void => {
    const result = removeSelectedKeys()
    if (result.ok) onStatus(result.message)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-800">
      {/* 播放条 */}
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2">
        <select
          className="hao-field h-[22px] w-[140px] cursor-pointer bg-ink-900"
          value={timeline.currentAnimation ?? ''}
          onChange={(e) => {
            timeline.setAnimation(e.target.value || null)
            selection.select({ kind: 'none' })
          }}
        >
          <option value="">（未选择动画）</option>
          {document.animations.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.duration.toFixed(2)}s
            </option>
          ))}
        </select>

        <button
          type="button"
          className="hao-btn h-[20px] px-1.5 text-3xs"
          title="新建动画"
          onClick={() =>
            update('新建动画', (draft) => {
              let name = 'animation'
              let index = 2
              while (draft.animations.some((a) => a.name === name)) name = `animation_${index++}`
              draft.animations.push({
                name,
                duration: 1,
                bones: [],
                slots: [],
                deforms: [],
                drawOrder: [],
                events: [],
                constraints: []
              })
            })
          }
        >
          + 动画
        </button>

        <label
          className="flex shrink-0 items-center gap-1 text-3xs text-content-lo"
          title="动画时长（帧）。改大之后时间轴会变长，就能在后面继续加关键帧；把关键帧往后拖也会自动延长"
        >
          时长
          <input
            type="number"
            min={1}
            step={1}
            disabled={!animation}
            value={totalFrames}
            className="hao-field h-[20px] w-[56px] bg-ink-900 text-right font-mono disabled:opacity-40"
            onChange={(event) => {
              const frames = Math.max(1, Math.round(Number(event.target.value) || 1))
              update('修改动画时长', (draft) => {
                const target = draft.animations.find((item) => item.name === timeline.currentAnimation)
                if (target) target.duration = frames / document.frameRate
              })
            }}
          />
          帧
        </label>

        <button
          type="button"
          className="hao-btn h-[20px] px-1.5 text-3xs"
          title="把当前姿态写成关键帧（K）"
          onClick={keyCurrent}
        >
          <KeyRound size={11} className="mr-1 inline" />
          打帧
        </button>
        <button
          type="button"
          className="hao-btn h-[20px] px-1.5 text-3xs"
          title="删除选中的关键帧（Delete）"
          onClick={removeSelected}
        >
          <Trash2 size={11} />
        </button>

        <div className="mx-1 h-[18px] w-px bg-line" />

        <button type="button" className="hao-tool-button" title="上一帧 (←)" onClick={() => stepFrame(-1)}>
          <SkipBack size={13} />
        </button>
        <button
          type="button"
          className={['hao-tool-button', timeline.playing ? 'hao-tool-button-active' : ''].join(' ')}
          title="播放 / 暂停 (空格)"
          onClick={timeline.togglePlaying}
        >
          {timeline.playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button type="button" className="hao-tool-button" title="下一帧 (→)" onClick={() => stepFrame(1)}>
          <SkipForward size={13} />
        </button>
        <button
          type="button"
          className={['hao-tool-button', timeline.loop ? 'hao-tool-button-active' : ''].join(' ')}
          title="循环播放"
          onClick={timeline.toggleLoop}
        >
          {timeline.loop ? <Repeat size={13} /> : <Square size={12} />}
        </button>

        <select
          className="hao-field h-[20px] w-[62px] cursor-pointer bg-ink-900 font-mono text-3xs"
          value={String(timeline.speed)}
          onChange={(e) => timeline.setSpeed(Number(e.target.value))}
          title="播放倍速"
        >
          {[0.25, 0.5, 1, 2].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>

        <button
          type="button"
          className={['hao-tool-button', timeline.onionSkin ? 'hao-tool-button-active' : ''].join(' ')}
          title="洋葱皮：显示前后帧的骨骼姿态"
          onClick={timeline.toggleOnionSkin}
        >
          <Zap size={13} />
        </button>
        <button
          type="button"
          className={['hao-tool-button', timeline.snapToFrame ? 'hao-tool-button-active' : ''].join(' ')}
          title="关键帧吸附到帧"
          onClick={() => timeline.setSnapToFrame(!timeline.snapToFrame)}
        >
          <Timer size={13} />
        </button>

        <input
          type="range"
          className="h-[4px] flex-1 cursor-pointer appearance-none rounded bg-ink-600 accent-accent"
          min={0}
          max={duration}
          step={timeline.snapToFrame ? 1 / document.frameRate : 0.001}
          value={timeline.time}
          disabled={!animation}
          onChange={(e) => {
            timeline.setTime(Number(e.target.value))
            timeline.setPlaying(false)
          }}
        />

        <span className="shrink-0 font-mono text-3xs text-content-lo">
          {frame} / {totalFrames} 帧 · {timeline.time.toFixed(3)}s
        </span>
      </div>

      <DopeSheet
        tracks={tracks}
        axis={axis}
        length={duration}
        zoom={timeline.zoom}
        onZoom={timeline.setZoom}
        time={timeline.time}
        frameRate={document.frameRate}
        snapToFrame={timeline.snapToFrame}
        selectedKeys={selectedKeys}
        onSelectKeys={timeline.setSelectedKeys}
        onScrub={(value) => {
          timeline.setPlaying(false)
          timeline.setTime(value)
        }}
        onSelectTarget={(track) => selectTrack(track, selection, onStatus)}
        onSetTimes={(entries) => {
          // 绝对时间由 dope sheet 基于拖拽起点算出，这里只做写入（拖拽会话内 selector 时间保持同步）
          const name = animation?.name ?? null
          useProjectStore.getState().updateSilent((draft) => {
            setKeysTimes(draft, name, entries)
          })
        }}
        onBeginDrag={() => {
          useProjectStore.getState().beginTransaction('移动关键帧')
        }}
        onEndDrag={() => {
          useProjectStore.getState().endTransaction()
          onStatus('关键帧时间已更新')
        }}
      />

      {/* 底部工具条：左边曲线编辑器，右边关键帧属性（选中关键帧时可编辑时间/缓动/值） */}
      <div className="flex shrink-0 items-start gap-2 border-t border-line bg-ink-800/70 px-2 py-1.5">
        <CurveEditor
          selectedKeys={selectedKeys}
          easing={activeKey?.easing ?? 0}
          curve={activeKey?.curve ?? null}
          onChange={(easing, curve) => {
            update('修改缓动', (draft) => {
              setKeyEasing(draft, animation?.name ?? null, selectedKeys, easing, curve)
            })
          }}
        />
        <KeyframeCard onStatus={onStatus} />
      </div>
    </div>
  )
}

/** 把当前选中对象映射为可打帧的目标 */
function selectionTargets(selection: ReturnType<typeof useSelectionStore.getState>): Array<{
  kind: KeyKind
  target: string
  attachment: string
}> {
  if (selection.kind === 'bone' && selection.bone) {
    return [{ kind: 'bone', target: selection.bone, attachment: '' }]
  }
  if (selection.kind === 'slot' && selection.slot) {
    return [{ kind: 'slot', target: selection.slot, attachment: '' }]
  }
  if (selection.kind === 'attachment' && selection.slot && selection.attachment) {
    return [{ kind: 'deform', target: selection.slot, attachment: selection.attachment }]
  }
  return []
}

/** 点击轨道 → 在场景里同步选中对应对象 */
function selectTrack(
  track: TimelineTrack,
  selection: ReturnType<typeof useSelectionStore.getState>,
  status: (text: string) => void
): void {
  if (track.kind === 'bone') {
    selection.selectBone(track.target)
    status(`选中骨骼「${track.target}」`)
    return
  }
  if (track.kind === 'slot') {
    selection.selectSlot(track.target)
    status(`选中插槽「${track.target}」`)
    return
  }
  if (track.kind === 'deform') {
    selection.selectAttachment(track.target, track.attachment)
    status(`选中附件「${track.target} / ${track.attachment}」`)
    return
  }
  if (track.kind === 'constraint') {
    selection.selectConstraint(track.target)
    status(`选中约束「${track.target}」`)
    return
  }
  status('事件轨道：在检查器里编辑事件参数')
}

export type { KeySelector }
