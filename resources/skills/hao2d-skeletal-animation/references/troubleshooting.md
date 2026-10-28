# 排错手册

原则：`ok:false` 时**读 `error` 原文**（写给 AI 看的人话，通常含「期望什么 + 用哪条查询命令核对」），
按提示修正后重试；**不要原样重发**。参数校验失败不写撤销栈、不标脏，可以放心试错。

## 1. 连接层

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/health` 连不上 | 编辑器没开；关闭时发现文件会被删除 | 让用户打开 Hao2DEditor，别自己造工程文件 |
| 401 / `ok:false` 且提示未授权 | token 不对或没带 | token 三种带法：`?token=`、`x-hao2d-token` 头、`Authorization: Bearer` |
| 地址连不上但编辑器开着 | 固定端口被占用后顺延 | 以 `command-server.json` / 工程 `ai/hao2d-ai-server.json` 里的 `url` 为准，别用记忆里的端口 |
| 找不到 `ai/hao2d-ai-server.json` | 工程从没在这个编辑器里保存过 | 回退用户目录 `command-server.json`；或让用户先保存一次工程 |

## 2. 状态与参数

| error 文案 | 处理 |
| --- | --- |
| `缺参数 X（…）` | 按 `/commands` 的定义补参数；不要猜（`bone` / `slot` / `attachment` / `time` 最常见） |
| `工程还没落盘：先 createProject {name, dir} 或 saveProject {path}…` | 先落盘。否则 `importImages` / `setStage` / `exportProject` 一律被拒 |
| `当前不在 Animate 状态：请先调用 setMode 切到 animate 再做动画编辑` | 先 `setMode {mode:'animate'}`。反过来，层级拖拽装配需要 `pose` |
| `场景未就绪：视口还没挂载好，稍后再试` | 等一拍重试，别改参数硬撞（依赖像素的命令都会这样：`autoWeightMesh`、`convertToOutlineMesh`、`autoMeshFromImage`、`getDisplayWorldBounds`） |
| `还没有动画：addAnimation {name, duration} 建一条后才能打帧` | 先建动画；`addAnimation` 默认会切成当前编辑动画 |
| `骨架里还没有骨骼：先用 addBone 建一根` | 空白工程的 `root` 有时被删了，重建一根再说 |
| `骨架里还没有骨骼，插槽必须挂在骨骼上` | 同上 |
| `没有可播放的动画：先用 addAnimation 建一条` | `setPlaying` 前要有动画 |

## 3. 装配

| error 文案 | 处理 |
| --- | --- |
| `图片不存在：X（用 listImages 查图片池）` | `listImages` 核对；名字来自文件名去扩展名，重名会加序号 |
| `插槽不存在：X（用 listSlots 查现有插槽名）` | 别用 `torso_slot` 这种想象名，先查 |
| `找不到附件：slot / attachment` | `listDisplays` 查该插槽的附件名 |
| `骨骼不存在：X` | `listBones` 核对；`addBone` 重名会自动加序号，用返回值里的 `name` |
| `附件引用的图片「X」不在图片池（先用 importImage 导入）` | 图集拆碎后旧引用会失效，重新 `importImage` 或 `splitAtlas` |
| `图片「X」还没解码完成，稍后再试` | 刚导入的大图，稍后重试 |
| 装配后画面乱飞 | 用了 `setSlotHost` 之外的路径换过宿主骨骼，或直接改了 `setBoneTransform` 的 `parent` 而附件是相对旧骨骼摆的；检查 `getDisplayWorldBounds` |
| 顺序不对 | `setDrawOrder {order:[…]}`，`order` 必须是**完整**插槽名序列，第 0 个最先画 |

## 4. 网格 / 蒙皮 / FFD

| error 文案 | 处理 |
| --- | --- |
| `附件「X」不是网格/遮罩，打不了 FFD（网格先用 convertToMesh…）` | 先 `autoMeshFromImage` 或 `convertToMesh` |
| `只能对 Region 附件（或带快照的网格）用…` | 附件已经是 Mesh/遮罩，先 `convertToRegion` |
| `offsets 长度必须是 顶点数 × 2` | 用 `getAttachmentVertices` 读 `vertexCount`；链接网格按**源网格**点数算 |
| `源附件「X」是 Y，链接网格的几何只能来自网格` | 先对源附件 `convertToMesh` |
| 权重全归到一根骨头 | 层级根骨骼不参与加权；检查骨架是否真有子骨，或调 `falloff` / `maxBones` / `method` |
| `vertices 里没有落在这个网格上的顶点下标` | `vertices` 下标来自 `getAttachmentVertices`，别自己编号 |
| FFD 帧切皮肤后串到别的附件 | 链接网格打帧要传 `skin` |
| 改点后 FFD 失效 | `setMaskPoints` / `redrawMeshBoundary` 会清掉旧 FFD 轨道；拓扑改完再打帧 |

## 5. 皮肤 / 嵌套 / 遮罩

| error 文案 | 处理 |
| --- | --- |
| 切皮肤后时间轴空了 | `setActiveSkin` / `setActiveSkeleton` 会清空选中与时间轴状态，切完先重查 `getProjectState` |
| `插槽「X」上没有嵌套骨架 display（先用 nestArmature…）` | 先 `nestArmature`，再用 `setNestedArmature` / `keySlotSubArmatureFrame` |
| 嵌套报自引用 / 循环 / 超深 | 不能把骨架挂到自己身上或形成环；考虑拆成两个骨架 |
| 遮罩范围不对 | `points` 是**插槽骨骼局部坐标**；裁的是顺序里遮罩之后、`endSlot` 之前的附件 |
| 遮罩多边形凹形状漏画 | `convex: false`（默认）；`inverse` 会自动把 `convex` 设为 true |

## 6. 导出

| 现象 | 处理 |
| --- | --- |
| `warnings` 非空 | 逐条复述给用户（常见：空插槽、缺图、动画时长为 0） |
| 只想导一个骨架 | `exportProject {skeletons:[index]}` + `atlasScope:'selected'` |
| 图集太大 | 调 `setExportScale` 或 `maxSize` |
| 导出目录不像预期 | `dir` 不传 = 工程文件所在目录；一律给绝对路径 |

## 7. 收工自检（四条）

```text
1. getProjectState        → dirty:false、projectPath 正确、skeletons 数量对
2. getAnimationKeys       → 每条动画的轨道 / 时间点符合预期
3. captureViewport        → 关键时刻的姿态截图给用户看
4. exportProject          → warnings 为空，把产出路径告诉用户
```

## 8. 常见返工原因（提前避开）

- **凭记忆写命令名**：先 `GET /commands`，或读本 skill 的 `commands.md`。
- **一条条发命令**：撤销栈只有 80 条，一次搭骨架走 `/batch` + `transaction`。
- **在外部算好坐标一口气灌**：编辑器里的实际几何才是准的，先放图再 `captureViewport` 比对。
- **忘记首尾同帧**：循环动画最后一帧要回到第 0 帧数值。
- **把「相对增量」当绝对角度**：`keyBoneFrame rotate` 写的是**绝对局部角度**，导入的 Spine 骨架基准不是 0。
