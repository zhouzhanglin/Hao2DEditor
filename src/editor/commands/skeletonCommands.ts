import { compact, need, optBool, optNum, optText, optTextList, optVec, requireSomeField } from './args'
import { deleteBone, deleteSlot } from './authoringCommands'
import { changed, defineWrite } from './registry'
import {
  addAnimation,
  addBone,
  addConstraint,
  addDisplay,
  addSlot,
  asBoneChain,
  deleteDisplay,
  removeAnimation,
  renameAnimation,
  setActiveAnimation,
  setAnimationDuration,
  setAttachmentTransform,
  setNestedArmature,
  setBoneTransform,
  setSlotHost,
  setSlotProps
} from './skeletonOps'

/**
 * 骨架 / 插槽 / 约束 / 附件 / 动画的**创建与设置**命令。
 *
 * 这里只做三件事：把 JSON 参数翻译成强类型选项、调用 `skeletonOps` 里的纯函数、
 * 用 `changed()` 告诉注册表「这次真的改了东西」（决定要不要记一条撤销）。
 * 真正的文档操作全在 `skeletonOps.ts`，层级树 UI 也复用同一批函数，
 * 所以「人手点一次」和「AI 调一次」产生的数据完全一样。
 */

// ---------------- 骨骼 ----------------

export function registerSkeletonCommands(): void {
  defineWrite(
    {
      name: 'addBone',
      title: '新建骨骼',
      description: '新建一根骨骼。不传 parent 就挂到层级根骨骼下；名字重名会自动加序号',
      args: {
        name: { type: 'string', description: '骨骼名；不传则按「父名_child」自动生成' },
        parent: { type: 'string', description: '父骨骼名；不传则挂到层级根骨骼下' },
        localPosition: { type: 'object', description: '相对父级的局部位置 {x,y}' },
        rotation: { type: 'number', description: '相对父级的旋转（度）' },
        length: { type: 'number', description: '骨长，默认 0.4' },
        color: { type: 'string', description: '骨骼显示颜色，如 #ff8800' }
      },
      returns: '{ name, parent } —— name 是最终落定的名字（可能带序号），后续命令都用它',
      example: { name: 'chest', parent: 'root', localPosition: { x: 0, y: 1.2 }, rotation: -8, length: 0.9 }
    },
    (draft, args) => {
      const result = addBone(
        draft,
        compact({
          name: optText(args, 'name'),
          parent: typeof args.parent === 'string' ? args.parent.trim() : undefined,
          localPosition: optVec(args, 'localPosition'),
          rotation: optNum(args, 'rotation'),
          length: optNum(args, 'length'),
          color: optText(args, 'color')
        })
      )
      return changed(result, `已新建骨骼 ${result.name}（父级：${result.parent || '无'}）`)
    }
  )

  defineWrite(
    {
      name: 'setBoneTransform',
      title: '设置骨骼变换',
      description: '一次性写入骨骼的一组属性（只改传了的字段）。换父级也用它：传 parent，会自动保持全局位姿',
      args: {
        bone: { type: 'string', description: '骨骼名', required: true },
        parent: { type: 'string', description: '换父级到这根骨骼；空串 = 变成顶层骨骼' },
        localPosition: { type: 'object', description: '局部位置 {x,y}' },
        rotation: { type: 'number', description: '局部旋转（度）' },
        localScale: { type: 'object', description: '局部缩放 {x,y}' },
        localShear: { type: 'object', description: '局部斜切 {x,y}' },
        length: { type: 'number', description: '骨长' },
        color: { type: 'string', description: '显示颜色' },
        locked: { type: 'boolean', description: '锁定（视口里点不中）' },
        hollow: { type: 'boolean', description: '空心显示' },
        inheritRotation: { type: 'boolean', description: '继承父级旋转' },
        inheritScale: { type: 'boolean', description: '继承父级缩放' }
      },
      returns: '{ bone, changedFields: [...] }'
    },
    (draft, args) => {
      const bone = need(args, 'bone')
      const options = compact({
        bone,
        parent: typeof args.parent === 'string' ? args.parent.trim() : undefined,
        localPosition: optVec(args, 'localPosition'),
        rotation: optNum(args, 'rotation'),
        localScale: optVec(args, 'localScale'),
        localShear: optVec(args, 'localShear'),
        length: optNum(args, 'length'),
        color: optText(args, 'color'),
        locked: optBool(args, 'locked'),
        hollow: optBool(args, 'hollow'),
        inheritRotation: optBool(args, 'inheritRotation'),
        inheritScale: optBool(args, 'inheritScale')
      })
      const fields = Object.keys(options).filter((key) => key !== 'bone')
      requireSomeField(fields)
      setBoneTransform(draft, options)
      return changed({ bone, changedFields: fields }, `已更新骨骼 ${bone} 的 ${fields.join(' / ')}`)
    }
  )

  defineWrite(
    {
      name: 'deleteBone',
      title: '删除骨骼',
      description: '删除骨骼（连带它的子骨骼与挂在它上面的插槽）',
      args: {
        bone: { type: 'string', description: '骨骼名', required: true }
      },
      returns: '{ bone }'
    },
    (draft, args) => {
      const bone = need(args, 'bone')
      if (!draft.bones.some((item) => item.name === bone)) {
        throw new Error(`骨骼不存在：${bone}（用 listBones 查现有骨骼名）`)
      }
      deleteBone(draft, bone)
      return changed({ bone }, `已删除骨骼 ${bone}`)
    }
  )

  // ---------------- 插槽 ----------------

  defineWrite(
    {
      name: 'addSlot',
      title: '新建插槽',
      description: '新建插槽（插槽是附件的载体，必须挂在骨骼上）。不传 bone 就挂到层级根骨骼下',
      args: {
        name: { type: 'string', description: '插槽名；不传则为 slot' },
        bone: { type: 'string', description: '宿主骨骼名；不传则用层级根骨骼' },
        zOrder: { type: 'number', description: '绘制层序（越小越先画）；不传则排到最后' },
        color: { type: 'string', description: '插槽颜色 #RRGGBBAA' },
        visible: { type: 'boolean', description: '是否可见' },
        locked: { type: 'boolean', description: '锁定' }
      },
      returns: '{ name, bone }'
    },
    (draft, args) => {
      const result = addSlot(
        draft,
        compact({
          name: optText(args, 'name'),
          bone: optText(args, 'bone'),
          zOrder: optNum(args, 'zOrder'),
          color: optText(args, 'color'),
          visible: optBool(args, 'visible'),
          locked: optBool(args, 'locked')
        })
      )
      return changed(result, `已新建插槽 ${result.name}（宿主骨骼：${result.bone}）`)
    }
  )

  defineWrite(
    {
      name: 'setSlotProps',
      title: '设置插槽属性',
      description:
        '写入插槽的颜色 / 混合模式 / 可见性 / 锁定 / setup 显示项。换宿主骨骼请用 setSlotHost（那个会保持全局位姿）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        color: { type: 'string', description: '插槽颜色 #RRGGBBAA（与附件颜色相乘）' },
        blendMode: { type: 'string', description: '混合模式', values: ['Normal', 'Additive', 'Multiply', 'Screen'] },
        attachment: { type: 'string', description: 'setup pose 显示的附件名；空串 = 不显示' },
        visible: { type: 'boolean', description: '是否可见' },
        locked: { type: 'boolean', description: '锁定' }
      },
      returns: '{ slot, changedFields: [...] }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const options = compact({
        slot,
        color: optText(args, 'color'),
        blendMode: optText(args, 'blendMode'),
        attachment: typeof args.attachment === 'string' ? args.attachment.trim() : undefined,
        visible: optBool(args, 'visible'),
        locked: optBool(args, 'locked')
      })
      const fields = Object.keys(options).filter((key) => key !== 'slot')
      requireSomeField(fields)
      setSlotProps(draft, options)
      return changed({ slot, changedFields: fields }, `已更新插槽 ${slot} 的 ${fields.join(' / ')}`)
    }
  )

  defineWrite(
    {
      name: 'setSlotHost',
      title: '换插槽宿主骨骼',
      description: '把插槽挂到另一根骨骼下，并保持内容的全局位置 / 旋转 / 缩放不变',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        bone: { type: 'string', description: '新的宿主骨骼名', required: true }
      },
      returns: '{ slot, bone }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const bone = need(args, 'bone')
      setSlotHost(draft, slot, bone)
      return changed({ slot, bone }, `已把插槽 ${slot} 挂到 ${bone} 下（全局位姿保持不变）`)
    }
  )

  defineWrite(
    {
      name: 'deleteSlot',
      title: '删除插槽',
      description: '删除插槽（连带它的附件与相关动画轨道）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true }
      },
      returns: '{ slot }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      if (!draft.slots.some((item) => item.name === slot)) {
        throw new Error(`插槽不存在：${slot}（用 listSlots 查现有插槽名）`)
      }
      deleteSlot(draft, slot)
      return changed({ slot }, `已删除插槽 ${slot}`)
    }
  )

  // ---------------- 约束 ----------------

  defineWrite(
    {
      name: 'addConstraint',
      title: '新建约束',
      description:
        '新建 IK / 变换 / 路径约束。IK 的 bones 要给「父 → 子」连续的骨链（顺序反了会自动翻转）；不传 target 会自动新建一根 IK 节点骨摆在链尾末端',
      args: {
        kind: { type: 'string', description: '约束类型', required: true, values: ['ik', 'transform', 'path'] },
        name: { type: 'string', description: '约束名；不传则用类型名，重名自动加序号' },
        bones: { type: 'array', description: '被驱动的骨链，父 → 子顺序（字符串数组）' },
        target: { type: 'string', description: '目标骨骼名（IK 目标 / 变换来源骨 / 路径骨）' },
        nodePosition: { type: 'object', description: 'IK 自动新建节点骨时的落点（世界坐标 {x,y}）' },
        nodeName: { type: 'string', description: 'IK 自动新建节点骨的名字，默认「链尾_ik」' }
      },
      returns: '{ name, kind, bones, target, nodeBone? }'
    },
    (draft, args) => {
      const kind = need(args, 'kind')
      if (kind !== 'ik' && kind !== 'transform' && kind !== 'path') {
        throw new Error(`kind 只能是 ik / transform / path，收到 ${kind}`)
      }
      const result = addConstraint(
        draft,
        compact({
          kind,
          name: optText(args, 'name'),
          bones: optTextList(args, 'bones'),
          target: optText(args, 'target'),
          nodePosition: optVec(args, 'nodePosition'),
          nodeName: optText(args, 'nodeName')
        })
      )
      const tail = result.nodeBone ? `，并新建了节点骨 ${result.nodeBone}` : ''
      return changed(result, `已新建 ${kind} 约束 ${result.name}（骨链：${result.bones.join(' → ')}${tail}）`)
    }
  )

  defineWrite(
    {
      name: 'setConstraint',
      title: '设置约束',
      description: '改约束的启用状态 / 目标骨 / 优先级（计算顺序）。IK 也可以重设骨链',
      args: {
        constraint: { type: 'string', description: '约束名', required: true },
        enabled: { type: 'boolean', description: '是否启用' },
        target: { type: 'string', description: '新的目标骨骼名' },
        order: { type: 'number', description: '优先级（越小越先算）' },
        bones: { type: 'array', description: 'IK 的新骨链，父 → 子顺序（字符串数组）' }
      },
      returns: '{ constraint, changedFields: [...] }'
    },
    (draft, args) => {
      const name = need(args, 'constraint')
      const constraint = draft.constraints.find((item) => item.name === name)
      if (!constraint) throw new Error(`约束不存在：${name}（用 listConstraints 查现有约束名）`)
      const fields: string[] = []
      const enabled = optBool(args, 'enabled')
      if (enabled !== undefined) {
        constraint.enabled = enabled
        fields.push('enabled')
      }
      const target = optText(args, 'target')
      if (target !== undefined) {
        if (!draft.bones.some((bone) => bone.name === target)) throw new Error(`目标骨骼不存在：${target}`)
        constraint.target = target
        fields.push('target')
      }
      const order = optNum(args, 'order')
      if (order !== undefined) {
        constraint.order = order
        fields.push('order')
      }
      const bones = optTextList(args, 'bones')
      if (bones !== undefined) {
        if (constraint.type !== 'ik') throw new Error('只有 IK 约束能改骨链（变换 / 路径约束的第一根就是宿主骨）')
        const chain = asBoneChain(draft, bones)
        if (chain.length === 0) throw new Error(`IK 骨链必须「父 → 子」连续：${bones.join(' / ')} 不构成一条链`)
        constraint.bones = chain
        fields.push('bones')
      }
      requireSomeField(fields)
      return changed({ constraint: name, changedFields: fields }, `已更新约束 ${name} 的 ${fields.join(' / ')}`)
    }
  )

  defineWrite(
    {
      name: 'deleteConstraint',
      title: '删除约束',
      description: '删除约束（不会删掉它引用的骨骼）',
      args: {
        constraint: { type: 'string', description: '约束名', required: true }
      },
      returns: '{ constraint }'
    },
    (draft, args) => {
      const name = need(args, 'constraint')
      const index = draft.constraints.findIndex((item) => item.name === name)
      if (index < 0) throw new Error(`约束不存在：${name}（用 listConstraints 查现有约束名）`)
      draft.constraints.splice(index, 1)
      return changed({ constraint: name }, `已删除约束 ${name}`)
    }
  )

  // ---------------- 附件 ----------------

  defineWrite(
    {
      name: 'addDisplay',
      title: '加图片附件',
      description: '往插槽里加一个图片附件。尺寸自动从图片池取，不用自己算',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        image: { type: 'string', description: '图片名（用 listImages 查）', required: true },
        name: { type: 'string', description: '附件名；不传则用图片名去扩展名，重名自动加序号' },
        position: { type: 'object', description: '附件在骨骼局部空间的位置 {x,y}' },
        skin: { type: 'string', description: '目标皮肤；不传则用当前皮肤' }
      },
      returns: '{ slot, attachment }',
      example: { slot: 'torso', image: 'body.png', name: 'body_art', position: { x: 0, y: 0.5 } }
    },
    (draft, args) => {
      const result = addDisplay(
        draft,
        compact({
          slot: need(args, 'slot'),
          image: need(args, 'image'),
          name: optText(args, 'name'),
          position: optVec(args, 'position'),
          skin: optText(args, 'skin')
        })
      )
      // 参考图装配中（工程里铺了底图）就把对位循环递到 AI 眼前：
      // 不提示它就会倾向「外部算好坐标一口气挂完」，跳过与底图的对位
      const next = draft.editorMeta.stage
        ? [
            `参考图装配中：调 getDisplayWorldBounds {slot:'${result.slot}', attachment:'${result.attachment}'} 读世界包围盒，与底图量出的目标框对比，不对就 setDisplayTransform 修到重合；对齐这个部件再挂下一个`
          ]
        : undefined
      return changed({ ...result, next }, `已给插槽 ${result.slot} 加上附件 ${result.attachment}`)
    }
  )

  defineWrite(
    {
      name: 'setDisplayTransform',
      title: '设置附件变换',
      description: '写入附件的位移 / 旋转 / 缩放 / 尺寸 / 颜色 / 换图（跨所有皮肤同步改）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        position: { type: 'object', description: '位置 {x,y}（骨骼局部空间）' },
        rotation: { type: 'number', description: '旋转（度）' },
        scale: { type: 'object', description: '缩放 {x,y}' },
        size: { type: 'object', description: 'Region 显示尺寸 {x,y}' },
        color: { type: 'string', description: '附件颜色 #RRGGBBAA' },
        image: { type: 'string', description: '换图（图片名）' }
      },
      returns: '{ slot, attachment, changedFields: [...] }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      const options = compact({
        slot,
        attachment,
        position: optVec(args, 'position'),
        rotation: optNum(args, 'rotation'),
        scale: optVec(args, 'scale'),
        size: optVec(args, 'size'),
        color: optText(args, 'color'),
        image: optText(args, 'image')
      })
      const fields = Object.keys(options).filter((key) => key !== 'slot' && key !== 'attachment')
      requireSomeField(fields)
      setAttachmentTransform(draft, options)
      return changed(
        { slot, attachment, changedFields: fields },
        `已更新附件 ${slot} / ${attachment} 的 ${fields.join(' / ')}`
      )
    }
  )

  defineWrite(
    {
      name: 'setNestedArmature',
      title: '设置嵌套骨架',
      description:
        '改嵌套骨架 display 的引用与默认播放参数：引用骨架名 / 默认子动画 / 播放次数（0=循环）/ 起始偏移 / 倍速。只对 type=armature 的 display 有效',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '嵌套骨架 display 名', required: true },
        armature: { type: 'string', description: '引用哪个骨架（同工程里的骨架名；空串 = 断开引用）' },
        animation: { type: 'string', description: 'setup 默认播放的子动画名；空串 = setup 姿态' },
        playTimes: { type: 'number', description: '播放次数：0 = 无限循环' },
        offset: { type: 'number', description: '起始偏移（秒）' },
        speed: { type: 'number', description: '倍速，1 = 原速' }
      },
      returns: '{ slot, attachment, changedFields }',
      example: { slot: 'weapon', attachment: 'Sword', armature: 'Sword', animation: 'idle', playTimes: 0, speed: 1 }
    },
    (draft, args) => {
      const result = setNestedArmature(draft, {
        slot: need(args, 'slot'),
        attachment: need(args, 'attachment'),
        armature: optText(args, 'armature'),
        animation: optText(args, 'animation'),
        playTimes: optNum(args, 'playTimes'),
        offset: optNum(args, 'offset'),
        speed: optNum(args, 'speed')
      })
      return changed(
        result,
        `已更新嵌套骨架 ${result.slot} / ${result.attachment} 的 ${result.changedFields.join(' / ')}`
      )
    }
  )

  defineWrite(
    {
      name: 'deleteDisplay',
      title: '删除附件',
      description: '删除附件（跨所有皮肤）；若 setup pose 正显示它，会一并清空显示引用',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true }
      },
      returns: '{ slot, attachment }'
    },
    (draft, args) => {
      const slot = need(args, 'slot')
      const attachment = need(args, 'attachment')
      deleteDisplay(draft, slot, attachment)
      return changed({ slot, attachment }, `已删除附件 ${slot} / ${attachment}`)
    }
  )

  // ---------------- 动画 ----------------

  defineWrite(
    {
      name: 'addAnimation',
      title: '新建动画',
      description: '新建一条空动画，默认顺手切为当前编辑动画',
      args: {
        name: { type: 'string', description: '动画名；不传则为 animation，重名自动加序号' },
        duration: { type: 'number', description: '时长（秒），默认 1' },
        activate: { type: 'boolean', description: '是否切为当前编辑动画，默认 true' }
      },
      returns: '{ name, duration }',
      example: { name: 'walk', duration: 1.5 }
    },
    (draft, args) => {
      const result = addAnimation(
        draft,
        compact({
          name: optText(args, 'name'),
          duration: optNum(args, 'duration'),
          activate: optBool(args, 'activate')
        })
      )
      return changed(result, `已新建动画 ${result.name}（时长 ${result.duration} 秒）`)
    }
  )

  defineWrite(
    {
      name: 'removeAnimation',
      title: '删除动画',
      description: '删除一条动画',
      args: {
        animation: { type: 'string', description: '动画名', required: true }
      },
      returns: '{ animation }'
    },
    (draft, args) => {
      const animation = need(args, 'animation')
      removeAnimation(draft, animation)
      return changed({ animation }, `已删除动画 ${animation}`)
    }
  )

  defineWrite(
    {
      name: 'renameAnimation',
      title: '重命名动画',
      description: '重命名一条动画',
      args: {
        animation: { type: 'string', description: '原动画名', required: true },
        next: { type: 'string', description: '新动画名', required: true }
      },
      returns: '{ name }'
    },
    (draft, args) => {
      const animation = need(args, 'animation')
      const result = renameAnimation(draft, animation, need(args, 'next'))
      return changed(result, `已把动画 ${animation} 改名为 ${result.name}`)
    }
  )

  defineWrite(
    {
      name: 'setAnimationDuration',
      title: '设置动画时长',
      description: '设置动画时长（秒）。注意：缩短到最后一帧之前会在播放时截掉后面的帧',
      args: {
        animation: { type: 'string', description: '动画名；不传则用当前编辑动画' },
        duration: { type: 'number', description: '时长（秒）', required: true }
      },
      returns: '{ name, duration }'
    },
    (draft, args) => {
      const duration = optNum(args, 'duration')
      if (duration === undefined) throw new Error('缺少参数 duration（数字，单位秒）')
      const result = setAnimationDuration(draft, optText(args, 'animation') ?? '', duration)
      return changed(result, `动画 ${result.name} 的时长已设为 ${result.duration} 秒`)
    }
  )

  defineWrite(
    {
      name: 'setActiveAnimation',
      title: '切换当前动画',
      description: '切换正在编辑 / 播放的动画（时间轴与视口会跟着换）',
      args: {
        animation: { type: 'string', description: '动画名', required: true }
      },
      returns: '{ name }'
    },
    (draft, args) => {
      const result = setActiveAnimation(draft, need(args, 'animation'))
      return changed(result, `已切换到动画 ${result.name}`)
    }
  )
}
