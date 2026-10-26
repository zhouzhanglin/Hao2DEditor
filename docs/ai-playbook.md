# Hao2DEditor 动画制作手册（AI 使用）

> **本文件是唯一权威来源**：构建时内联进应用（MCP instructions / `GET /commands` 的
> `playbook` 字段 / WS 握手），并在保存 / 打开工程时写进工程
> `ai/hao2d-ai-playbook.md`。改内容只改这里，代码里不做第二份。
> 照此执行可少走弯路。

## 坐标与单位（最先记住，错了全盘错）
- 世界坐标 y 轴向上；1 世界单位 = 100 像素（PPU=100），一张 512px 的图约 5.12 单位
- 角度单位是度；时间单位是秒，打帧给绝对时间点（不是相对偏移）
- 颜色 #RRGGBB，透明度 0-1；引用骨骼/插槽/附件/动画/皮肤一律用名字，不用下标

## 标准工作循环
1) 动手前先读状态：getProjectState 了解工程；listBones / listSlots / listImages / listAnimations / listSkins 核对名字，不要凭记忆猜
2) 一次搭多个东西走批量：POST /batch {"commands":[{"name","args"}...],"transaction":true,"label":"..."}（一次不超过 ~30 条；transaction 合并成一条撤销记录，失败整体回滚）
3) 做完就复核：getAnimationKeys 查打帧明细，getProjectState 复述文档状态；ok=false 时按 error 提示修正参数再试，不要原样重发

## 从零做一个动画（标准步骤）
1) 没有工程时 createProject {name, dir} 一步建好并落盘（不弹对话框，路径必须在参数里给全）
2) 素材进池：importImages {paths:[绝对路径...]}，或 importImage（base64/dataURL）；用 listImages 确认图片名
3) 搭骨骼：addBone {name, parent, localPosition:{x,y}, rotation, length} —— 先根后叶，length 给真实骨长（世界单位）；返回值里的 name 是最终名字（重名会加序号）
4) 建插槽并挂图：addSlot {name, bone, zOrder}（zOrder 越小越先画）→ addDisplay {slot, image}（附件尺寸自动取自图片池，不用自己算）
5) 要网格变形动画：convertToMesh 或 autoMeshFromImage 按轮廓生成网格 → autoWeightMesh 自动蒙皮 → getAttachmentVertices 读顶点下标（redrawMeshBoundary 重绘边界、connectMeshVertices 自定义布线都用它）
5b) 要遮罩裁剪：createMask {slot, points, endSlot?}（points 是**插槽骨骼局部坐标**，不是世界坐标；遮罩会裁绘制顺序中它之后、endSlot 之前的附件）→ 已有图片/网格用 convertToMask {slot, attachment, endSlot?, inverse?} → 改点用 setMaskPoints / setMaskPoint / insertMaskPoint / deleteMaskPoint，选项用 setMaskOptions；查询用 getMask / listMasks。遮罩的 FFD 直接 keyDeformFrame（offsets 长度 = 点数 × 2）
6) 建动画：addAnimation {name, duration}（duration 秒，默认 1，建好自动切为当前编辑动画）
7) 打帧（同一时间点重打即覆盖）：
   - 骨骼：keyBoneFrame {bone, channel, time, value}，channel 取 translate/rotate/scale/shear；rotate 的 value 是数字（度），其余是 {x,y}
   - 插槽：keySlotColorFrame / keySlotVisibleFrame / keySlotDisplayFrame {slot, time, attachment}（attachment 传空串 = 该帧起不显示）
8) 调缓动：setKeyframeEasing；事件帧：keyEvent {time, name?, stringParam?, intParam?, floatParam?}（name 不传自动取 event/event2…）
9) 复核 getAnimationKeys → saveProject → exportProject {mode:'runtime'|'unity'|'spine', dir}（导出也不弹对话框）

## 皮肤
addSkin {name} 建皮肤 → addDisplay {slot, image, skin} 往该皮肤放件 → keySlotDisplayFrame {slot, time, attachment, skin} 打显示帧完成切换；setActiveSkin 只影响编辑器当前预览

## 骨架嵌套（把一个骨架挂到另一个骨架的插槽上）
- 多骨架工程：`getProjectState` 的 `skeletons[]` 里有每个骨架的名字与 `animationNames`（子骨架动画名直接在这里看，不必先切换）；切当前编辑骨架用 `setActiveSkeleton`
- 挂上去：`nestArmature {slot, armature}` —— 在**当前编辑骨架**里，把工程内另一个骨架作为 display 挂到该插槽；会拒绝自引用 / 循环引用 / 超深
- 改引用或默认播放：`setNestedArmature {slot, attachment, armature?, animation?, playTimes?, offset?, speed?}`（`playTimes: 0` = 循环）
- 动画里控制子骨架：`keySlotSubArmatureFrame {slot, time, clip, playTimes?, offset?, speed?}` —— `clip` 是**子骨架里**的动画名（空串 = 回 setup 姿态）；`offset` 用来做「挥刀时刀光晚 3 帧起播」
- 换武器：同一插槽挂多个嵌套 display，用 `keySlotDisplayFrame` 切显示；`listDisplays` 的 `nested` 字段能看出每个 display 引用的是哪个骨架
- 子骨架帧也是普通关键帧：`getAnimationKeys` 的 `slots[].subArmature` 能读到，`moveKeyframe` / `setKeyframeEasing` / `clearTrack` 的 `channel` 传 `subArmature`

## 视口与检查
- focusNode {kind:'bone'|'slot'|'display'|'constraint', name} 把视口对准某节点；setTime / setPlaying 预览播放（播放只是编辑器内预览，交付物一律 exportProject 落盘）
- setStage {imagePath} 给视口铺背景参考图（需工程已保存；仅编辑器显示，不参与导出）

## 常见坑
- 所有文件类命令都不弹对话框：目录 / 路径必须在参数里给全；「场景未就绪」= 视口还没画完第一帧，稍后重试
- 撤销栈只有 80 条：大改动分批，不要把几十条命令拆成单发刷屏
- setActiveSkeleton / setActiveSkin 会清空选中与时间轴状态，切完先重新查状态
- 在线预览、画笔式刷权重是有意不开放的：预览给人看，权重用 autoWeightMesh
- 有装配参考图时（顺序很重要）：setStage {imagePath, opacity:0.5} 铺底图 → **先标定底图大小**：量参考图里某部件的像素尺寸 h_ref，用 listImages 读该部件实际图片的像素尺寸 h_img，比例 k=h_img/h_ref，再 updateStage {width,height} 把底图设为「参考图像素×k÷100」世界单位，使其与部件 1:1 → 底图大小定好后再对位：从「图片/图集页」**一张一张放、好一张再下一张**——addSlot（**不传 bone = 挂根骨骼**）+ addDisplay 放进视口，用 setDisplayTransform 调位置/旋转、setDrawOrder 调层级，captureViewport 对比到与底图重合（要数值用 getDisplayWorldBounds）→ **全部放好后停手等用户确认，不要直接绑骨** → 用户说没问题后，再 setSlotHost 把每个 slot 绑到对应骨骼（绑骨保持全局位姿，画面不动）→ removeStage 删底图。**别在外部算好坐标一口气执行**——以编辑器返回的几何与截图为准
- 别猜命令名：先 GET /commands（或 __catalog 命令）拿目录，每条命令的参数说明都在里面
- 本手册的离线副本在工程 ai/ 目录（hao2d-ai-playbook.md）；在线可从 MCP instructions / GET /commands 的 playbook 字段读到
