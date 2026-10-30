# 分阶段确认流水线（可跳步）

一句话需求换不来完美成品。把过程拆成 6 段、每段有明确交付物与自检，
**只在真正需要用户拍板的地方停**——已经做好的阶段直接跳过。

## 0. 入场体检（唯一不可跳过）

开工前必跑：

```
getProjectState
listBones
listSlots
listDisplays
listImages
listAnimations
```

输出一段入场报告（也是给用户的第一次确认材料）：

```
工程：hero（/Users/me/hao2d/hero）已保存
骨架：1 个（hero）｜骨骼 13｜插槽 11｜附件 11｜图片 6｜动画 0
判断：骨架与装配齐备 → 从 S5 动画开始（跳过 S2/S3/S4 与门禁 B/C）
```

铁则：**判断依据是查询结果，不是用户的描述**。用户说「图已放好、骨骼已绑好」→
仍要跑一遍体检确认（一次批量查询，几秒），然后**直接开始，不要重做**；
体检发现确实缺东西，再回头问。

## 1. 六个阶段

| 阶段 | 做什么 | 门禁 | 可跳过条件 |
| --- | --- | --- | --- |
| **S1 方案** | 复述需求 + 动作表（动作名/时长/帧数/循环/分解） | **Gate A：必须等** | 用户已给完整规格 → 只复述不追问 |
| **S2 素材** | 建/存工程、`importImages` / `importImage` / `splitAtlas` / `importSpine` | **Gate B：必须等** | `listImages` 齐全且用户已确认；或用户说「图不用管」 |
| **S3 骨架** | `addBone` 先根后叶 | **Gate C-1：必须等** | `listBones` 已有 >1 根且父子关系合理 |
| **S4 装配** | `addSlot` + `addDisplay` + 摆位 +（需要形变时）`autoMeshFromImage` + `autoWeightMesh` | **Gate C-2：必须等** | 每个骨骼都有插槽、附件与图片对得上、用户已确认画面 |
| **S5 动画** | 直接 `addAnimation` → 打关键帧 → 缓动 → 事件 → 自查 → 汇报 | **不停**（一次做完） | 不可跳过（这就是本阶段的活） |
| **S6 导出** | `saveProject`（可选 `exportProject`） | 不问：只在用户明确要求时导出 | 用户没提导出 → 只做 `saveProject` |

### 门禁怎么用

- **只有 S1~S4 停下来发消息**：说清当前状态、我的判断、下一步要做什么，请用户回复「可以」或指出要改的地方。
- **S5 动画不停**：不要出缩略图问「这样可以吗」，不要问「要不要继续」。打帧 → 补缓动 → 自查 → 汇报，一次做完。
- **S6 不问**：不要问「要不要导出 / 用哪个模式 / 输出到哪」。用户说了才导；没说就只 `saveProject`。
- **不要连续跨两个门禁**：能一次跳过的只有「已经被用户确认过 / 查询证明已完成」的阶段。
- 跳过阶段也要在汇报里写一句：`已跳过 S3/S4（检测到 13 根骨骼、11 个插槽均已装配）`，
  让用户知道我没偷懒、也没乱动他的东西。

### S1 方案确认要问清的东西

| 项 | 为什么要问 | 默认值（用户不答就用） |
| --- | --- | --- |
| 视角 / 朝向 | 决定骨架布局（正视图双臂展开 vs 侧视图单侧肢体） | 正视图、面朝观众 |
| 素材类型 | A 分层切图 / B 一张整图 / C 已有关键帧图 | 按 `listImages` 推断 |
| 动作清单 | 一次做几个动作，先做哪个 | 先做 idle |
| 时长与 fps | 打帧的时间点全靠它 | 30fps、idle 2s、walk 1s |
| 是否循环 | 决定首尾同帧 | 循环 |
| 导出目标 | runtime / unity / spine | **不导出**（用户明确要求时才导） |

输出格式：

```
方案：两足角色 · 正视图 · 分层切图 · 30fps
动作：idle 2s 循环（躯干呼吸 + 双臂轻摆）；walk 1s 循环（4 个关键姿态 ×2 镜像）
先做：idle → walk，中间不再逐步确认，做完一起汇报
确认这个方向就可以开始（或告诉我要改哪里）
```

### S5 直接打帧（不停）

用户明确要求过：不要出缩略图等确认，直接生成动画。所以这里**一次做完**：

```
listAnimations                       // 查重名，避免拿到 idle2
getAnimationKeys                     // 已有动画先读现状，别覆盖
addAnimation {name:'idle', duration:2}
keyBoneFrame ×N                      // 按关键姿态批量打（循环动画首尾同帧）
keySlot*Frame / keyDeformFrame / keyEvent   // 需要才打
setKeyframeEasing                    // 只给需要的帧调曲线
getAnimationKeys                     // 自查：轨道与时间点
```

自查怎么做（都**不要**发消息打断用户）：

- `getAnimationKeys` 文本核对就够：轨道数、时间点、首尾同帧；
- 想确认画面就自己 `captureViewport {time, animation}`（或 `scripts/shot.py --times 0,0.5,1` 落 PNG
  再 `read_file` 看一眼），看完自己判断、自己修。
  **裁图务必带 `time`**：窗口在后台时播放时钟不走，只 `setTime` 再截会一直拿到第 0 帧；
- 只有明显错位 / 穿模，且不确定用户要哪种效果时，才发一张图 + 一个具体问题；
- 帧率换算 `t = 帧号 / fps`（30fps 下 1 帧 ≈ 0.0333s）。

**为什么不需要先出图确认**：打帧的可修改成本很低——同一时间点重打即覆盖，`clearTrack` 能精确回退，
多一轮确认只会打断节奏。

### S6 收尾：不追问导出

动画做完就到此为止：`saveProject` → 汇报「做了什么 / 动了哪些轨道」。
**不要**问「要不要导出」「用 runtime / unity / spine 哪个模式」「输出到哪个目录」——
用户明确说了要导出，再调 `exportProject`。

## 2. 跳步判定表（体检结果 → 入口）

| 体检结果 | 结论 | 入口 |
| --- | --- | --- |
| `projectPath` 为空 / 没工程 | 从零开始 | S1 →（Gate A）→ S2 |
| 有工程，`listBones` 只有 `root` 或为空 | 没骨架 | 有素材则 S3，否则 S2 |
| 骨骼 > 1，`listSlots` 为空 | 只有骨架，没装配 | S4 |
| 插槽有、`listDisplays` 每槽都有件、`listAnimations` 为空 | 装配完成 | **S5**（最常见） |
| `listAnimations` 非空 | 已有动画 | **S5 增量模式** |
| 用户说「只改某条动画 / 只加一个动作」 | 增量 | 只跑体检 + S5 增量模式 |

## 3. 只做动画模式（增量，最常见）

用户在编辑器里已经摆好图、绑好骨，只差动画时用这套。**硬约束：**

1. **不动结构**：不 `addBone` / `addSlot` / `deleteBone` / `deleteSlot` / `setSlotHost` / `setDrawOrder` / `renameNode`。
2. **不动 setup pose**：不 `setBoneTransform` / `setDisplayTransform`。
   用户明确要求修姿势时，先给截图、确认后再改。
3. **不动图片池**：不 `importImages` / `replaceImage` / `splitAtlas`。
4. **不覆盖别人的动画**：`addAnimation` 前先 `listAnimations`（重名会自动加序号，用户会拿到 `walk2`）；
   要改已有动画就把 `animation` 参数填上，别新建。
5. **时间对齐 fps**：`t = 帧号 / fps`；30fps 下 1 帧 ≈ 0.0333s。先看 `getProjectState` 的帧率。
6. **循环动画首尾同帧**：最后一帧时间 = `duration`，数值等于第 0 帧。
7. **只打需要动的轨道**：别把每根骨骼的 4 条通道全打一遍，轨道越多越难维护、越难改。
8. **回退用 `clearTrack`**，不要 `undo`——undo 会撤掉上一笔（可能正是用户手调的结构）。
   整批 `batch` 里 `transaction: true` 失败会自动回滚，不用管。
9. **一次做完，不停**：打帧 → 缓动 → 事件 → `getAnimationKeys` 自查 → 汇报，中间不发确认消息、
   不问「这样可以吗」。要画面就自己截图看一眼，别发给用户等回复。

执行模板（一整批打完，中途不停）：

```json
{
  "transaction": true,
  "label": "idle 动画",
  "commands": [
    { "name": "addAnimation", "args": { "name": "idle", "duration": 2 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 0, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 1, "value": 1.5 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 2, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 0, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 1, "value": 3 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 2, "value": 0 } }
  ]
}
```

最终汇报：`idle 已完成（2s，2 根骨骼 6 条轨道，未改骨架、未动 setup pose）`。

## 4. 每阶段的自检命令

| 阶段 | 自检 |
| --- | --- |
| S2 | `listImages`（数量、像素尺寸、是否整页图集）→ `captureViewport` |
| S3 | `listBones`（父子关系、无零长度、无孤立骨）→ `captureViewport` 确认骨线落在关节 |
| S4 | `listDisplays`（每槽至少一件）→ `getDisplayWorldBounds`（位置不漂）→ `captureViewport` |
| 蒙皮 | `getAttachmentVertices`（`vertexCount` / `boundBones` 合理） |
| S5 | `getAnimationKeys`（轨道 / 时间点 / 缓动 / 首尾同帧）；需要画面时自己截图看一眼，不发给用户 |
| S6 | `getProjectState`（`dirty:false`）；用户要求导出时再看 `exportProject` 的 `warnings` |

## 5. 序列帧方案（C：用现成帧图直接出动画）

手上只有「几张关键姿态图 / 从视频抽出来的帧」时，不必硬做骨骼：

```
1. 帧图按 0,1,2… 命名导入：importImages {paths:[…]}
2. 一个插槽挂多张图：addDisplay 每张一次（同一 slot，name 用帧号）
3. addAnimation {name, duration: 帧数 / fps}
4. 逐帧切显示：keySlotDisplayFrame {slot, time: i/fps, attachment:'frame_03'}
5. 自检：getAnimationKeys 看 slots[].display；setTime 抽帧截图
```

代价与边界：
- 没有插值过渡，只能靠帧数堆平滑度（12fps 最好补到 24/30 帧图）；
- 包体随帧数线性增长，`exportProject` 的图集会变大；
- 这类动画**不能**再叠加骨骼摆动，导出到 Spine 是一串附件切换。

要「真骨骼动画」时，帧图只能当参考底图：`setStage` 铺图 → 摆骨架对齐 → `removeStage`。
**不要**承诺自动从帧图反推骨骼角度——命令集里没有姿态识别。

## 6. 什么时候该停下来问，而不是猜

- 素材缺件（少一条手臂、少一把武器）；
- 视角 / 朝向有歧义（正视图 vs 侧视图决定整个骨架布局）；
- 动作幅度与节奏没有参照 → 给 2~3 个候选时长让用户挑；
- 要做循环但首尾姿态接不上；
- 用户要求「跟这个视频 / 这张图一样」→ 只能当参考，不能自动复刻；
- 导出目标不明确（runtime / unity / spine）。

## 7. 汇报模板

S1~S4 的门禁（这些地方确实要等用户）：

```
已完成 <阶段>
做了什么：<命令级的改动摘要>
自检：<跑了哪些查询、结果如何>
需要你确认：<截图 / 下一步选项>
```

S5 动画（做完才汇报，中间不发消息）：

```
<动作名> 已完成（<时长>s，<N> 根骨骼 <M> 条轨道，未改骨架、未动 setup pose）
自检：getAnimationKeys 通过，首尾同帧（循环）/ 时长对齐 <fps>fps
```

要点：动画汇报**不要**带「要不要导出 / 用哪个模式 / 输出到哪」的提问；用户没提导出就到此为止。
