/**
 * 随命令目录自动下发给 AI 的「使用手册」。
 *
 * 背景：命令自描述（CommandSpec）只说清**每条命令怎么调**，但 AI 想把动画做对，
 * 还需要**跨命令的知识** —— 坐标 / 单位约定、先查后改的工作循环、从零到导出的
 * 步骤顺序、以及最容易踩的坑。这些以前只存在于 docs/ai-command-api.md 第 7 节，
 * 要靠人肉粘贴系统提示词；现在随三个入口自动下发：
 *
 * - `GET /commands` 响应里的 `playbook` 字段（经 `__catalog` 透传）
 * - MCP `initialize` 的 `instructions`（MCP 客户端会注入 AI 上下文）
 * - WS 握手消息的 `instructions`
 *
 * 保持纯字符串、零依赖（main 与 renderer 都能 import）；内容必须与实际命令签名一致，
 * 改命令参数时同步改这里。控制在 ~5KB：太长会稀释 AI 的注意力。
 */
export const AI_PLAYBOOK = `【Hao2DEditor 动画制作手册】随命令目录自动下发，照此执行可少走弯路。

## 坐标与单位（最先记住，错了全盘错）
- 世界坐标 y 轴向上；1 世界单位 = 100 像素（PPU=100），一张 512px 的图约 5.12 单位
- 角度单位是度；时间单位是秒，打帧给绝对时间点（不是相对偏移）
- 颜色 #RRGGBB，透明度 0-1；引用骨骼/插槽/附件/动画/皮肤一律用名字，不用下标

## 标准工作循环
1) 动手前先读状态：getProjectState 了解工程；listBones / listSlots / listImages / listAnimations / listSkins 核对名字，不要凭记忆猜
2) 一次搭多个东西走批量：POST /batch {"commands":[{"name","args"}...],"transaction":true,"label":"..."}（一次不超过 ~30 条；transaction 合并成一条撤销记录，失败整体回滚）
3) 做完就复核：getAnimationKeys 查打帧明细，getProjectState 复述文档状态；ok=false 时按 error 提示修正参数再试，不要原样重发

## 从零做一个动画（标准食谱）
1) 没有工程时 createProject {name, dir} 一步建好并落盘（不弹对话框，路径必须在参数里给全）
2) 素材进池：importImages {paths:[绝对路径...]}，或 importImage（base64/dataURL）；用 listImages 确认图片名
3) 搭骨骼：addBone {name, parent, localPosition:{x,y}, rotation, length} —— 先根后叶，length 给真实骨长（世界单位）；返回值里的 name 是最终名字（重名会加序号）
4) 建插槽并挂图：addSlot {name, bone, zOrder}（zOrder 越小越先画）→ addDisplay {slot, image}（附件尺寸自动取自图片池，不用自己算）
5) 要网格变形动画：convertToMesh 或 autoMeshFromImage 按轮廓生成网格 → autoWeightMesh 自动蒙皮 → getAttachmentVertices 读顶点下标（redrawMeshBoundary 重绘边界、connectMeshVertices 自定义布线都用它）
6) 建动画：addAnimation {name, duration}（duration 秒，默认 1，建好自动切为当前编辑动画）
7) 打帧（同一时间点重打即覆盖）：
   - 骨骼：keyBoneFrame {bone, channel, time, value}，channel 取 translate/rotate/scale/shear；rotate 的 value 是数字（度），其余是 {x,y}
   - 插槽：keySlotColorFrame / keySlotVisibleFrame / keySlotDisplayFrame {slot, time, attachment}（attachment 传空串 = 该帧起不显示）
8) 调缓动：setKeyframeEasing；事件帧：keyEvent {time, name?, stringParam?, intParam?, floatParam?}（name 不传自动取 event/event2…）
9) 复核 getAnimationKeys → saveProject → exportProject {mode:'runtime'|'unity'|'spine', dir}（导出也不弹对话框）

## 换装动画
addSkin {name} 建皮肤 → addDisplay {slot, image, skin} 往该皮肤放件 → keySlotDisplayFrame {slot, time, attachment, skin} 打显示帧完成切换；setActiveSkin 只影响编辑器当前预览

## 视口与检查
- focusNode {kind:'bone'|'slot'|'display'|'constraint', name} 把视口对准某节点；setTime / setPlaying 预览播放（播放只是编辑器内预览，交付物一律 exportProject 落盘）
- setStage {imagePath} 给视口铺背景参考图（需工程已保存；仅编辑器显示，不参与导出）

## 常见坑
- 所有文件类命令都不弹对话框：目录 / 路径必须在参数里给全；「场景未就绪」= 视口还没画完第一帧，稍后重试
- 撤销栈只有 80 条：大改动分批，不要把几十条命令拆成单发刷屏
- setActiveSkeleton / setActiveSkin 会清空选中与时间轴状态，切完先重新查状态
- 在线预览、画笔式刷权重是有意不开放的：预览给人看，权重用 autoWeightMesh
- 别猜命令名：先 GET /commands（或 __catalog 命令）拿目录，每条命令的参数说明都在里面
- 要做「角色装配 + 动画」：先调 getAiGuide 命令拿完整分阶段流程与验收标准（任务书 / 参考图对位公式 / 网格蒙皮 / 打帧自查）；docs/ai-rigging-playbook.md 是同内容的人读版，只有开发环境读得到
- 有装配参考图时：setStage {imagePath, opacity:0.5} 铺成视口底图 → updateStage 调好底图位置/大小 → 部件一张一张放上视口，截图与底图对比大小/位置/层级并修正 → 全部对齐后 removeStage 删底图`
