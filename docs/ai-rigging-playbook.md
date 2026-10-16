# AI 装配与动画制作手册（任务书模板）

> 面向「指导 AI 用命令接口完成角色装配（setup pose）与动画制作」的操作手册。
> 命令签名与通信方式见 [ai-command-api.md](./ai-command-api.md)；本文只讲**流程与验收**。
>
> 核心思路一句话：**别让 AI 自由发挥，把工作拆成阶段、每阶段给数字化验收标准、
> 用真实命令名点名要它做什么**。编辑器侧（playbook / `example` / `next` 提示）
> 已经兜住「怎么调命令」，人要负责的是「做什么、做成什么样算对」。
>
> **打包安装的 app**：AI 通过 `getAiGuide` 命令获取同等内容的指南（编译进包里，
> 零文件依赖）。本文件已随包打进资源目录作人读副本，但 AI 不一定有文件读取能力
> ——`getAiGuide` 是打包环境唯一保证可达的通道；改流程时与 `src/shared/aiRiggingGuide.ts` 同步。

## 1. 任务书模板（人填好交给 AI）

AI 失败的根因九成是输入不足。开工前把这张单子填给它：

```text
【角色装配 + 动画任务书】

1. 素材：目录 {{/path/to/art}}，部件清单：
   - body.png → 躯干
   - head.png → 头
   - cape.png → 披风
   （没有清单就让 AI 先 importImages + listImages，再问你每个图是什么部位）

1.5 装配参考图：{{/path/to/art/ref.png}}，与部件**同源同分辨率**（1:1）；
   脚底在像素行 {{640}}、角色中线在像素列 {{320}}（没有就写「让 AI 自己找并报备」）
   （AI 按 2.0 节：铺底图 → 调好底图位置/大小 → 部件一张一张放上视口对比大小/位置/层级
   → 全部对齐后 removeStage 删掉底图）

2. 骨骼结构意图：root → hip → torso → head；
   hip → leg_l / leg_r；torso → arm_l / arm_r；torso → cape_bone（披风链）
   （不确定就让 AI 先出一份「骨骼清单表」给你确认，再动手建）

3. Pose 要求：自然站姿，双臂微垂，头摆正；两脚踩在世界原点地面线上（y=0）

4. 网格部件：cape.png（要随披风骨链弯曲摆动）；其余保持普通图片
   （不确定就让 AI 挑完报备，原则：会弯、会摆、会呼吸的才转网格）

5. 动画需求（关键姿势表，越具体越好）：
   - idle，时长 2s，循环
   - t=0.0 站立基准；t=1.0 躯干上移 0.05 + 头微低 + 披风尾部跟随摆动；t=2.0 回到基准
   （「自然一点」这种词 AI 只能猜，给得出角度/位移就给）

6. 交付：saveProject 后 exportProject mode=spine 到 {{/path/to/export}}

7. 规矩：每个阶段结束先给阶段汇报（建了什么、截图）再继续；
   任何阶段不符合验收标准就停下问人，不许带着错误往下走
```

## 2. 装配阶段（Setup Pose）

**关键认知一**：setup pose 不是动画，就是 `addBone` / `setBoneTransform` /
`setDisplayTransform` 写下的静态变换值。建骨时把 pose 一次性写对，后面通常只需微调。

**关键认知二**：需要形变的部件（披风、尾巴、头发、会呼吸的躯干…）在装配阶段
还要**转网格 → 修拓扑 → 绑骨骼 → 调权重**（见 2.2）。这一步必须在打帧之前完成——
动画阶段的变形帧引用顶点下标，装配结束后拓扑就冻结了。

**关键认知三（有装配参考图时）**：编辑器能把参考图铺进视口当底图、也能把「参考图 +
已建角色」截进同一张图。利用三个渲染事实，AI 可以**零测量**对位：

1. `setStage` 默认把参考图按**原图像素 / 100**（PPU=100）铺开、图片**中心**在世界原点；
2. 附件以**图片中心**为原点挂在骨骼上——素材与参考图同源时，把骨骼摆到量出的坐标，
   部件就与参考图像素级对齐；
3. `captureViewport` 截图**含参考图图层**——参考图半透明垫底 + 已建角色，一张图完成叠影对比。

### 2.0 参考图对位（有装配参考图时，强烈建议）

像素 → 世界坐标换算（AI 量参考图用，W/H 为参考图像素尺寸，py 从图**顶**往下数）：

```text
world_x = (px − W/2) / 100        world_y = (H/2 − py) / 100
```

| 步骤 | AI 执行 | 验收标准（人检查） |
| --- | --- | --- |
| R1 读图产出「装配情报表」 | 用视觉读参考图，逐部件列出：中心像素位置 → 按公式换算世界坐标、旋转角、**遮挡层级**（谁压着谁 → zOrder）、关节位置与**弯曲方向**（四肢弯曲朝向决定骨骼 rotation 正负与骨长）；同时勾对手头素材——参考图里可见但素材缺的部件，停下问人 | 情报表**报备确认**后再动手；头身比 / 部件位置与参考图肉眼一致 |
| R2 铺底图并调好 | `setStage {imagePath, opacity: 0.5}`（默认 1:1、图片中心在世界原点）→ `captureViewport` 检查：底图与部件比例 / 位置对不上时，用 `updateStage {x, y, width, height}` 把底图的**位置和大小**调到与部件坐标系一致（不同源素材按缩放系数设 `width`/`height`） | 底图铺稳：`captureViewport` 里参考图的位置、比例与预期一致，半透明不挡部件 |
| R3 逐部件对位 | **一张一张放、对好一个再放下一个**（2.1 步骤 4–5 在有底图时改为逐部件进行）：`addSlot` + `addDisplay` 挂上一个部件（位置用 R1 量出的坐标）→ `focusNode` 聚焦 → `captureViewport` 与底图对比**大小 / 位置 / 层级** → 不对就 `setDisplayTransform`（大小 / 位置 / 旋转）和 `setDrawOrder`（层级）修 → 再截，重合了才放下一个 | 每个部件与底图重合（同源素材应像素级）；层级与参考图遮挡关系一致 |
| R4 整体复查 | 全部部件放完后 `fitViewport` + 整体 `captureViewport` 看一遍；大图可裁剪局部放大对比 | 无部件错位、穿插、层级颠倒；用户确认后进 2.2 |
| R5 删底图 | 都对好以后 `removeStage` 把底图从编辑器中删掉（底图不参与导出，但留着会一直出现在截图里干扰后续验收） | `captureViewport` 里不再有底图；`exportProject` 的产物本就不含它 |

参考图相关的实操要点（写给 AI / 写进任务书）：

- **同源素材是「零测量」的前提**：部件从参考图（或同一张原画）切出、分辨率一致。
  若素材与参考图不同源，任务书里必须给**缩放系数**（参考图是部件成品的几倍），
  AI 在 R2 用 `updateStage` 把底图放大 / 缩小到一致，再开始逐部件对位。
- **为什么一张一张放**：每次只引入一个新部件，截图里发现的偏差立刻定位到当前部件；
  一次全铺开再找错，偏差来源互相纠缠，返工指数上升。
- **标定锚点**：任务书里给出「脚底在参考图像素行 {{Y}}」「角色中线在像素列 {{X}}」，
  AI 据此校准公式；没给就让它自己找、报备确认后再用。
- **zOrder 从遮挡关系来**：参考图里被压住的部件 zOrder 小。拿不准就报备，别默认全 0。
- **AI 必须有视觉能力**：R1 / R4 都靠看图。无视觉的模型只能靠人标坐标 + 人验收，
  效率骤降——直接换带视觉的模型。
- `captureViewport` 失败重试即可（渲染器没就绪 / 上下文丢失），见命令自描述。

### 2.1 基础装配（步骤 0–6，全部部件）

| 步骤 | AI 执行 | 验收标准（人检查） |
| --- | --- | --- |
| 0 环境发现 | 连 MCP 或读 `command-server.json`；`getProjectState` | 返回的 `next` 里没有「工程未落盘」类警告 |
| 1 建工程导图 | `createProject {name, dir}` → `importImages {paths:[…]}` → `listImages` | 图片名 / 尺寸与素材对得上 |
| 2 骨架规划 | 产出**骨骼清单表**（名字 / 父级 / 局部位置 / 骨长）**报备确认**；需要形变的部件要有对应的骨骼链 | 层级与意图一致；骨长用真实比例（世界单位，PPU=100） |
| 3 建骨 | `POST /batch` + `transaction:true`，一批 `addBone`（**先根后叶**，`localPosition` / `rotation` 直接写成 pose 值） | `listBones` 逐条核对数量、父子关系、变换值 |
| 4 挂图 | 同一 batch：`addSlot {name, bone, zOrder}`（后画的 zOrder 大）→ `addDisplay {slot, image}` | `listDisplays` 每个插槽挂着对的图；**不用算尺寸**（自动取图片池） |
| 5 摆 pose | `setBoneTransform`（骨骼级）+ `setDisplayTransform`（图在骨骼局部空间的微调）；`getBoneWorldTransform` 核对关键骨骼世界位置 | 双脚在 y=0、结构无穿插 |
| 6 视觉验收 | `captureViewport` 截图给用户看（AI 有视觉能力也可自查） | 用户说「过了」才进下一阶段 |

### 2.2 网格与蒙皮（步骤 7–11，只对需要形变的部件）

前置：这些操作都在 **Pose 态**做（`setMode` 可查可切）。Animate 态下改顶点属于
「变形动画」，走 `keyDeformFrame`，不是这里的事。

| 步骤 | AI 执行 | 验收标准（人检查） |
| --- | --- | --- |
| 7 挑部件转网格 | 按任务书挑出要形变的部件并报备 → `autoMeshFromImage`（**优先**：按图片不透明像素轮廓自动贴合，透明区不占三角形、省顶点）或 `convertToMesh`（规则栅格，`divisions` 控制密度，弯曲方向要够密） | `listDisplays` 确认 `type` 已是 mesh；静态部件保持 Region（省运行时开销） |
| 8 拓扑精修（可选） | `getAttachmentVertices` 读顶点（**附件局部坐标 + 下标**，后面一切顶点操作都用它）→ `insertMeshVertex`（只能插在边上）/ `moveMeshVertex` / `deleteMeshVertex` / `redrawMeshBoundary`（按点重绘外边界）/ `connectMeshVertices`（两顶点间自定义布线） | 顶点落在轮廓转折与弯曲轴上；弯曲方向有足够的顶点排数，不然弯起来是硬折角 |
| 9 自动蒙皮 | `autoWeightMesh {slot, attachment, bones?}`：按「顶点离哪根骨骼近」分权重（AI 蒙皮主力）。`bones` 不传 = 除层级根外全部参与；**能指定就指定**（披风只绑披风骨链，避免权重蹭到腿骨） | `getAttachmentVertices`：每个顶点 `weights` 之和 ≈ 1；参与骨骼与部件预期一致 |
| 10 手工微调权重（可选） | `bindWeightBone`（把骨骼加入某顶点）/ `unbindWeightBone` / `setVertexWeight` 精修关节过渡区 | 关节两侧骨骼都有权重；`captureViewport` 里弯一弯没有硬折角、不撕裂 |
| 11 存档 | `saveProject` | `getProjectState` 的 `dirty: false` |

给 AI 的三条硬规矩（建议原样写进任务书）：

1. **拓扑先冻结再动画**：转网格 / 加点 / 蒙皮全部在装配阶段完成；动画阶段只用
   `getAttachmentVertices` 读下标打 `keyDeformFrame`。装配完再改拓扑，下标漂移，变形帧全废。
2. **`moveMeshVertex` 是 Pose 态操作**：改的是绑定网格；内部顶点 UV 自动重算，
   边界顶点只挪位置不动 UV。
3. **需要视口就绪**：`autoMeshFromImage` 要图片像素已解码、`autoWeightMesh` /
   `redrawMeshBoundary` 要场景已挂载——报「视口还没就绪」就稍后重试，不是参数错。

## 3. 动画阶段

| 步骤 | AI 执行 | 验收标准 |
| --- | --- | --- |
| 12 规划 | 把关键姿势表展开成**帧表**（骨骼 × 通道 × 时间 × 值；网格部件标注变形关键点），报备确认 | 每根骨骼每条通道起止帧齐；循环动画首尾帧相同 |
| 13 建动画 | `addAnimation {name, duration}` | `listAnimations` 里有它且是当前编辑动画 |
| 14 打帧 | 分批 `POST /batch`：`keyBoneFrame`（rotate 传数字、translate/scale 传 `{x,y}`）→ 网格部件用 `keyDeformFrame`（顶点下标来自 `getAttachmentVertices`，**若装配后改过拓扑必须重读**）→ `setKeyframeEasing` → 需要时 `keySlotColorFrame` / `keyEvent` | `getAnimationKeys` 逐条核对时间点、值、缓动 |
| 15 自查循环 | `setPlaying {playing:false}` → `setTime` 逐关键姿势 `getBoneWorldTransform` 对照帧表 → 不符就同时间点重打（重打即覆盖） | 每个关键姿势的世界变换与帧表一致 |
| 16 视觉验收 | `captureViewport` 截几个关键时间点的图 | 用户确认节奏与幅度 |
| 17 交付 | `saveProject` → `exportProject {mode, dir}` | 返回 `files` 清单已落盘 |

## 4. 为什么这样拆就能做对

1. **两道报备门**（骨骼清单表、帧表；网格部件清单算第三道）：AI 最大的翻车点是理解偏差，报备把偏差拦在动手前——改一张表比撤销 80 条历史便宜得多。
2. **数据验收 + 视觉验收双保险**：`listBones` / `getAttachmentVertices` / `getAnimationKeys` 是 AI 可自查的硬标准；`captureViewport` 把「看起来对不对」交回给人——这是 AI 替代不了人的一环。
3. **批量 + 事务**：阶段内 `POST /batch {transaction:true}`，失败整体回滚、撤销栈只记一条，AI 试错不再污染工程。
4. **同点覆盖打帧**：`keyBoneFrame` 同一时间点重打即覆盖，改姿势不需要先删帧，配合 `getAnimationKeys` 复核形成闭环。
5. **拓扑先冻结**：网格顶点下标是变形帧的引用依据，装配阶段（2.2）定稿拓扑与权重、动画阶段只打帧——顺序反了下标漂移，返工成本最高。
6. **错误自纠**：命令失败时 `ok:false` + 人话 `error`（含参数纠正提示）；查询返回带 `next`（下一步建议）。AI 照提示修参数重试即可，不应原样重发。
