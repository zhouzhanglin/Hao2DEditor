/**
 * 「角色装配 + 动画」完整操作指南（随应用编译打包）。
 *
 * 为什么不直接让 AI 读 docs/ai-rigging-playbook.md：打包安装到用户机器后，
 * 开发仓库里的 docs/ 不在「工程里」，AI 的文件读取能力找不到它（extraResources
 * 里虽有副本，但 AI 未必有文件系统访问权）。这份常量编译进 bundle，通过只读
 * 命令 `getAiGuide` 下发 —— 装完 app 也能拿到，零文件依赖。
 *
 * docs/ai-rigging-playbook.md 仍是人读的权威版本：改流程时两边同步，内容保持一致。
 */
export const AI_RIGGING_GUIDE = `【角色装配 + 动画完整流程】做装配 / 动画任务前通读；配合命令目录使用。

## 总原则
- 三道报备门（骨骼清单表 / 网格部件清单 / 动画帧表）：先报备等确认，再动手
- 改动用 POST /batch {transaction:true}，失败整体回滚；做完每步按验收标准自查，关键节点 captureViewport 给人看
- 命令失败 ok=false 时按 error 提示修参数重试；打帧同一时间点重打 = 覆盖
- 坐标：世界 y 向上，PPU=100（1 世界单位 = 100px）；角度为度；时间为秒

## 阶段一：装配（Setup Pose）
1) getProjectState 摸底 → 没工程就 createProject {name, dir} → importImages {paths:[…]} → listImages
2) 出「骨骼清单表」（名字/父级/局部位置/骨长）报备 → batch addBone（先根后叶，localPosition/rotation 直接写成 pose 值，骨长用真实比例）
3) batch：addSlot {name, bone, zOrder}（后画的 zOrder 大）+ addDisplay {slot, image}（尺寸自动取图片池，不用算）
4) setBoneTransform / setDisplayTransform 摆 pose；getBoneWorldTransform 核对关键骨骼世界位置
5) captureViewport 截图给用户验收 → saveProject

### 参考图对位（用户给了装配示例图时）
- setStage {imagePath, opacity:0.5} 把示例图铺成视口底图（默认 1:1、图片中心在世界原点）；
  比例 / 位置对不上就用 updateStage {x, y, width, height} 调底图（不同源素材按缩放系数设 width/height）
- 像素→世界坐标：world_x = (px − W/2) / 100，world_y = (H/2 − py) / 100（W/H = 示例图像素尺寸，py 从图顶往下数）
- 部件一张一张放、对好一个再放下一个：addSlot + addDisplay（位置用量出的坐标）→ focusNode →
  captureViewport 与底图对比大小 / 位置 / 层级 → setDisplayTransform（大小/位置/旋转）和
  setDrawOrder（层级）修 → 再截，重合了才放下一个（每次只引入一个变量，偏差立刻定位）
- 全部对齐后 fitViewport + 整体截图复查 → removeStage 删底图（不参与导出，但留着会干扰后续截图）
- zOrder 从示例图的遮挡关系来（被压住的部件小），拿不准报备；AI 必须有视觉能力才能做本节

### 网格与蒙皮（只对要形变的部件：披风 / 尾巴 / 头发…）
- autoMeshFromImage（优先：按图片不透明轮廓贴合、省顶点）或 convertToMesh（规则栅格，divisions 弯曲方向要够密）
- 拓扑精修：getAttachmentVertices 读顶点（附件局部坐标 + 下标）→ insertMeshVertex（只能插在边上）/
  moveMeshVertex / deleteMeshVertex / redrawMeshBoundary / connectMeshVertices
- 蒙皮：autoWeightMesh {slot, attachment, bones?} —— 能指定 bones 就指定（披风只绑披风骨链，别蹭到腿骨）；
  验收 = 每顶点 weights 之和 ≈ 1、参与骨符合部件预期
- 微调权重：bindWeightBone / unbindWeightBone / setVertexWeight
- 三条硬规矩：① 拓扑先冻结再动画（变形帧引用顶点下标，装配完再改拓扑 = 变形帧全废）
  ② moveMeshVertex 是 Pose 态操作（Animate 态改形变用 keyDeformFrame）
  ③ 转网格 / 蒙皮依赖视口就绪，报「视口还没就绪」就稍后重试，不是参数错

## 阶段二：动画
1) 关键姿势表展开成帧表（骨骼 × 通道 × 时间 × 值；网格部件标变形关键点）报备 → addAnimation {name, duration}
2) 分批 batch：keyBoneFrame（rotate 传数字、translate/scale 传 {x,y}）→ 网格部件 keyDeformFrame
  （顶点下标来自 getAttachmentVertices，装配后改过拓扑必须重读）→ setKeyframeEasing → 需要时 keySlotColorFrame / keyEvent
3) 自查循环：setPlaying {playing:false} → setTime 逐关键姿势 getBoneWorldTransform 对照帧表 → 不符就同时间点重打
4) captureViewport 截几个关键时间点给用户确认节奏 → saveProject → exportProject {mode:'runtime'|'unity'|'spine', dir}`
