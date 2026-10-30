import type { EditorDocument } from '@core/model/authoring'
import { lastKeyTime, rootBoneName } from '@core/model/authoring'
import { getActiveScene } from '../activeScene'
import { currentSelection } from '../store/selectionStore'
import { useProjectStore } from '../store/projectStore'
import { useModeStore } from '../store/modeStore'
import { useTimelineStore } from '../store/timelineStore'
import { usePlayheadStore } from '../store/playheadStore'
import { defineRead } from './registry'
import type { Args } from './registry'
import { t } from '@i18n'

/**
 * 查询命令：让 AI **先看见再动手**。
 *
 * 编辑器的对象一律用**名字**互相引用（父骨骼、宿主骨骼、目标骨骼都是名字），
 * 这对 AI 其实很友好 —— 不用去算下标。但前提是它能查到「现在有哪些名字」。
 * 所以这批命令是整套 AI 接口的地基：没有它们，AI 只能盲猜名字然后反复失败。
 *
 * 全部只读：不动文档、不进撤销栈、不标脏。
 */

function doc(): EditorDocument {
  return useProjectStore.getState().document
}

function str(args: Args, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function registerQueryCommands(): void {
  defineRead(
    {
      name: 'getProjectState',
      title: '查工程状态',
      description: '当前工程名、保存路径、是否有未保存改动、有几个骨架、撤销栈状态。AI 开工前先读它',
      args: {},
      returns: 'projectName / projectPath / dirty / activeSkeleton / skeletonCount / canUndo / canRedo / warnings / next（建议的下一步）'
    },
    () => {
      const state = useProjectStore.getState()
      // 状态感知的下一步建议：AI 拿到状态就知道该往哪走，少一轮试错
      const next: string[] = []
      if (!state.projectPath) {
        next.push('工程还没落盘：先 createProject {name, dir} 或 saveProject {path}，否则 importImages / setStage / exportProject 都会被拒')
      } else if (state.dirty) {
        next.push('有未保存改动：做完这轮改完后 saveProject')
      }
      if (state.skeletons.length > 1) {
        next.push(`多骨架工程（${state.skeletons.length} 个）：list* / key* 只作用于当前骨架「${state.document.armatureName}」，切换用 setActiveSkeleton`)
      }
      if (next.length === 0) {
        next.push('用 listBones / listSlots / listImages / listAnimations 核对名字后再动手；批量改动用 POST /batch + transaction')
      }
      return {
        projectName: state.projectName,
        projectPath: state.projectPath,
        dirty: state.dirty,
        activeSkeleton: state.activeSkeleton,
        skeletonCount: state.skeletons.length,
        skeletons: state.skeletons.map((item, index) => ({
          index,
          armatureName: item.armatureName,
          active: index === state.activeSkeleton,
          bones: item.bones.length,
          slots: item.slots.length,
          animations: item.animations.length,
          // 嵌套骨架要按名字引用「别的骨架」：动画名一并给出来，AI 不必先切换骨架再查一遍
          animationNames: item.animations.map((animation) => animation.name)
        })),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        undoLabel: state.undoLabel,
        redoLabel: state.redoLabel,
        warnings: state.warnings,
        next
      }
    }
  )

  defineRead(
    {
      name: 'getSelection',
      title: '查当前选中',
      description: '层级树 / 视口里当前选中的对象与顶点。AI 想「对用户选中的东西做事」时读它',
      args: {},
      returns: 'kind（none/bone/slot/attachment/constraint）/ bone / bones / slot / skin / attachment / constraint / vertices'
    },
    () => {
      const selection = currentSelection()
      return {
        kind: selection.kind,
        bone: selection.bone,
        bones: [...selection.bones],
        slot: selection.slot,
        skin: selection.skin,
        attachment: selection.attachment,
        constraint: selection.constraint,
        vertices: [...selection.vertices],
        vertex: selection.vertex
      }
    }
  )

  defineRead(
    {
      name: 'listBones',
      title: '列骨骼',
      description: '列出全部骨骼（按工程里的顺序），含父级、局部变换、骨长。构建骨架前先读它拿准名字',
      args: {
        name: { type: 'string', description: '只看某一根（可选，按名字精确匹配）' }
      },
      returns: 'bones: [{ name, parent, localPosition, rotation, localScale, length, color, locked, children }]'
    },
    (args) => {
      const document = doc()
      const only = str(args, 'name')
      const bones = document.bones
        .filter((bone) => !only || bone.name === only)
        .map((bone) => ({
          name: bone.name,
          parent: bone.parent,
          localPosition: { ...bone.localPosition },
          rotation: bone.rotation,
          localScale: { ...bone.localScale },
          localShear: { ...bone.localShear },
          length: bone.length,
          color: bone.color,
          locked: bone.locked,
          inheritRotation: bone.inheritRotation,
          inheritScale: bone.inheritScale,
          childCount: childCount(document, bone.name)
        }))
      return { rootBone: rootBoneName(document.bones), count: document.bones.length, bones }
    }
  )

  defineRead(
    {
      name: 'listSlots',
      title: '列插槽',
      description: '列出全部插槽，含宿主骨骼、绘制层序、setup pose 显示的附件、以及它的附件名清单',
      args: {
        name: { type: 'string', description: '只看某一个（可选）' },
        withDisplays: { type: 'boolean', description: '是否带上附件名清单，默认 true', default: true }
      },
      returns: 'slots: [{ name, bone, zOrder, attachment, visible, locked, blendMode, color, displays }]'
    },
    (args) => {
      const document = doc()
      const only = str(args, 'name')
      const withDisplays = args.withDisplays !== false
      const skin = document.skins.find((item) => item.name === document.editorMeta.activeSkin) ?? document.skins[0]
      const slots = document.slots
        .filter((slot) => !only || slot.name === only)
        .map((slot) => ({
          name: slot.name,
          bone: slot.bone,
          zOrder: slot.zOrder,
          attachment: slot.attachment,
          visible: slot.visible,
          locked: slot.locked,
          blendMode: slot.blendMode,
          color: slot.color,
          ...(withDisplays
            ? { displays: skin?.slots.find((item) => item.slot === slot.name)?.attachments.map((item) => item.name) ?? [] }
            : {})
        }))
      return { skin: skin?.name ?? '', count: document.slots.length, slots }
    }
  )

  defineRead(
    {
      name: 'listDisplays',
      title: '列附件',
      description:
        '列出某个插槽（或全部插槽）在各皮肤下的附件：类型、图片、顶点数、权重绑了哪些骨骼；嵌套骨架 display 还带引用的骨架与默认播放参数',
      args: {
        slot: { type: 'string', description: '插槽名（可选，不传则列全部）' },
        skin: { type: 'string', description: '皮肤名（可选，默认当前皮肤）' }
      },
      returns:
        'displays: [{ slot, skin, name, type, image, size, vertexCount, bones, nested?: { armature, animation, playTimes, offset, speed } }]'
    },
    (args) => {
      const document = doc()
      const slotName = str(args, 'slot')
      const skinName = str(args, 'skin')
      const skins = skinName ? document.skins.filter((item) => item.name === skinName) : document.skins
      const displays: unknown[] = []
      for (const skin of skins) {
        for (const item of skin.slots) {
          if (slotName && item.slot !== slotName) continue
          for (const attachment of item.attachments) {
            displays.push({
              slot: item.slot,
              skin: skin.name,
              name: attachment.name,
              type: attachment.type,
              image: attachment.image,
              size: { ...attachment.size },
              position: { ...attachment.position },
              rotation: attachment.rotation,
              scale: { ...attachment.scale },
              vertexCount: attachment.vertices.length,
              bones: attachment.bones ?? [],
              ...(attachment.type === 'armature'
                ? {
                    nested: {
                      armature: attachment.subArmature,
                      animation: attachment.subAnimation,
                      playTimes: attachment.subPlayTimes,
                      offset: attachment.subOffset,
                      speed: attachment.subSpeed
                    }
                  }
                : {})
            })
          }
        }
      }
      return { count: displays.length, displays }
    }
  )

  defineRead(
    {
      name: 'listConstraints',
      title: '列约束',
      description: '列出全部约束：类型、被驱动的骨链、目标骨、是否启用、优先级',
      args: {},
      returns: 'constraints: [{ name, type, bones, target, order, enabled }]'
    },
    () => {
      const document = doc()
      return {
        count: document.constraints.length,
        constraints: document.constraints.map((item) => ({
          name: item.name,
          type: item.type,
          bones: [...item.bones],
          target: item.target,
          order: item.order,
          enabled: item.enabled
        }))
      }
    }
  )

  defineRead(
    {
      name: 'listAnimations',
      title: '列动画',
      description: '列出全部动画：时长、各轨道的关键帧数量与最后一帧时间。打帧前先读它确认动画名',
      args: {},
      returns: 'animations: [{ name, duration, lastKeyTime, bones, slots, deforms, drawOrder, active }]'
    },
    () => {
      const document = doc()
      return {
        active: document.editorMeta.activeAnimation,
        frameRate: document.frameRate,
        count: document.animations.length,
        animations: document.animations.map((anim) => ({
          name: anim.name,
          duration: anim.duration,
          lastKeyTime: lastKeyTime(anim),
          active: anim.name === document.editorMeta.activeAnimation,
          bones: anim.bones.map((track) => ({
            bone: track.bone,
            translate: track.translate.length,
            rotate: track.rotate.length,
            scale: track.scale.length,
            shear: track.shear.length
          })),
          slots: anim.slots.map((track) => ({
            slot: track.slot,
            color: track.color.length,
            display: track.displayIndex.length,
            visible: track.visible.length
          })),
          deforms: anim.deforms.map((track) => ({
            slot: track.slot,
            attachment: track.attachment,
            frames: track.frames.length
          })),
          drawOrder: anim.drawOrder.length
        }))
      }
    }
  )

  defineRead(
    {
      name: 'getAnimationKeys',
      title: '查动画关键帧',
      description: '把某条动画的关键帧明细拉出来（可只查一根骨骼 / 一个插槽），用来核对打帧结果或做批量改帧前的读取',
      args: {
        animation: { type: 'string', description: '动画名（可选，默认当前编辑动画）' },
        bone: { type: 'string', description: '只查这根骨骼的轨道（可选）' },
        slot: { type: 'string', description: '只查这个插槽的轨道（可选）' }
      },
      returns: 'animation / duration / bones[{ bone, channel, keys:[{time,value,easing}] }] / slots[...] / deforms[...] / drawOrder[...]'
    },
    (args) => {
      const document = doc()
      const name = str(args, 'animation') || document.editorMeta.activeAnimation
      const anim = document.animations.find((item) => item.name === name)
      if (!anim) {
        throw new Error(t('动画不存在：{0}（用 listAnimations 查现有动画名）', name || '(空)'))
      }
      const boneFilter = str(args, 'bone')
      const slotFilter = str(args, 'slot')
      return {
        animation: anim.name,
        duration: anim.duration,
        bones: anim.bones
          .filter((track) => !boneFilter || track.bone === boneFilter)
          .map((track) => ({
            bone: track.bone,
            translate: frames(track.translate),
            rotate: frames(track.rotate),
            scale: frames(track.scale),
            shear: frames(track.shear)
          })),
        slots: anim.slots
          .filter((track) => !slotFilter || track.slot === slotFilter)
          .map((track) => ({
            slot: track.slot,
            color: frames(track.color),
            display: track.displayIndex.map((frame, index) => ({
              time: frame.time,
              attachment: track.displayAttachment[index] ?? '',
              easing: frame.easing
            })),
            visible: frames(track.visible),
            // 嵌套骨架通道：动画名 + 循环次数 / 偏移 / 倍速（对象型帧，不是 value 数值帧）
            subArmature: (track.subArmature ?? []).map((frame) => ({
              time: frame.time,
              clip: frame.animation,
              playTimes: frame.playTimes,
              offset: frame.offset,
              speed: frame.speed,
              easing: frame.easing
            }))
          })),
        deforms: anim.deforms
          .filter((track) => !slotFilter || track.slot === slotFilter)
          .map((track) => ({
            slot: track.slot,
            attachment: track.attachment,
            frames: track.frames.map((frame) => ({
              time: frame.time,
              easing: frame.easing,
              offsets: frame.offsets.length > 16 ? `${frame.offsets.length} 个数字` : [...frame.offsets]
            }))
          })),
        drawOrder: anim.drawOrder.map((frame) => ({ time: frame.time, order: [...frame.order] }))
      }
    }
  )

  defineRead(
    {
      name: 'listImages',
      title: '列图片池',
      description: '列出图片池里可用的图片（名字与像素尺寸）。addDisplay 要用这里的名字',
      args: {},
      returns: 'images: [{ name, path, width, height }]'
    },
    () => {
      const document = doc()
      return {
        count: document.images.length,
        images: document.images.map((image) => ({
          name: image.name,
          path: image.path,
          width: image.width,
          height: image.height
        }))
      }
    }
  )

  defineRead(
    {
      name: 'listSkins',
      title: '列皮肤',
      description: '列出全部皮肤与各自槽数，标出当前皮肤',
      args: {},
      returns: 'active / skins: [{ name, slots, active }]'
    },
    () => {
      const document = doc()
      return {
        active: document.editorMeta.activeSkin || document.skins[0]?.name || '',
        skins: document.skins.map((skin) => ({ name: skin.name, slots: skin.slots.length, active: skin.name === document.editorMeta.activeSkin }))
      }
    }
  )

  defineRead(
    {
      name: 'getAttachmentVertices',
      title: '查网格/遮罩顶点与权重',
      description:
        '拉出某个网格或遮罩附件的全部顶点：坐标 + 每根骨骼的权重。蒙皮调试、手写权重或给遮罩打 FFD 前读它',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        skin: { type: 'string', description: '皮肤名（可选，默认当前皮肤）' }
      },
      returns: 'type / vertexCount / vertices: [{ index, x, y, weights: [{bone, weight}] }] / triangles / boundBones'
    },
    (args) => {
      const document = doc()
      const attachment = findAttachment(document, str(args, 'slot'), str(args, 'attachment'), str(args, 'skin'))
      return {
        slot: str(args, 'slot'),
        attachment: attachment.name,
        type: attachment.type,
        vertexCount: attachment.vertices.length,
        vertices: attachment.vertices.map((vertex, index) => ({
          index,
          x: vertex.x,
          y: vertex.y,
          weights: vertex.weights.map((weight) => ({ bone: weight.bone, weight: weight.weight }))
        })),
        triangles: attachment.triangles.length,
        boundBones: attachment.bones ?? []
      }
    }
  )

  defineRead(
    {
      name: 'getBoneWorldTransform',
      title: '查骨骼世界位姿',
      description:
        '骨骼在视口世界坐标下的位置 / 旋转 / 缩放（含父级累积）。要在世界坐标里摆东西（IK 节点骨、附件落点）时用它换算',
      args: {
        bone: { type: 'string', description: '骨骼名', required: true }
      },
      returns: 'x / y / rotation（度）/ scaleX / scaleY；场景未就绪时 ok:false'
    },
    (args) => {
      const name = str(args, 'bone')
      if (!doc().bones.some((bone) => bone.name === name)) {
        throw new Error(t('骨骼不存在：{0}（用 listBones 查现有骨骼名）', name))
      }
      const matrix = getActiveScene()?.worldMatrixOf(name) ?? null
      if (!matrix || matrix.length < 16) {
        throw new Error(t('视口场景还没就绪，取不到世界坐标（动画播放中或窗口未打开时会这样）'))
      }
      return {
        bone: name,
        x: matrix[12],
        y: matrix[13],
        rotation: (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI,
        scaleX: Math.hypot(matrix[0], matrix[1]),
        scaleY: Math.hypot(matrix[4], matrix[5])
      }
    }
  )

  defineRead(
    {
      name: 'getDisplayWorldBounds',
      title: '查附件世界包围盒',
      description:
        '附件在视口世界坐标下的 AABB（当前 setup pose）。**参考图对位的主力命令**：挂上一个部件就读它，与参考图量出的目标框对比，再用 setDisplayTransform 修——数值闭环，不用截图也不用在外部自己算坐标。网格按绑定姿态顶点近似（蒙皮形变不含在内）',
      args: {
        slot: { type: 'string', description: '插槽名', required: true },
        attachment: { type: 'string', description: '附件名', required: true },
        skin: { type: 'string', description: '皮肤名（可选，默认当前皮肤）' }
      },
      returns: 'type / worldBounds{minX,minY,maxX,maxY} / center{x,y} / width / height'
    },
    (args) => {
      const slotName = str(args, 'slot')
      const attachmentName = str(args, 'attachment')
      const document = doc()
      const att = findAttachment(document, slotName, attachmentName, str(args, 'skin'))
      const slot = document.slots.find((item) => item.name === slotName)
      if (!slot) throw new Error(t('找不到插槽：{0}（用 listSlots 查）', slotName))
      const matrix = getActiveScene()?.worldMatrixOf(slot.bone) ?? null
      if (!matrix || matrix.length < 16) {
        throw new Error(t('视口场景还没就绪，取不到世界坐标（窗口未打开或正在初始化时会这样）'))
      }
      // 附件局部空间采样点：Mesh 用绑定姿态顶点；Region 用内容四角
      // （局部 = position + R(rotation) · S(scale) · (contentOffset ± size/2)，与 setDisplayTransform 语义一致）
      const locals: Array<{ x: number; y: number }> = []
      if (att.type === 'mesh' && att.vertices.length > 0) {
        for (const vertex of att.vertices) locals.push({ x: vertex.x, y: vertex.y })
      } else {
        const halfW = att.size.x / 2
        const halfH = att.size.y / 2
        const rad = (att.rotation * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const cx = att.contentOffset.x + sx * halfW
            const cy = att.contentOffset.y + sy * halfH
            locals.push({
              x: att.position.x + cx * att.scale.x * cos - cy * att.scale.y * sin,
              y: att.position.y + cx * att.scale.x * sin + cy * att.scale.y * cos
            })
          }
        }
      }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const point of locals) {
        const wx = matrix[0] * point.x + matrix[4] * point.y + matrix[12]
        const wy = matrix[1] * point.x + matrix[5] * point.y + matrix[13]
        if (wx < minX) minX = wx
        if (wy < minY) minY = wy
        if (wx > maxX) maxX = wx
        if (wy > maxY) maxY = wy
      }
      return {
        slot: slotName,
        attachment: att.name,
        type: att.type,
        worldBounds: { minX, minY, maxX, maxY },
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        width: maxX - minX,
        height: maxY - minY
      }
    }
  )

  defineRead(
    {
      name: 'getViewport',
      title: '查视口',
      description:
        '视口相机与可见范围：像素尺寸、缩放、平移量、当前可见的世界矩形、角色包围盒，以及当前模式 / 皮肤 / 动画 / 播放状态。AI 想「看屏幕」或做屏幕↔世界坐标换算时用它',
      args: {},
      returns:
        'width / height / zoom / offset{x,y} / unitsPerPixel / worldView{minX,minY,maxX,maxY} / contentBounds / mode / activeSkin / animation / playing / time / next（建议的下一步）'
    },
    () => {
      const scene = getActiveScene()
      const vp = scene?.viewport
      const document = doc()
      if (!scene || !vp) throw new Error(t('视口还没就绪（窗口未打开或正在初始化）'))
      const w = vp.width
      const h = vp.height
      const corners = [vp.screenToWorld(0, 0), vp.screenToWorld(w, 0), vp.screenToWorld(0, h), vp.screenToWorld(w, h)]
      const xs = corners.map((corner) => corner.x)
      const ys = corners.map((corner) => corner.y)
      const bounds = scene.meshResult?.bounds ?? null
      // 状态感知的下一步建议
      const next: string[] = []
      if (useTimelineStore.getState().playing) {
        next.push('正在播放预览：打帧改的是文档里的姿势值，若要边看边调先 setPlaying {playing:false}')
      }
      if (!bounds) {
        next.push('视口里还没有可框取的内容：importImages 进图后 addDisplay 挂图，或 focusNode 看已有节点')
      } else {
        next.push('focusNode {kind, name} 聚焦某节点；centerViewport / setViewportZoom 调整构图')
      }
      if (document.animations.length === 0) {
        next.push('还没有动画：addAnimation {name, duration} 建一条后才能打帧')
      }
      return {
        width: w,
        height: h,
        zoom: vp.zoom,
        offset: vp.offset,
        unitsPerPixel: 1 / vp.zoom,
        worldView: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
        contentBounds: bounds
          ? { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY }
          : null,
        mode: useModeStore.getState().mode,
        activeSkeleton: useProjectStore.getState().activeSkeleton,
        activeSkin: document.editorMeta.activeSkin,
        animation: document.editorMeta.activeAnimation,
        playing: Boolean(useTimelineStore.getState().playing),
        time: useTimelineStore.getState().time,
        next
      }
    }
  )

  defineRead(
    {
      name: 'captureViewport',
      title: '截视口画面',
      description:
        '把视口画面截成 PNG（含背景棋盘格、角色与叠加层），返回 base64 data URL。AI 想「亲眼看到」编辑器里显示的画面时用它。**要预览动画动作时必须传 time**（或先 setTime）：AI 通常在别的窗口里驱动编辑器，窗口在后台时播放时钟不走，不指定时间就只会拍到第 0 帧 —— 看起来「只有绑定姿态、动画没生效」。窗口在后台也能截（命令会自己刷新一帧再取像素）',
      args: {
        time: { type: 'number', description: '先 seek 到该时间点（秒）再截图；预览某个动作请务必传' },
        animation: { type: 'string', description: '动画名（可选）：截图前先切到该动画' }
      },
      returns: 'dataUrl（data:image/png;base64,…）/ width / height / animation / time（实际截取的时间点）'
    },
    (args) => {
      const scene = getActiveScene()
      if (!scene) throw new Error(t('视口还没就绪（窗口未打开或正在初始化）'))

      const animationName = str(args, 'animation')
      if (animationName) {
        const exists = doc().animations.some((item) => item.name === animationName)
        if (!exists) throw new Error(t('没有这个动画：{0}（用 listAnimations 查全部动画名）', animationName))
        useTimelineStore.getState().setAnimation(animationName)
      }

      const requested = args.time
      const time = typeof requested === 'number' && Number.isFinite(requested) ? Math.max(0, requested) : undefined
      const dataUrl = scene.captureViewport(time)
      if (!dataUrl) {
        throw new Error(
          '截图失败：渲染器没就绪，或 WebGL 上下文丢了（编辑器长时间在后台、系统休眠 / GPU 重置后会出现）。先直接重试一次；仍失败就把编辑器窗口切到前台再试，最后手段是重启编辑器'
        )
      }
      // 实际时间以播放器为准：seek 会被夹到动画末尾（传 10 秒、动画只有 1.2 秒时）
      const actualTime = scene.runtime?.player.time ?? 0
      if (time !== undefined) {
        /*
         * 两处时钟都要对齐：
         * - `timelineStore` 是暂停态的权威时间（视口 push 读它）；
         * - `playheadStore` 是播放态的权威时间（播放时 push 读它）。
         * 只写一个的话，另一条 push 路径会把刚 seek 的位置改回去 —— AI 连续截图就会
         * 看到时间在跳。
         */
        useTimelineStore.getState().setTime(actualTime)
        usePlayheadStore.getState().setTime(actualTime)
      }
      return {
        dataUrl,
        width: scene.viewport.width,
        height: scene.viewport.height,
        animation: scene.currentAnimation,
        time: actualTime
      }
    }
  )

  defineRead(
    {
      name: 'getHierarchy',
      title: '查完整层级结构',
      description:
        '一次性拿出当前骨架全貌：骨骼父子树（嵌套）+ 插槽与附件 + 约束 + 动画。等价于「读整个编辑器结构」，AI 先读它掌握全局，不必逐个 list*',
      args: {},
      returns:
        'armatureName / skeletonCount / skeletons[{armatureName, active, animations}] / boneTree[…] / slots[…]（displays 里嵌套骨架带 nested）/ constraints[…] / animations[…]'
    },
    () => {
      const document = doc()
      const roots = document.bones.filter((bone) => !bone.parent).map((bone) => bone.name)
      const skin = document.skins.find((item) => item.name === document.editorMeta.activeSkin) ?? document.skins[0]
      const slots = document.slots.map((slot) => ({
        name: slot.name,
        bone: slot.bone,
        zOrder: slot.zOrder,
        attachment: slot.attachment,
        visible: slot.visible,
        displays:
          skin?.slots
            .find((item) => item.slot === slot.name)
            ?.attachments.map((attachment) => ({
              name: attachment.name,
              type: attachment.type,
              image: attachment.image,
              ...(attachment.type === 'armature'
                ? {
                    nested: {
                      armature: attachment.subArmature,
                      animation: attachment.subAnimation,
                      playTimes: attachment.subPlayTimes,
                      offset: attachment.subOffset,
                      speed: attachment.subSpeed
                    }
                  }
                : {})
            })) ?? []
      }))
      const project = useProjectStore.getState()
      return {
        armatureName: document.armatureName,
        skeletonCount: project.skeletons.length,
        // 嵌套要按名字引用别的骨架：名字与「哪个是当前编辑的」一并给出来
        skeletons: project.skeletons.map((item, index) => ({
          armatureName: item.armatureName,
          active: index === project.activeSkeleton,
          animations: item.animations.map((animation) => animation.name)
        })),
        boneTree: buildBoneTree(document, roots),
        slots,
        constraints: document.constraints.map((constraint) => ({
          name: constraint.name,
          type: constraint.type,
          bones: [...constraint.bones],
          target: constraint.target,
          enabled: constraint.enabled
        })),
        animations: document.animations.map((animation) => ({ name: animation.name, duration: animation.duration }))
      }
    }
  )
}

function childCount(document: EditorDocument, parent: string): number {
  return document.bones.filter((bone) => bone.parent === parent).length
}

/** 骨骼层级节点：递归嵌套，让 AI 一次拿到「整个骨架的树状结构」 */
interface BoneNode {
  name: string
  parent: string
  length: number
  rotation: number
  localPosition: { x: number; y: number }
  children: BoneNode[]
}

/** 从一组根骨递归展开成树（按 parent 字段找子节点） */
function buildBoneTree(document: EditorDocument, roots: string[]): BoneNode[] {
  return roots.map((name) => {
    const bone = document.bones.find((item) => item.name === name)
    const children = document.bones.filter((item) => item.parent === name).map((item) => item.name)
    return {
      name,
      parent: bone?.parent ?? '',
      length: bone?.length ?? 0,
      rotation: bone?.rotation ?? 0,
      localPosition: bone ? { x: bone.localPosition.x, y: bone.localPosition.y } : { x: 0, y: 0 },
      children: buildBoneTree(document, children)
    }
  })
}

function frames<T extends { time: number; value: unknown; easing: number }>(list: readonly T[]) {
  return list.map((frame) => ({ time: frame.time, value: frame.value, easing: frame.easing }))
}

function findAttachment(document: EditorDocument, slotName: string, attachmentName: string, skinName: string) {
  if (!slotName || !attachmentName) {
    throw new Error(t('slot 与 attachment 都必须给（用 listDisplays 查）'))
  }
  const skins = skinName ? document.skins.filter((skin) => skin.name === skinName) : document.skins
  for (const skin of skins) {
    const skinSlot = skin.slots.find((item) => item.slot === slotName)
    const found = skinSlot?.attachments.find((item) => item.name === attachmentName)
    if (found) return found
  }
  throw new Error(
    t('找不到附件：{0} / {1}（用 listDisplays 查插槽下的附件名）', [slotName, attachmentName])
  )
}
