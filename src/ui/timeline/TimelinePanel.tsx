import { useEffect, useMemo, useRef, useState } from 'react'
import { Flag, KeyRound, Pause, Play, Repeat, SkipBack, SkipForward, Square, Timer, Trash2 } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { playheadTime, usePlayheadStore } from '@editor/store/playheadStore'
import { useShallow } from 'zustand/react/shallow'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { animationDuration } from '@editor/runtime'
import { getActiveScene } from '@editor/activeScene'
import { buildTimeline, lastKeyTime, setKeysTimes } from '@editor/timeline/model'
import { uniqueName } from '@editor/commands/authoringCommands'
import {
  cleanupEmptyTracks,
  deleteTrack,
  keyEventNow,
  keyframeNow,
  keySlotSubArmatureNow,
  removeSelectedKeys
} from '@editor/timeline/actions'
import type { KeyKind, KeySelector, TimelineTrack } from '@editor/timeline/model'
import DopeSheet, { markTimelineSelection } from './DopeSheet'
import { CommitTextField } from '@ui/widgets/fields'
import { t } from '@i18n'

export interface TimelinePanelProps {
  onStatus?: (text: string) => void
}

/**
 * 时间轴：播放条 + 轨道列表 + dope sheet（仅在 Animate 状态渲染）。
 * 曲线在左栏「曲线」面板；关键帧的值在视口下方的浮动条，都不占这里的高度。
 */
export default function TimelinePanel({ onStatus = () => undefined }: TimelinePanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const mode = useModeStore((s) => s.mode)
  // 细粒度订阅，且**刻意不含 time**：时间走下面那条节流通道。
  // 原来无选择器订阅整个 store，擦洗时每次 setTime 都把本面板 + 整张 DopeSheet 重渲染
  // （实测单次净成本 ≈ 100ms）
  const timeline = useTimelineStore(
    useShallow((s) => ({
      currentAnimation: s.currentAnimation,
      selectedKeys: s.selectedKeys,
      playing: s.playing,
      loop: s.loop,
      speed: s.speed,
      snapToFrame: s.snapToFrame,
      zoom: s.zoom,
      setAnimation: s.setAnimation,
      setTime: s.setTime,
      setPlaying: s.setPlaying,
      togglePlaying: s.togglePlaying,
      toggleLoop: s.toggleLoop,
      setSpeed: s.setSpeed,
      setSnapToFrame: s.setSnapToFrame,
      setZoom: s.setZoom,
      setSelectedKeys: s.setSelectedKeys,
      setSelectedTrack: s.setSelectedTrack
    }))
  )
  /**
   * 面板**不订阅**播放时间：播放头、帧号/秒数读数、进度滑块全都由高频通道直接改 DOM
   * （见下面几个 ref），因此播放期间时间轴面板与 DopeSheet **完全不重渲染**。
   *
   * 这里取一次快照只用于「首屏初值」（之后就被 ref 覆盖）。之前是 120ms 节流订阅 ——
   * 每次唤醒都会把整个面板连同 DopeSheet（几十行轨道、上千个关键帧节点）重渲染一遍，
   * 实测是播放卡顿的最大单一来源（LoAF 4s 窗口：脚本 1.3s，全部经 React 调度器的
   * MessagePort 派发；关掉这一处后长帧与掉帧大幅下降）。
   */
  const time = playheadTime()

  const animation = document.animations.find((a) => a.name === timeline.currentAnimation) ?? null
  /** 动画时长（真实长度，决定播放与擦洗上限） */
  const duration = animationDuration(document, timeline.currentAnimation)
  /**
   * 时间轴显示长度 = 动画时长 + 尾部留白（至少 8% 或 0.2s）。
   * 留白区允许把关键帧往后拖，拖过去会自动延长动画时长，因此不存在「没地方加帧」的问题。
   */
  const axis = Math.max(duration * 1.08, duration + 0.2)
  // 轨道只来自动画数据：没打过关键帧的骨骼 / 插槽（包括挂了嵌套骨架的插槽）不会自动出现
  const tracks = useMemo(() => buildTimeline(animation), [animation])

  // 时长会因为关键帧收缩而变小；播放头若停在旧的末尾之外，会与播放器按循环取模后的时间
  // 不一致（此时拖动骨骼写的关键帧不在画面上，看起来像「拖不动」）。收敛到时长内。
  // 时长会因为关键帧收缩而变小；播放头若停在旧的末尾之外，会与播放器按循环取模后的时间
  // 不一致（此时拖动骨骼写的关键帧不在画面上，看起来像「拖不动」）。收敛到时长内。
  //
  // 用订阅而不是「订阅时间 → 重渲染面板」：这里只是把越界的时间拉回来，没必要重画面板；
  // 200ms 节流避免连续越界时反复写 store。
  useEffect(() => {
    let timer = 0
    const unsubscribe = usePlayheadStore.subscribe((state) => {
      if (state.time <= duration + 1e-6 || timer !== 0) return
      timer = window.setTimeout(() => {
        timer = 0
        useTimelineStore.getState().setTime(duration)
      }, 200)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [duration])

  const frame = Math.round(time * document.frameRate)
  const totalFrames = Math.max(1, Math.round(duration * document.frameRate))
  const selectedKeys = timeline.selectedKeys

  /**
   * 播放头读数（帧号/秒）与进度滑块：播放时每帧由**高频通道直接改 DOM**，
   * 不走 React 状态 —— 面板重渲染一次是几十毫秒量级，每帧来一次就把帧率压到个位数
   * （详见 `playheadStore` 的说明）。
   */
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null)
  const timeSliderRef = useRef<HTMLInputElement | null>(null)
  /** 上次同步滑块 DOM 的时间戳（节流用） */
  const sliderSyncRef = useRef(0)
  useEffect(() => {
    const apply = (value: number): void => {
      const readout = timeReadoutRef.current
      if (readout) {
        const elapsed = Math.round(value * document.frameRate)
        readout.textContent = `${elapsed} / ${t('{0} 帧', totalFrames)} · ${value.toFixed(3)}s`
      }
      const slider = timeSliderRef.current
      // 正在拖滑块时不回写：否则会和用户的手抢值（拖动过程中 input 是聚焦的）
      // 注意 `document` 在这里是 EditorDocument（被局部变量遮蔽），要显式走 window.document
      //
      // 另外 range 输入框每帧重绘相当贵（滑块轨道 + 拇指），所以**节流到 ~10 次/秒**；
      // 上面的帧号/秒数文字读数仍是每帧更新，观感不受影响。
      if (slider && window.document.activeElement !== slider && performance.now() - sliderSyncRef.current > 100) {
        sliderSyncRef.current = performance.now()
        slider.value = String(value)
      }
    }
    apply(playheadTime())
    return usePlayheadStore.subscribe((state) => apply(state.time))
  }, [document.frameRate, totalFrames])

  /** 重命名中的动画名（非 null 时把按钮区换成输入框） */
  const [renaming, setRenaming] = useState<string | null>(null)

  const commitRename = (): void => {
    const next = (renaming ?? '').trim()
    const current = animation?.name
    setRenaming(null)
    if (!next || !current || next === current) return
    if (document.animations.some((item) => item.name === next)) {
      onStatus(t('已经有一个叫「{0}」的动画了', next))
      return
    }
    update(t('重命名动画'), (draft) => {
      const target = draft.animations.find((item) => item.name === current)
      if (target) target.name = next
    })
    timeline.setAnimation(next)
    onStatus(t('动画「{0}」已重命名为「{1}」', [current, next]))
  }

  const duplicateAnimation = (): void => {
    if (!animation) return
    const source = animation
    let created = ''
    update(t('复制动画'), (draft) => {
      const origin = draft.animations.find((item) => item.name === source.name)
      if (!origin) return
      created = uniqueName(
        draft.animations.map((item) => item.name),
        `${source.name}_copy`
      )
      // 深拷贝一份（动画数据是纯 JSON，序列化一次最省事）
      const copy = JSON.parse(JSON.stringify(origin)) as typeof origin
      copy.name = created
      draft.animations.push(copy)
    })
    if (created) {
      timeline.setAnimation(created)
      onStatus(t('已复制出动画「{0}」', created))
    }
  }

  const removeAnimation = (): void => {
    if (!animation) return
    const name = animation.name
    update(t('删除动画'), (draft) => {
      draft.animations = draft.animations.filter((item) => item.name !== name)
    })
    const next = document.animations.find((item) => item.name !== name)?.name ?? null
    timeline.setAnimation(next)
    onStatus(
      t('已删除动画「{0}」', name) + (next ? t('，已切到「{0}」', next) : '') + t('（可撤销）')
    )
  }

  const stepFrame = (delta: number): void => {
    // 从**播放头时钟**取当前位置，而不是 store 的 time：播放期间 store 是低频同步的，
    // 拿它做基准会从「上次同步的位置」跳，逐帧会跳错。
    const current = Math.round(playheadTime() * document.frameRate)
    const next = Math.max(0, Math.min(totalFrames, current + delta)) / document.frameRate
    // 不要截到 4 位小数：1.1333333 → 1.1333 会落在该帧关键帧时间之前，采样退回上一帧
    timeline.setTime(next)
  }

  const keyCurrent = (): void => {
    const result = animation ? keyframeNow() : { message: t('请先在时间轴选择动画') }
    onStatus(result.message)
  }

  const keyEvent = (): void => {
    onStatus(keyEventNow().message)
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
          <option value="">{t('（未选择动画）')}</option>
          {document.animations.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.duration.toFixed(2)}s
            </option>
          ))}
        </select>

        <button
          type="button"
          className="hao-btn h-[20px] px-1.5 text-3xs"
          title={t('新建动画（建好自动切过去）')}
          onClick={() => {
            let created = ''
            update(t('新建动画'), (draft) => {
              let name = 'animation'
              let index = 2
              while (draft.animations.some((a) => a.name === name)) name = `animation_${index++}`
              created = name
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
            if (created) timeline.setAnimation(created)
          }}
        >
          {t('+ 动画')}
        </button>

        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            title={t('输入新名字，回车确认 / Esc 取消')}
            className="hao-field h-[20px] w-[110px]"
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              else if (event.key === 'Escape') setRenaming(null)
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className="hao-btn h-[20px] px-1.5 text-3xs"
              title={t('重命名当前动画')}
              disabled={!animation}
              onClick={() => setRenaming(animation?.name ?? null)}
            >
              {t('重命名')}
            </button>
            <button
              type="button"
              className="hao-btn h-[20px] px-1.5 text-3xs"
              title={t('复制当前动画（连同全部关键帧）')}
              disabled={!animation}
              onClick={duplicateAnimation}
            >
              {t('复制')}
            </button>
            <button
              type="button"
              className="hao-btn h-[20px] px-1.5 text-3xs hover:border-danger/50 hover:text-danger"
              title={t('删除当前动画（可撤销）')}
              disabled={!animation}
              onClick={removeAnimation}
            >
              {t('删除')}
            </button>
          </>
        )}

        <label
          className="flex shrink-0 items-center gap-1 text-3xs text-content-lo"
          title={t('动画时长（帧）。这是可编辑范围（改大就能在后面继续加帧）；播放与导出按最后一个关键帧算')}
        >
          {t('时长')}
          {/* 提交式输入：打字期间只改本地文本。逐字符提交会让时长在打字中途被写成中间态
              （输入 90 时先变 9 帧），撤销也会退回中间态而不是改之前的值 */}
          <CommitTextField
            className="hao-field h-[20px] w-[56px] bg-ink-900 text-right font-mono disabled:opacity-40"
            disabled={!animation}
            inputMode="numeric"
            scrub
            title={t('动画时长（帧）。失焦 / 回车生效；中键左右拖动可调；播放按最后一个关键帧算')}
            value={String(totalFrames)}
            sanitize={(raw) => {
              const frames = Math.round(Number(raw))
              return Number.isFinite(frames) ? String(Math.max(1, frames)) : null
            }}
            onCommit={(next) => {
              const frames = Math.max(1, Math.round(Number(next)))
              if (!animation) return
              // 不能短于最后一个关键帧（否则末尾帧会被裁掉，也擦洗不到）。显式说明改成了什么，
              // 而不是静默弹回，避免「我设的时长没生效」的困惑
              const minFrames = Math.ceil(lastKeyTime(animation) * document.frameRate - 1e-6)
              const finalFrames = Math.max(frames, minFrames)
              update(t('修改动画时长'), (draft) => {
                const target = draft.animations.find((item) => item.name === timeline.currentAnimation)
                if (target) target.duration = finalFrames / document.frameRate
              })
              if (finalFrames !== frames) {
                onStatus(
                  t('时长不能短于最后一个关键帧（{0} 帧 / {1}s），已按 {0} 帧设置', [
                    minFrames,
                    (minFrames / document.frameRate).toFixed(2)
                  ])
                )
              }
            }}
          />
          {t('帧')}
        </label>

        {/* 这两个按钮 shrink-0：窗口窄时该由右侧的进度滑块（flex-1）让位，
            按钮标签被挤成竖排（关/键/帧）看着像坏了 */}
        <button
          type="button"
          className="hao-btn h-[20px] shrink-0 px-1.5 text-3xs"
          title={t('把当前姿态写成关键帧（K）')}
          onClick={keyCurrent}
        >
          <KeyRound size={11} className="mr-1 inline" />
          {t('关键帧')}
        </button>
        <button
          type="button"
          className="hao-btn h-[20px] shrink-0 px-1.5 text-3xs"
          title={t('在当前时间插入事件帧（事件名 / 字符串 / 整数 / 浮点在视口下方的值栏里改）')}
          onClick={keyEvent}
        >
          <Flag size={11} className="mr-1 inline" />
          {t('事件帧')}
        </button>
        <button
          type="button"
          className="hao-btn h-[20px] px-1.5 text-3xs"
          title={t('删除选中的关键帧（Delete）')}
          onClick={removeSelected}
        >
          <Trash2 size={11} />
        </button>

        <div className="mx-1 h-[18px] w-px bg-line" />

        <button type="button" className="hao-tool-button" title={t('上一帧 (←)')} onClick={() => stepFrame(-1)}>
          <SkipBack size={13} />
        </button>
        <button
          type="button"
          className={['hao-tool-button', timeline.playing ? 'hao-tool-button-active' : ''].join(' ')}
          title={t('播放 / 暂停 (空格)')}
          onClick={timeline.togglePlaying}
        >
          {timeline.playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button type="button" className="hao-tool-button" title={t('下一帧 (→)')} onClick={() => stepFrame(1)}>
          <SkipForward size={13} />
        </button>
        <button
          type="button"
          className={['hao-tool-button', timeline.loop ? 'hao-tool-button-active' : ''].join(' ')}
          title={t('循环播放')}
          onClick={timeline.toggleLoop}
        >
          {timeline.loop ? <Repeat size={13} /> : <Square size={12} />}
        </button>

        <select
          className="hao-field h-[20px] w-[62px] cursor-pointer bg-ink-900 font-mono text-3xs"
          value={String(timeline.speed)}
          onChange={(e) => timeline.setSpeed(Number(e.target.value))}
          title={t('播放倍速')}
        >
          {[0.25, 0.5, 1, 2].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>

        <button
          type="button"
          className={['hao-tool-button', timeline.snapToFrame ? 'hao-tool-button-active' : ''].join(' ')}
          title={t('关键帧吸附到帧')}
          onClick={() => timeline.setSnapToFrame(!timeline.snapToFrame)}
        >
          <Timer size={13} />
        </button>

        {/* 非受控：位置由高频通道直接写 DOM（见 timeSliderRef），React 不再每帧接管它 */}
        <input
          ref={timeSliderRef}
          type="range"
          className="h-[4px] flex-1 cursor-pointer appearance-none rounded bg-ink-600 accent-accent"
          min={0}
          max={duration}
          step={timeline.snapToFrame ? 1 / document.frameRate : 0.001}
          defaultValue={playheadTime()}
          disabled={!animation}
          onChange={(e) => {
            timeline.setTime(Number(e.target.value))
            timeline.setPlaying(false)
          }}
        />

        <span ref={timeReadoutRef} className="shrink-0 font-mono text-3xs text-content-lo">
          {frame} / {t('{0} 帧', totalFrames)} · {time.toFixed(3)}s
        </span>
      </div>

      <DopeSheet
        tracks={tracks}
        axis={axis}
        length={duration}
        zoom={timeline.zoom}
        onZoom={timeline.setZoom}
        time={time}
        frameRate={document.frameRate}
        snapToFrame={timeline.snapToFrame}
        selectedKeys={selectedKeys}
        onSelectKeys={timeline.setSelectedKeys}
        onKeySubArmature={(slot) => onStatus(keySlotSubArmatureNow(slot).message)}
        onDeleteTrack={(track) =>
          onStatus(
            deleteTrack({
              kind: track.kind,
              target: track.target,
              attachment: track.attachment,
              channel: track.channel ?? '',
              time: 0
            }).message
          )
        }
        onCleanupFrames={() => onStatus(cleanupEmptyTracks().message)}
        onScrub={(value) => {
          timeline.setPlaying(false)
          timeline.setTime(value)
        }}
        onSelectTarget={(track) => {
          // null = 轨道列表里右键，取消通道选择。当前选择直接读 store：
          // 面板刻意不订阅这些「按点击变化」的字段（见上面的高频通道说明），已经没选就不写。
          if (!track) {
            if (useTimelineStore.getState().selectedTrack) timeline.setSelectedTrack(null)
            return
          }
          selectTrack(track, selection, onStatus, timeline.setSelectedTrack)
        }}
        onSetTimes={(entries) => {
          // 绝对时间由 dope sheet 基于拖拽起点算出，这里只做写入（拖拽会话内 selector 时间保持同步）
          const name = animation?.name ?? null
          useProjectStore.getState().updateSilent((draft) => {
            setKeysTimes(draft, name, entries)
          })
          // 播放头跟着被拖的帧走：视口实时显示这个时机下的姿态，便于对帧
          const anchor = entries[0]?.time
          if (anchor !== undefined) {
            timeline.setTime(Math.max(0, Math.min(duration, anchor)))
          }
        }}
        onBeginDrag={() => {
          // 拖动关键帧时先停播：否则播放头一边被推进一边被拖拽跟随，画面会来回跳
          timeline.setPlaying(false)
          useProjectStore.getState().beginTransaction(t('移动关键帧'))
        }}
        onEndDrag={() => {
          useProjectStore.getState().endTransaction()
          onStatus(t('关键帧时间已更新'))
        }}
        onStatus={onStatus}
      />

    </div>
  )
}

/** 把当前选中对象映射为可打关键帧的目标 */
function selectionTargets(selection: ReturnType<typeof useSelectionStore.getState>): Array<{
  kind: KeyKind
  target: string
  attachment: string
}> {
  // 多选：整批骨骼都算目标（按 K 一次给所有选中骨骼打帧）
  if (selection.kind === 'bone' && selection.bones.length > 0) {
    return selection.bones.map((name) => ({ kind: 'bone' as KeyKind, target: name, attachment: '' }))
  }
  if (selection.kind === 'slot' && selection.slot) {
    return [{ kind: 'slot', target: selection.slot, attachment: '' }]
  }
  if (selection.kind === 'attachment' && selection.slot && selection.attachment) {
    return [{ kind: 'deform', target: selection.slot, attachment: selection.attachment }]
  }
  // 约束：与「打关键帧」按钮 / K 键走同一套目标映射（IK 的 mix 是可做动画的）
  if (selection.kind === 'constraint' && selection.constraint) {
    return [{ kind: 'constraint', target: selection.constraint, attachment: '' }]
  }
  return []
}

/**
 * 点击轨道 → 在场景里同步选中对应对象。
 *
 * **顺序要紧**：`selection.selectBone / selectSlot` 会把动画面板里选中的通道清掉
 *（点了对象就换关注点，旧通道作废 —— 见 `selectionStore.clearTrackFocus`），
 * 所以通道必须**最后**写；写在前头会被紧接着的选对象清掉，点了轨道行反而看不到高亮。
 */
function selectTrack(
  track: TimelineTrack,
  selection: ReturnType<typeof useSelectionStore.getState>,
  status: (text: string) => void,
  setTrack: (track: { kind: string; target: string; attachment: string; channel: string } | null) => void
): void {
  // 来自时间轴内的点击：reveal 效果应当跳过滚动 + 高亮（避免列表自己滚回顶 + 闪）
  markTimelineSelection()
  const suffix = track.isGroup || !track.channel ? '' : t('（按 K 只给「{0}」打帧）', track.label)

  if (track.kind === 'bone') {
    selection.selectBone(track.target)
    status(t('选中骨骼「{0}」', track.target) + suffix)
  } else if (track.kind === 'slot') {
    selection.selectSlot(track.target)
    status(t('选中插槽「{0}」', track.target) + suffix)
  } else if (track.kind === 'deform') {
    selection.selectAttachment(track.target, track.attachment)
    status(t('选中附件「{0} / {1}」', [track.target, track.attachment]) + suffix)
  } else if (track.kind === 'constraint') {
    selection.selectConstraint(track.target)
    status(t('选中约束「{0}」', track.target) + suffix)
  } else {
    status(t('事件轨道：在检查器里编辑事件参数'))
  }

  // 记住点中的子轨道：按 K 打关键帧时只打它（分组行只作折叠标题，不参与）
  setTrack(
    track.isGroup
      ? null
      : {
          kind: track.kind,
          target: track.target,
          attachment: track.attachment,
          channel: track.channel ?? ''
        }
  )
}

export type { KeySelector }
