import {
  clearAnimation,
  clearTrack,
  keyBoneFrame,
  keyDeformFrame,
  keyDrawOrderFrame,
  keySlotColorFrame,
  keySlotDisplayFrame,
  keySlotSubArmatureFrame,
  keySlotVisibleFrame,
  moveKeyframe,
  removeBoneFrame,
  removeDeformFrame,
  setKeyEasing
} from './animOps'
import { need, needNum, needOneOf, optNum, optNumList, optText, optTextList, optVec, rawText } from './args'
import { changed, defineWrite } from './registry'
import type { Args } from './registry'

/**
 * 关键帧命令：打帧 / 删帧 / 挪帧 / 改缓动 / 清轨道。
 *
 * 参数一律用**名字 + 秒**描述意图（「给 arm 在 0.5 秒打个旋转帧 30 度」），
 * 由 `animOps` 负责翻译成内部的轨道结构与显示下标 —— AI 不该知道也不该记这些东西。
 */

const BONE_CHANNELS = ['translate', 'rotate', 'scale', 'shear'] as const
const SLOT_CHANNELS = ['display', 'color', 'visible', 'subArmature'] as const
const KEY_KINDS = ['bone', 'slot', 'deform', 'drawOrder'] as const

type BoneChannelName = (typeof BONE_CHANNELS)[number]

/** rotate 收数字，其余收 {x,y}（也容忍传单个数字表示 x = y） */
function transformValue(args: Args, channel: BoneChannelName): number | { x: number; y: number } {
  if (channel === 'rotate') {
    const value = needNum(args, 'value')
    return value
  }
  const value = args.value
  if (typeof value === 'number' && Number.isFinite(value)) return { x: value, y: value }
  const pair = optVec(args, 'value')
  if (pair) return pair
  throw new Error(`value 必须是 {x,y}（${channel} 通道），也可以传单个数字表示 x = y`)
}

/** 定位到一条轨道所需的参数（bone / slot / deform / drawOrder 共用） */
function targetArgs() {
  return {
    animation: { type: 'string' as const, description: '动画名；不传则用当前编辑动画' },
    kind: { type: 'string' as const, description: '轨道种类', required: true, values: KEY_KINDS },
    target: { type: 'string' as const, description: '骨骼名 / 插槽名；kind=drawOrder 时忽略' },
    attachment: { type: 'string' as const, description: 'kind=deform 时的附件名' },
    channel: {
      type: 'string' as const,
      description: '通道：bone 用 translate/rotate/scale/shear，slot 用 display/color/visible/subArmature',
      required: true
    }
  }
}

/** 校验 channel 与 kind 是否配套，顺手收敛成具体类型 */
function channelOf(args: Args, kind: string): string {
  const channel = need(args, 'channel')
  if (kind === 'bone' && !(BONE_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`bone 轨道的 channel 只能是 ${BONE_CHANNELS.join(' / ')}，收到 ${channel}`)
  }
  if (kind === 'slot' && !(SLOT_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`slot 轨道的 channel 只能是 ${SLOT_CHANNELS.join(' / ')}，收到 ${channel}`)
  }
  if (kind === 'deform' && channel !== 'frames') {
    throw new Error(`deform 轨道的 channel 只能是 frames，收到 ${channel}`)
  }
  if (kind === 'drawOrder' && channel !== 'order') {
    throw new Error(`drawOrder 轨道的 channel 只能是 order，收到 ${channel}`)
  }
  return channel
}

export function registerAnimCommands(): void {
  defineWrite(
    {
      name: 'keyBoneFrame',
      title: '打骨骼帧',
      description: '给某根骨骼的某个变换通道打一帧。同一时间点重复打即覆盖，单位是秒',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        bone: { type: 'string', description: '骨骼名', required: true },
        channel: { type: 'string', description: '变换通道', required: true, values: BONE_CHANNELS },
        time: { type: 'number', description: '时间点（秒）', required: true },
        value: { type: 'object', description: 'rotate 传数字（度）；translate / scale / shear 传 {x,y}' }
      },
      returns: '{ animation, bone, channel, time, value }',
      example: { bone: 'chest', channel: 'rotate', time: 0.5, value: -12 }
    },
    (draft, args) => {
      const channel = needOneOf(args, 'channel', BONE_CHANNELS)
      const result = keyBoneFrame(draft, {
        animation: optText(args, 'animation'),
        bone: need(args, 'bone'),
        channel,
        time: needNum(args, 'time'),
        value: transformValue(args, channel)
      })
      return changed(result, `已给骨骼 ${result.bone} 的 ${result.channel} 在 ${result.time} 秒打了一帧`)
    }
  )

  defineWrite(
    {
      name: 'removeBoneFrame',
      title: '删骨骼帧',
      description: '删掉某根骨骼某个通道在指定时间点的关键帧',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        bone: { type: 'string', description: '骨骼名', required: true },
        channel: { type: 'string', description: '变换通道', required: true, values: BONE_CHANNELS },
        time: { type: 'number', description: '时间点（秒）', required: true }
      },
      returns: '{ removed, animation }'
    },
    (draft, args) => {
      const result = removeBoneFrame(draft, {
        animation: optText(args, 'animation'),
        bone: need(args, 'bone'),
        channel: needOneOf(args, 'channel', BONE_CHANNELS),
        time: needNum(args, 'time')
      })
      if (!result.removed) return { changed: false, message: `那根骨骼在 ${needNum(args, 'time')} 秒本来就没有这个通道的关键帧` }
      return changed(result, '已删除该关键帧')
    }
  )

  defineWrite(
    {
      name: 'keySlotDisplayFrame',
      title: '打显示帧',
      description: '打一帧「显示哪个附件」（换装动画的基础）。附件名给空串表示这一帧起不显示',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '插槽名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true },
        attachment: { type: 'string', description: '要显示的附件名；空串 = 不显示', required: true },
        skin: { type: 'string', description: '皮肤名；不传则用当前皮肤' }
      },
      returns: '{ animation, slot, time, attachment, displayIndex }',
      example: { slot: 'hand', time: 0.5, attachment: 'sword', skin: 'default' }
    },
    (draft, args) => {
      const attachment = rawText(args, 'attachment')
      if (attachment === undefined) throw new Error('缺少参数 attachment（附件名；空串表示不显示）')
      const result = keySlotDisplayFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        time: needNum(args, 'time'),
        attachment,
        skin: optText(args, 'skin')
      })
      const shown = result.attachment ? result.attachment : '不显示'
      return changed(result, `插槽 ${result.slot} 在 ${result.time} 秒起显示「${shown}」`)
    }
  )

  defineWrite(
    {
      name: 'keySlotSubArmatureFrame',
      title: '打子骨架帧',
      description:
        '打一帧「嵌套骨架播什么」：子骨架动画名（空串 = 回 setup 姿态）+ 播放次数（0 = 循环）/ 起始偏移 / 倍速。用于「挥刀时刀光从第 3 帧起播」这类效果；插槽上要先有嵌套骨架 display',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '挂了嵌套骨架 display 的插槽名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true },
        clip: {
          type: 'string',
          description: '子骨架里要播的动画名；空串 = 回 setup 姿态（可用 getProjectState 看别的骨架有哪些动画）',
          required: true
        },
        playTimes: { type: 'number', description: '播放次数：0 = 无限循环（默认 0）' },
        offset: { type: 'number', description: '起始偏移（秒）：从子动画的第几秒开始（默认 0）' },
        speed: { type: 'number', description: '倍速，1 = 原速（默认 1）' }
      },
      returns: '{ animation, slot, time, clip, playTimes, offset, speed }',
      example: { slot: 'weapon', time: 0.2, clip: 'slash', playTimes: 0, offset: 0.1, speed: 1 }
    },
    (draft, args) => {
      const result = keySlotSubArmatureFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        time: needNum(args, 'time'),
        clip: rawText(args, 'clip') ?? '',
        playTimes: optNum(args, 'playTimes'),
        offset: optNum(args, 'offset'),
        speed: optNum(args, 'speed')
      })
      return changed(
        result,
        `插槽 ${result.slot} 在 ${result.time} 秒起让子骨架播「${result.clip || 'setup 姿态'}」` +
          `（次数 ${result.playTimes}、偏移 ${result.offset}s、倍速 ${result.speed}）`
      )
    }
  )

  defineWrite(
    {
      name: 'keySlotVisibleFrame',
      title: '打显隐帧',
      description: '打一帧插槽的显示 / 隐藏',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '插槽名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true },
        visible: { type: 'boolean', description: '是否可见', required: true }
      },
      returns: '{ animation, slot, time, visible }'
    },
    (draft, args) => {
      if (typeof args.visible !== 'boolean') throw new Error('缺少参数 visible（true / false）')
      const result = keySlotVisibleFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        time: needNum(args, 'time'),
        visible: args.visible
      })
      return changed(result, `插槽 ${result.slot} 在 ${result.time} 秒起${result.visible ? '显示' : '隐藏'}`)
    }
  )

  defineWrite(
    {
      name: 'keySlotColorFrame',
      title: '打颜色帧',
      description: '打一帧插槽颜色（与附件颜色相乘，常用来做受击闪白 / 渐隐）',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '插槽名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true },
        color: { type: 'string', description: '颜色 #RRGGBB 或 #RRGGBBAA', required: true }
      },
      returns: '{ animation, slot, time, color }',
      example: { slot: 'torso', time: 0, color: '#FFFFFF00' }
    },
    (draft, args) => {
      const result = keySlotColorFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        time: needNum(args, 'time'),
        color: need(args, 'color')
      })
      return changed(result, `插槽 ${result.slot} 在 ${result.time} 秒的颜色设为 ${result.color}`)
    }
  )

  defineWrite(
    {
      name: 'keyDrawOrderFrame',
      title: '打绘制顺序帧',
      description: '打一帧绘制顺序。order 必须是**完整**的插槽名序列（第 0 个最先画）；不传则按当前层序',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        time: { type: 'number', description: '时间点（秒）', required: true },
        order: { type: 'array', description: '完整插槽名序列（第 0 个最先画）' }
      },
      returns: '{ animation, time, order }'
    },
    (draft, args) => {
      const result = keyDrawOrderFrame(draft, {
        animation: optText(args, 'animation'),
        time: needNum(args, 'time'),
        order: optTextList(args, 'order')
      })
      return changed(result, `已在 ${result.time} 秒打了一帧绘制顺序（${result.order.join(' → ')}）`)
    }
  )

  defineWrite(
    {
      name: 'keyDeformFrame',
      title: '打 FFD 帧',
      description:
        '打一帧网格 / 遮罩形变（FFD）。offsets 是每个顶点的偏移 [x0,y0,x1,y1,...]，长度必须是顶点数的 2 倍；遮罩顶点用 getMask 读',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格或遮罩附件名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true },
        offsets: { type: 'array', description: '顶点偏移数组，长度 = 顶点数 × 2（全 0 表示复位）', required: true }
      },
      returns: '{ animation, slot, attachment, time, vertexCount }'
    },
    (draft, args) => {
      const offsets = optNumList(args, 'offsets')
      if (!offsets) throw new Error('缺少参数 offsets（数字数组，长度 = 顶点数 × 2）')
      const result = keyDeformFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        attachment: need(args, 'attachment'),
        time: needNum(args, 'time'),
        offsets
      })
      return changed(result, `已给 ${result.slot} / ${result.attachment}（${result.vertexCount} 顶点）在 ${result.time} 秒打了 FFD 帧`)
    }
  )

  defineWrite(
    {
      name: 'removeDeformFrame',
      title: '删 FFD 帧',
      description: '删掉某个网格或遮罩附件在指定时间点的 FFD 帧',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '网格或遮罩附件名', required: true },
        time: { type: 'number', description: '时间点（秒）', required: true }
      },
      returns: '{ removed, animation }'
    },
    (draft, args) => {
      const result = removeDeformFrame(draft, {
        animation: optText(args, 'animation'),
        slot: need(args, 'slot'),
        attachment: need(args, 'attachment'),
        time: needNum(args, 'time')
      })
      if (!result.removed) return { changed: false, message: '这个时间点本来就没有 FFD 帧' }
      return changed(result, '已删除该 FFD 帧')
    }
  )

  defineWrite(
    {
      name: 'moveKeyframe',
      title: '挪动关键帧',
      description: '把一条轨道上的关键帧从 from 秒挪到 to 秒。落点已有帧会覆盖它',
      args: {
        ...targetArgs(),
        from: { type: 'number' as const, description: '原时间点（秒）', required: true },
        to: { type: 'number' as const, description: '新时间点（秒）', required: true }
      },
      returns: '{ moved, from, to, animation }'
    },
    (draft, args) => {
      const kind = needOneOf(args, 'kind', KEY_KINDS)
      const result = moveKeyframe(draft, {
        animation: optText(args, 'animation'),
        kind,
        target: optText(args, 'target'),
        channel: channelOf(args, kind),
        attachment: optText(args, 'attachment'),
        from: needNum(args, 'from'),
        to: needNum(args, 'to')
      })
      if (!result.moved) return { changed: false, message: `两个时间点一样（都是 ${result.from} 秒），不用挪` }
      return changed(result, `已把关键帧从 ${result.from} 秒挪到 ${result.to} 秒`)
    }
  )

  defineWrite(
    {
      name: 'setKeyframeEasing',
      title: '设置关键帧缓动',
      description: '改某一帧的缓动方式。bezier 必须同时给 curve：[cx1, cy1, cx2, cy2]',
      args: {
        ...targetArgs(),
        time: { type: 'number' as const, description: '时间点（秒）', required: true },
        easing: { type: 'string' as const, description: '缓动方式', required: true, values: ['linear', 'stepped', 'bezier'] },
        curve: { type: 'array' as const, description: 'bezier 的 4 个控制量 [cx1, cy1, cx2, cy2]' }
      },
      returns: '{ ok, easing, animation }'
    },
    (draft, args) => {
      const kind = needOneOf(args, 'kind', KEY_KINDS)
      const easing = needOneOf(args, 'easing', ['linear', 'stepped', 'bezier'] as const)
      const result = setKeyEasing(draft, {
        animation: optText(args, 'animation'),
        kind,
        target: optText(args, 'target'),
        channel: channelOf(args, kind),
        attachment: optText(args, 'attachment'),
        time: needNum(args, 'time'),
        easing,
        curve: optNumList(args, 'curve')
      })
      return changed(result, `已把该帧缓动改为 ${result.easing}`)
    }
  )

  defineWrite(
    {
      name: 'clearTrack',
      title: '清空轨道',
      description: '清空一条轨道上全部关键帧；只给 time 时删那一帧',
      args: {
        ...targetArgs(),
        time: { type: 'number' as const, description: '只删这一帧（秒）；不传则清空整条轨道' }
      },
      returns: '{ cleared, animation }'
    },
    (draft, args) => {
      const kind = needOneOf(args, 'kind', KEY_KINDS)
      const result = clearTrack(draft, {
        animation: optText(args, 'animation'),
        kind,
        target: optText(args, 'target'),
        channel: channelOf(args, kind),
        attachment: optText(args, 'attachment'),
        time: optNum(args, 'time')
      })
      if (result.cleared === 0) return { changed: false, message: '这条轨道上本来就没有关键帧' }
      return changed(result, `已清掉 ${result.cleared} 帧`)
    }
  )

  defineWrite(
    {
      name: 'clearAnimationKeys',
      title: '清空动画关键帧',
      description: '清空整条动画的所有关键帧（保留动画本身与时长），用于「推倒重做」',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' }
      },
      returns: '{ animation }'
    },
    (draft, args) => {
      const result = clearAnimation(draft, optText(args, 'animation'))
      return changed(result, `已清空动画 ${result.animation} 的全部关键帧`)
    }
  )
}
