# AI 命令接口（本地 HTTP / WebSocket）

给 AI 工具（codex / workbuddy / 脚本）用的命令通道：**编辑器自己起一个只监听本机的服务**，AI 发 JSON 就能读写当前打开的工程 —— 不做 CLI，不需要在编辑器里点任何东西。

- 服务在**主进程**：`127.0.0.1` 固定端口 + 持久化 token（不暴露局域网）；**地址跨重启保持不变**，AI 客户端配置填一次即可长期复用
- 命令在**渲染进程执行**：文档状态只在那里；主进程只负责转发，不碰工程数据
- 返回结构化结果：`{ ok, changed, data, message, error, label }`，参数写错也用同一形状回话，AI 可以照着 `error` 自纠后重试

## 1. 发现服务

编辑器启动时把地址与 token 写进 **userData 目录下的 `command-server.json`**，同时打进启动日志（搜索「命令服务已启动」）。

> 地址是**稳定的**：端口固定（默认 `37241`，被占用时顺延，极端情况才回退随机），
> token 首次生成后持久保存在同目录的 `command-server-token.txt`。所以每次重启编辑器，
> 地址与 token 都不变 —— AI 客户端里填过一次就不用再改。

文件位置（按平台）：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/hao2d-editor/command-server.json` |
| Windows | `%APPDATA%\hao2d-editor\command-server.json` |
| Linux | `~/.config/hao2d-editor/command-server.json` |

内容：

```json
{
  "port": 37241,
  "token": "8Yk…（首次生成后持久保存，重启不变）",
  "url": "http://127.0.0.1:37241",
  "file": "/Users/you/Library/Application Support/hao2d-editor/command-server.json",
  "instructions": "与 Hao2DEditor 通信请勿经 shell 执行 curl 拼命令：…（通信指引，见 8.4）"
}
```

拿 `url` + `token` 就能开干。token 三种带法都认：`?token=…`、`x-hao2d-token` 头、`Authorization: Bearer …`。
`instructions` 是给 AI 的通信指引（同 8.4），读文件时就一并拿到。

## 2. 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 探活：`{ ok, service, port, url }` |
| GET | `/commands` | **全部命令的自描述**（名字、标题、参数、返回值）——先读它再动手；易错命令带 `example`（可直接照抄的 args JSON），查询命令的返回里带 `next`（状态感知的下一步建议） |
| POST | `/command` | 执行一条命令：`{ "name": "addBone", "args": { … } }` |
| POST | `/batch` | 批量：`{ "commands": [ … ], "transaction": true }` |
| WS | `/ws` | 长连接版；消息 `{ id?, name, args }` 或 `{ id?, batch: [...], transaction? }`。连上先收到一条 `{ id: null, hello: "hao2d-command", instructions }` 握手消息（就是 8.4 的通信指引） |

> **下面代码块里的 `curl` 只是本文档的演示工具，不是必须的调用方式。**
> AI 工具请走 MCP（第 8 节）或用自己的 HTTP 请求能力（fetch / requests 等），
> **不要经 shell 拼 curl**；curl 只留给人工调试。这条指引会随各入口主动交给 AI：
> `GET /commands` 响应顶层、MCP `initialize`、WS 握手消息、以及两份发现文件
> （工程 `ai/` 目录 `hao2d-ai-server.json`、userData `command-server.json`）都带 `instructions`（见 8.4）。

```bash
BASE=http://127.0.0.1:37241
TOKEN=8Yk…

# 能连上吗
curl -s "$BASE/health?token=$TOKEN"

# 有哪些命令（AI 的「说明书」）
curl -s "$BASE/commands?token=$TOKEN"

# 看当前工程状态
curl -s -X POST "$BASE/command" -H "content-type: application/json" -H "x-hao2d-token: $TOKEN" \
  -d '{"name":"getProjectState"}'

# 新建一根骨骼
curl -s -X POST "$BASE/command" -H "content-type: application/json" -H "x-hao2d-token: $TOKEN" \
  -d '{"name":"addBone","args":{"name":"arm","parent":"root","localPosition":{"x":1,"y":0}}}'
```

## 3. 结果约定

每条命令都回同一个形状（HTTP 一律 200，成败看 `ok`）：

```json
{ "ok": true,  "changed": true,  "data": { … }, "message": "已新建骨骼 arm（父级：root）", "label": "新建骨骼" }
{ "ok": false, "changed": false, "error": "缺参数 bone（骨骼名）。用 listBones 查现有骨骼名" }
```

- `changed`：这次是否真的改了文档。`false` 表示无副作用（**不会**占用撤销记录）
- `error`：写给 AI 读的人话，通常包含「期望什么 + 用哪条查询命令核对」
- **参数校验失败的调用不写撤销栈、不标脏**，可以放心试错

## 4. 批量与事务

```json
POST /batch
{
  "transaction": true,
  "label": "搭建手臂",
  "commands": [
    { "name": "addBone", "args": { "name": "upper_arm", "parent": "root" } },
    { "name": "addBone", "args": { "name": "forearm", "parent": "upper_arm" } },
    { "name": "addSlot", "args": { "name": "hand_slot", "bone": "forearm", "attachment": "hand" } }
  ]
}
```

- 顺序执行，后面的命令能看到前面的结果
- `transaction: true`：整批合并成**一条撤销记录**；任一条失败 → 整体回滚（不留半套状态、不留记录）
- 整批都没产生改动时同样回滚，不会留空记录
- 撤销栈只有 80 条，一次搭骨架请走批量，别一条条发

## 5. 建议的工作流

1. `GET /commands` 读一遍命令目录（含每条命令的参数说明）
2. `getProjectState` / `listBones` / `listSlots` / `listAnimations` 摸清现状；要看**整个层级结构**用 `getHierarchy`、看**视口与画面**用 `getViewport` / `captureViewport`、看**素材清单**用 `listImages`
3. 用**名字**引用对象（`parent: "root"`、`bone: "forearm"`）——命令和查询都用名字，不用下标
4. 改动走 `POST /command` 或 `POST /batch`
5. 需要 AI 生成的东西：
   - 外部素材入库：`importImage`（外部图片 base64/dataURL 或本地绝对路径 → 写进工程 `images/` 并登记到图片池）、`splitAtlas`（整页图集拆成碎图）；之后用 `addDisplay` 把图片做成附件
   - 骨骼/插槽/约束 → `addBone` `addSlot` `addConstraint`，附件装配 → `addDisplay`
   - 关键帧 → `keyBoneFrame` `keySlotDisplayFrame` `keyDeformFrame`（网格变形帧）…（时间单位是**秒**）
   - 生成网格：**优先** `autoMeshFromImage`（按图片不透明轮廓自动贴合，省顶点）；规则栅格用 `convertToMesh`；蒙皮 → `autoWeightMesh`（按顶点到骨骼距离自动分权重，AI 蒙皮主力）；手工微调 → `setVertexWeight` `bindWeightBone`
   - 网格拓扑编辑 → `redrawMeshBoundary`（按点重绘外边界）/ `connectMeshVertices`（两顶点间自定义布线），坐标用附件局部坐标、顶点用 `getAttachmentVertices` 读到的下标
   - 遮罩（Spine ClippingAttachment）→ `createMask`（新建，points 用**插槽骨骼局部坐标**）/ `convertToMask`（Region / 非加权 Mesh 转遮罩）/ `setMaskPoints` `setMaskPoint` `insertMaskPoint` `deleteMaskPoint`（改控制点）/ `setMaskOptions`（结束插槽、反向、凸形、是否显示）；查询用 `getMask` / `listMasks`。遮罩也能用 `keyDeformFrame` 做 FFD（offsets 长度 = 点数 × 2）
   - 工程文件：`newProject`（空白工程）/ `createProject`（具名并立刻落盘）/ `openProject` / `saveProject` —— **都不弹原生对话框**，保存位置靠参数 `dir` / `path` 显式给出
   - 多骨架：`addSkeleton` / `removeSkeleton` / `renameSkeleton` / `setActiveSkeleton`（图片池跨骨架共享）
   - 骨架嵌套：`nestArmature`（把工程内另一个骨架挂到插槽上）/ `setNestedArmature`（改引用与默认播放参数）/ `keySlotSubArmatureFrame`（在动画里控制子骨架播哪个动画）；`listDisplays` 的 `nested` 字段、`getAnimationKeys` 的 `subArmature` 通道用于核对
   - 皮肤：`addSkin` / `renameSkin` / `removeSkin` / `setActiveSkin`（换装动画配合 `keySlotDisplayFrame`）
   - 换装链接网格（一套几何 + 多套皮肤换贴图）→ `createLinkedMesh {slot, source, sourceSkin?, skin?, name?, image?}`：几何 / 权重取自同插槽的源网格，自己只决定贴图与 UV；附件名与源同名 = 覆盖该插槽的显示，异名 = 追加 display。`setLinkedMeshSource`（改源）/ `setLinkedMeshImage`（只改这一条的图并重算 UV）/ `unlinkLinkedMesh`（复制几何成独立网格）。`keyDeformFrame` 对链接网格按**源网格点数**校验 offsets，可用 `skin` 指定附件所在皮肤
   - 播放与事件帧：`setTime`（播放头）、`setPlaying`（播放 / 暂停）、`keyEvent` / `setEvent` / `removeEvent`（时间轴最上面的事件轨）
   - 导出：`exportProject`（`mode` = `runtime` / `unity` / `spine`，写盘到 `dir`，**不弹对话框**）；图集缩放持久偏好 → `setExportScale`
   - 撤销 / 重做：`undo` / `redo`（等价 Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z）
   - 工程重命名：`setProjectName`（窗口标题与导出标题用它；保存后写进工程文件，**不**重命名磁盘文件）
   - 相机（只移动视口、不改数据）：`focusNode`（聚焦骨骼 / 插槽 / 附件 / 约束，等同层级树双击）/ `panViewport`（按屏幕像素平移）/ `setViewportZoom`（缩放）/ `centerViewport`（把世界坐标点移到视口中心）
   - 舞台参考图（视口背景参照，存工程 `stage/`，**不参与导出**）：`setStage`（按路径设 / 换参考图）/ `updateStage`（改位置 / 大小 / 透明度）/ `removeStage`

预览效果：在线预览（浏览器里用 Spine / Hao2D 运行时播放）**有意不开放**给 AI —— 那是给人看的成品展示。AI 想要可交付产物就 `exportProject` 落盘，再让用户打开。

## 6. 边界（有意不做的事）

- **画笔式刷权重**不开放：那是需要人眼看着画的交互，给 `setVertexWeight` / `autoWeightMesh` 就够了
- **导入外部素材**现在进了命令通道：
  - `importImage`：把外部图片（base64/dataURL 或本地绝对路径）写入工程目录 `images/` 并登记到图片池，AI 不必依赖弹窗；之后用 `addDisplay` 把它做成附件
  - `splitAtlas`：把整页图集（Spine/DragonBones 导入带来的 `loose=false` 图片）按区域拆成独立碎图，让引用它的附件改指碎图
  - 直接改图（换图）仍用 `replaceImage`
- **仍有意不开放**：在线预览（给人看的成品展示）、画笔式刷权重
- 场景未就绪时（窗口还没画第一帧）依赖像素的命令（`autoWeightMesh`、`convertToOutlineMesh`）会明确报错，稍后重试即可
- 服务停止（关编辑器）后 `command-server.json` 会被删除，探活失败即表示编辑器没开

## 7. 给 AI 的系统提示词（可直接粘贴）

> **通常不用粘贴**：编辑器会自动把「使用手册」（坐标/单位约定、标准工作循环、从零到导出的
> 食谱、常见坑，见 `docs/ai-playbook.md`）随服务发现一起下发 —— MCP 客户端在
> `initialize` 的 `instructions` 里收到，HTTP/WS 客户端在 `GET /commands` 响应的
> `playbook` 字段与 WS 握手消息里收到。下面这份提示词留给**读不到上述字段的客户端**，
> 内容与自动下发的手册一致且互不冲突。

```text
你在操作一个叫 Hao2DEditor 的 2D 骨骼动画编辑器。它在本机跑了一个命令服务：

- 先读本工程 `ai/` 目录下的 `hao2d-ai-server.json`（由编辑器在保存 / 打开 / 创建工程时自动写出；同目录还有本命令文档 `hao2d-ai-command-api.md` 与手册 `hao2d-ai-playbook.md`，离线可读）
  - 里面 url 是本机地址，token 是凭证；请求都带上 token（?token= 或 x-hao2d-token 头）
  - 找不到该文件时，才回退去用户目录读 command-server.json：
    macOS ~/Library/Application Support/hao2d-editor/、Windows %APPDATA%\hao2d-editor\、Linux ~/.config/hao2d-editor\；
    或去编辑器启动日志搜「命令服务已启动」
- 通信方式：不要经 shell 执行 curl 拼命令。已加载 MCP 时直接调用对应工具（tools/call）；
  否则用你自己的 HTTP 请求能力（fetch / requests 等）请求上面的 url。curl 只用于人工调试
- 工作方式：
  1) POST {url}/command  {"name":"getProjectState"} 了解当前工程
  2) 需要知道有哪些能力时，先 GET {url}/commands 读命令目录（含参数说明），不要凭记忆猜命令名
  3) 改动前先用 listBones / listSlots / listDisplays / listAnimations 等查询命令确认名字
  4) 一次搭多个东西用 POST {url}/batch，带 "transaction": true 合并成一条撤销记录
  5) 每条命令都会回 {ok, changed, data, message, error}：ok=false 时按 error 里的提示修正参数再试
- 引用对象一律用名字（不用下标）；时间单位是秒
- 引入外部素材：`importImage`（把外部图片写入工程图片池）、`splitAtlas`（整页图集拆碎图）；之后用 `addDisplay` 把图片做成附件，用 `autoMeshFromImage` 按轮廓生成网格、用 `autoWeightMesh` 蒙皮
- 不要做：批量里塞超过 ~30 条命令、重复执行副作用未知的写命令、期待画笔式刷权重
- 做完一件事用 getProjectState 或对应 list* 复述结果，确认真的落地了
```

## 8. MCP 接入（AI 自动发现）

除了上面这套自定义 HTTP / WebSocket 接口，编辑器还**原生实现了 MCP（Model Context Protocol）**，
让支持 MCP 的 AI 工具（Claude Desktop、Cursor、VSCode Copilot、Codex、WorkBuddy 等）把它当成
一个 **MCP Server 自动加载** —— 不用手粘提示词，客户端重启后直接出现「Hao2DEditor 的全部命令」。

### 8.1 端点

命令服务在现有本地服务上多开了一个 MCP 端点（Streamable HTTP 传输）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/.well-known/mcp.json` | 本地发现：只暴露端点 URL（不含 token），供客户端扫描 |
| POST | `/mcp` | MCP JSON-RPC：`initialize` / `tools/list` / `tools/call` |

- `tools/list` 复用第 2 节的命令自描述（`GET /commands`），把每条 `CommandSpec` 翻译成 MCP tool；
- `tools/call` 复用 `POST /command` 的执行链路，`ok:false` 时把 `error` 作为 `isError` 回给 AI 自纠。
- `/mcp` 同样走 token 鉴权（三种带法都认）。token 直接拼进下面的 URL 即可，客户端只填地址。

### 8.2 在编辑器里「一键接入」

菜单「文件 → AI 接入…」打开面板：

1. 显示当前 **MCP 地址**（形如 `http://127.0.0.1:<端口>/mcp?token=…`），可一键复制；
2. 「**一键安装到 AI 客户端**」会把该地址写进已识别的客户端配置：
   - **自动写入**（schema 已知、安全）：Claude Desktop、Cursor、VSCode / Copilot；
   - **仅探测、需手动填**：Codex / WorkBuddy / CodeBuddy / DeepSeek Harness / Trae / ZCode
     （这些客户端的 MCP 配置格式未公开或各异，不冒然改写其配置，面板会给出地址让用户填）。

客户端重启后就会自动加载 Hao2DEditor 的全部命令，无需任何提示词。

### 8.3 手动接入（任意支持 HTTP MCP 的客户端）

把面板里的 MCP 地址填进客户端的 MCP 设置即可。例如 Claude Desktop 的
`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "hao2d-editor": { "url": "http://127.0.0.1:37241/mcp?token=8Yk…" }
  }
}
```

> 端口与 token 跨重启保持不变（固定端口 + 持久化 token），所以填进客户端的地址可长期复用，不必每次重启都改。
> 唯一例外：固定端口被别的程序占用时会顺延到附近端口，这时以面板显示的地址为准（或读 `command-server.json`）。
> 关掉编辑器后服务停止、发现文件被删，客户端会提示连接失败 —— 重新打开编辑器即可（地址不变）。

### 8.4 内建的「不要用 curl」指引

AI 不管从哪个入口接入，拿到命令时都会同时收到同一条 `instructions`：

| 入口 | 位置 |
| --- | --- |
| MCP | `initialize` 返回的 `instructions`（支持该字段的客户端会注入 AI 上下文） |
| HTTP | `GET /commands` 响应顶层的 `instructions` |
| WebSocket | 连接建立即推送 `{ id: null, hello: "hao2d-command", instructions }`；另，WS 上请求 `__catalog` 的响应也带 |
| 工程 `ai/` 目录 | `hao2d-ai-server.json` 的 `instructions` |
| userData | `command-server.json` 的 `instructions`（发现服务时读到） |

内容一致：**不要经 shell 执行 curl 拼命令** —— 已加载 MCP 就直接调工具（tools/call），
否则用你自己的 HTTP 请求能力（fetch / requests 等）；curl 仅供人工调试。
文案集中定义在 `src/shared/commandTypes.ts` 的 `AI_TRANSPORT_NOTICE`，各处共用一份。
WS 握手消息没有 `ok` 字段、`id` 为 `null`：客户端按数字 `id` 匹配响应时不会把它错认成某条命令的结果。
