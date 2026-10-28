---
name: hao2d-skeletal-animation
version: 1.0.0
description: "Hao2DEditor 骨骼动画制作助手（通过编辑器本机命令服务 / MCP 驱动）。当用户要用 Hao2D 制作或修改 2D 骨骼动画时使用：新建工程与导入切图/图集、搭骨骼层级与插槽、装配附件、按轮廓生成网格与自动蒙皮、打关键帧（位移/旋转/缩放/斜切、附件切换、颜色、可见性、绘制顺序、FFD 变形、子骨架、事件帧）、皮肤换装与链接网格、骨架嵌套（换武器）、IK/变换/路径约束、遮罩裁剪、复核并导出 runtime / unity / Spine。支持分阶段确认与跳步（素材已导入 / 骨架已绑好、只差动画时直接进打帧）。触发词：Hao2D、hao2d-editor、骨骼动画、绑骨、蒙皮、打关键帧、K 帧、Spine 动画、角色动画、idle/walk/attack 动画、换装、图集导入、只补动画、增量修改已有骨架。"
agent_created: true
---

# Hao2D 骨骼动画制作

> **可能有两份**：这份 Skill 同时可能以「工程内副本」的形式存在于 `<工程>/ai/skills/hao2d-skeletal-animation/`。
> 只读你手上这一份就够，不要再去读另一份；两份版本不同时以客户端加载的（或随包安装的）为准。

## 这个 skill 解决什么

把「一句话的动画需求」变成 Hao2DEditor 里真正落地的骨架与动画：通过编辑器自带的**本机命令服务**
（HTTP / MCP）驱动，不手改工程文件、不猜命令名、不让用户去点菜单。

最终产出：`.hao2d.proj` 工程 + `exportProject` 导出的 runtime / unity / Spine 资源，
或对已有工程的增量修改。

## 第一步：连上编辑器

按顺序取连接方式，**优先靠前的**：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | **MCP** | 客户端已加载 Hao2DEditor 时，工具名就是命令名（`addBone` / `keyBoneFrame` …），直接 tools/call |
| 2 | 工程 `ai/hao2d-ai-server.json` | 含 `url` + `token`；编辑器保存 / 打开工程时写出，是当前最可靠的一份 |
| 3 | 用户目录 `command-server.json` | macOS `~/Library/Application Support/hao2d-editor/`、Windows `%APPDATA%\hao2d-editor\`、Linux `~/.config/hao2d-editor/` |

拿到 `url` + `token` 后用**自己的 HTTP 请求能力**（fetch / requests）访问：

- `GET {url}/health` 探活
- `POST {url}/command` 单条：`{"name":"addBone","args":{…}}`
- `POST {url}/batch` 批量：`{"commands":[…],"transaction":true,"label":"…"}`
- token 三种带法都认：`?token=…`、`x-hao2d-token` 头、`Authorization: Bearer …`

**不要经 shell 拼 curl**（编辑器明确禁止这条路径）。只有当前环境完全没有 HTTP 能力时，
才用本 skill 的 `scripts/hao2d.py`（它等价于封装同样的请求，见文末）。

探活失败 = 编辑器没开（关闭时发现文件会被删除）。先让用户打开 Hao2DEditor，不要自己造工程文件。

## 铁律（先记住这几条，能省一半返工）

1. **动画一步做完，不要中途停下来等确认**：不要生成缩略图问「这样可以吗」，也不要问
   「要不要继续」。打帧 → 补缓动 → 自查 → 汇报，一次做完。只有**真的做不下去**时（素材缺件、
   视角歧义、骨骼/插槽名字对不上）才停下来问。
2. **坐标与单位**：世界坐标 y 轴**向上**；1 世界单位 = 100 像素（PPU=100），512px 的图约 5.12 单位；
   角度是**度**；时间是**秒**，打帧给**绝对时间点**；颜色 `#RRGGBB`，透明度 0–1。
3. **一律用名字引用**骨骼 / 插槽 / 附件 / 动画 / 皮肤，不用下标。`addBone` / `addSlot` / `addDisplay`
   的返回值里的 `name` 才是**最终名字**（重名会自动加序号），后续命令必须用返回值里的名字。
4. **先查后写**：动手前 `getProjectState` + 对应的 `list*` 核对现状；不要凭记忆假设骨骼叫 `root`、图片叫 `body.png`。
5. **批量 + 事务**：一次搭多个节点走 `POST /batch` 且 `transaction: true`（整批合成一条撤销记录，失败整体回滚）。
   一批不超过约 30 条；撤销栈只有 80 条，别把几十条拆成单发。
6. **写完就复核**：`getAnimationKeys` 查打帧明细，`getProjectState` / `list*` 复述落盘状态。
   `ok:false` 时读 `error` 改参数再试，**不要原样重发**。
7. **文件类命令都不弹对话框**，目录 / 路径必须在参数里给全（绝对路径）。

## 自检（不要打断用户）

- 打帧后用 `getAnimationKeys` 核对轨道与时间点——**文本就够，不用截图**；
- 想确认画面时自己 `setTime` + `captureViewport`（或 `scripts/shot.py` 落 PNG 再 `read_file` 看一眼），
  **不要**把图发给用户等确认，也不要因为这个暂停；自己判断、自己修；
- 只有看到明显错位 / 穿模，且不确定用户要哪种效果时，才发一张图并提一个具体问题；
- 导出同理：动画做完就汇报结束，**不要问「要不要导出」**；用户明确说要导出再 `exportProject`。

## 标准流水线（命令级）

```
0. 探活 → getProjectState（看 projectPath / skeletons[] / next）
1. 建工程  createProject {name, dir}                        （已落盘工程则跳过）
2. 素材    importImages {paths} | importImage {path|data} | importSpine | importDragonBones | splitAtlas
3. 搭骨架  addBone ×N（先根后叶，length 给真实骨长）
4. 装配    addSlot {name, bone, zOrder} → addDisplay {slot, image}
5. 蒙皮    autoMeshFromImage → autoWeightMesh（需要形变才做，纯刚体可以跳过）
6. 打帧    addAnimation {name, duration} → keyBoneFrame / keySlot*Frame / keyDeformFrame / keyEvent
7. 调曲线  setKeyframeEasing
8. 复核    getAnimationKeys 核对轨道与时间点（要画面自己 captureViewport 看一眼）→ saveProject
9. 收尾    汇报「做了什么 + 动了哪些轨道」；**不要问要不要导出**，用户明确要求时才 exportProject
```

`getProjectState` 返回的 `next` 字段是编辑器**状态感知**的下一步建议，优先照它走。

## 分阶段确认流水线（可跳步）

一句话需求 ≠ 一次做完。按 6 段推进，**每段先体检、再动手**；只有 S1~S4 需要停下确认，
**动画这一段一次做完**：

| 阶段 | 交付物 | 门禁 |
| --- | --- | --- |
| S1 方案 | 复述需求 + 动作表（动作 / 时长 / 帧数 / 是否循环） | 停下等用户确认 |
| S2 素材 | 工程落盘、图片入库、图集拆分 | 停下等用户确认 |
| S3 骨架 | `addBone` 先根后叶 | 停下等用户确认 |
| S4 装配 | `addSlot` + `addDisplay` + 摆位（+ 需要形变时蒙皮） | 停下等用户确认 |
| S5 动画 | 直接打帧 + 缓动 + 事件帧 | **不停**：打完自查后汇报 |
| S6 导出 | `exportProject` | 只在用户明确要求时做 |

**开工先体检，按结果决定从哪进**：`getProjectState` + `listBones / listSlots / listDisplays / listImages / listAnimations`。
已经做完的阶段直接跳过，并在汇报里写明跳过了哪几段及依据，例如
「检测到 13 根骨骼、11 个插槽均已装配 → 跳过 S3/S4，直接 S5」。
**用户口头说「图放好了 / 骨骼绑好了」也要用查询确认一次**，确认无误就直接开始，不要重做他的工作。

最常见跳步：用户已摆好图、绑好骨、只差动画 → 只跑体检 + **只做动画模式**：
不新建 / 重命名 / 删除骨骼与插槽，不动 setup pose，不动图片池；
`addAnimation` 前先 `listAnimations` 查重名；回退用 `clearTrack` 而不是 `undo`。

每个门禁问什么、跳步判定表、只做动画的硬约束、序列帧方案、汇报模板：`references/pipeline.md`。

## 按需加载的参考文件

| 场景 | 读这个 |
| --- | --- |
| 要查某条命令的准确参数 / 返回值 | `references/commands.md`（由命令注册表生成，与 `GET /commands` 同源） |
| 分阶段推进、跳步、只做动画、需要向用户确认 | `references/pipeline.md` |
| 要从零做角色、循环动画、蒙皮、换装、嵌套、遮罩、导出 | `references/recipes.md` |
| `ok:false`、画面不对、打帧没生效 | `references/troubleshooting.md` |

原则：**先查 `references/commands.md` 再写命令**，别凭中文标题猜英文参数名。

## 分工边界（重要）

- 编辑器不开放**在线预览**和**画笔式刷权重**。要给人看效果就 `exportProject` 落盘，让用户打开看；
  权重用 `autoWeightMesh`，微调用 `setVertexWeight`。
- 参考图对位要用 `setStage` + `captureViewport` 逐步比对，**不要**在外部算好一堆坐标一口气灌进去。
- 有装配参考图时按 `references/recipes.md` 的「贴图对位」流程走：铺底图 → 标定尺寸 → 一张张放 →
  **停下等用户确认** → 再 `setSlotHost` 绑骨 → `removeStage`。
- 不改用户的工程文件（`.hao2d.proj` / `ai/` 目录）——所有改动都通过命令服务。

## 脚本

`scripts/shot.py`：**把视口截成 PNG**（自查用；只在用户要图、或自己看不准时用，别拿它当流程关卡）。

```bash
python3 scripts/shot.py --out <工程目录>/preview/setup.png
python3 scripts/shot.py --animation idle --times 0,0.5,1 --out <工程目录>/preview/idle.png
```

`scripts/hao2d.py`：仅当没有 MCP、也没有 HTTP 工具时使用。

```bash
python3 scripts/hao2d.py health
python3 scripts/hao2d.py catalog --grep bone      # 查命令目录
python3 scripts/hao2d.py state                    # getProjectState 简表
python3 scripts/hao2d.py call addBone '{"name":"chest","parent":"root"}'
python3 scripts/hao2d.py batch build.json --label 搭骨架   # 文件内是 {"commands":[…]} 或裸数组
```

两个脚本都按「`--url/--token` → 工程 `ai/` → 用户目录」的顺序自己找连接信息。
