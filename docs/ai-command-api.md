# AI 命令接口（本地 HTTP / WebSocket）

给 AI 工具（codex / workbuddy / 脚本）用的命令通道：**编辑器自己起一个只监听本机的服务**，AI 发 JSON 就能读写当前打开的工程 —— 不做 CLI，不需要在编辑器里点任何东西。

- 服务在**主进程**：`127.0.0.1` 随机端口 + 强制 token（不暴露局域网）
- 命令在**渲染进程执行**：文档状态只在那里；主进程只负责转发，不碰工程数据
- 返回结构化结果：`{ ok, changed, data, message, error, label }`，参数写错也用同一形状回话，AI 可以照着 `error` 自纠后重试

## 1. 发现服务

编辑器启动时把地址与 token 写进 **userData 目录下的 `command-server.json`**，同时打进启动日志（搜索「命令服务已启动」）。

文件位置（按平台）：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/hao2d-editor/command-server.json` |
| Windows | `%APPDATA%\hao2d-editor\command-server.json` |
| Linux | `~/.config/hao2d-editor/command-server.json` |

内容：

```json
{
  "port": 52741,
  "token": "8Yk…（一段随机串）",
  "url": "http://127.0.0.1:52741",
  "file": "/Users/you/Library/Application Support/hao2d-editor/command-server.json"
}
```

拿 `url` + `token` 就能开干。token 三种带法都认：`?token=…`、`x-hao2d-token` 头、`Authorization: Bearer …`。

## 2. 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 探活：`{ ok, service, port, url }` |
| GET | `/commands` | **全部命令的自描述**（名字、标题、参数、返回值）——先读它再动手 |
| POST | `/command` | 执行一条命令：`{ "name": "addBone", "args": { … } }` |
| POST | `/batch` | 批量：`{ "commands": [ … ], "transaction": true }` |
| WS | `/ws` | 长连接版；消息 `{ id?, name, args }` 或 `{ id?, batch: [...], transaction? }` |

```bash
BASE=http://127.0.0.1:52741
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
2. `getProjectState` / `listBones` / `listSlots` / `listAnimations` 摸清现状
3. 用**名字**引用对象（`parent: "root"`、`bone: "forearm"`）——命令和查询都用名字，不用下标
4. 改动走 `POST /command` 或 `POST /batch`
5. 需要 AI 生成的东西：骨骼/插槽/约束 → `addBone` `addSlot` `addConstraint`；关键帧 → `keyBoneFrame` `keySlotDisplayFrame` …（时间单位是**秒**）；蒙皮 → `convertToMesh` / `convertToOutlineMesh` / `autoWeightMesh`

预览效果：让用户点编辑器的「预览」，或先 `saveProject` 再配合预览服务。

## 6. 边界（有意不做的事）

- **画笔式刷权重**不开放：那是需要人眼看着画的交互，给 `setVertexWeight` / `autoWeightMesh` 就够了
- **导入图片**（`importImagesFlow`）会弹系统文件选择框，属于 UI 流程，不在命令通道里；用已有图片工作：`addDisplay`、`replaceImage`
- 场景未就绪时（窗口还没画第一帧）依赖像素的命令（`autoWeightMesh`、`convertToOutlineMesh`）会明确报错，稍后重试即可
- 服务停止（关编辑器）后 `command-server.json` 会被删除，探活失败即表示编辑器没开

## 7. 给 AI 的系统提示词（可直接粘贴）

```text
你在操作一个叫 Hao2DEditor 的 2D 骨骼动画编辑器。它在本机跑了一个命令服务：

- 先读 ~/Library/Application Support/hao2d-editor/command-server.json
  （Windows: %APPDATA%\hao2d-editor\，Linux: ~/.config/hao2d-editor\，macOS 如上；
   找不到就去编辑器日志里搜「命令服务已启动」）
- 里面 url 是本机地址，token 是凭证；请求都带上 token（?token= 或 x-hao2d-token 头）
- 工作方式：
  1) POST {url}/command  {"name":"getProjectState"} 了解当前工程
  2) 需要知道有哪些能力时，先 GET {url}/commands 读命令目录（含参数说明），不要凭记忆猜命令名
  3) 改动前先用 listBones / listSlots / listDisplays / listAnimations 等查询命令确认名字
  4) 一次搭多个东西用 POST {url}/batch，带 "transaction": true 合并成一条撤销记录
  5) 每条命令都会回 {ok, changed, data, message, error}：ok=false 时按 error 里的提示修正参数再试
- 引用对象一律用名字（不用下标）；时间单位是秒
- 不要做：批量里塞超过 ~30 条命令、重复执行副作用未知的写命令、期待画笔式刷权重
- 做完一件事用 getProjectState 或对应 list* 复述结果，确认真的落地了
```
