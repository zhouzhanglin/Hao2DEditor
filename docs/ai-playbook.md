# Hao2DEditor 动画制作手册（AI 使用 · 极简版）

> **本文件是「自动下发」的那一份**：构建时内联进应用（MCP `initialize.instructions` /
> `GET /commands` 的 `playbook` 字段 / WS 握手），并在保存 / 打开工程时写进工程
> `ai/hao2d-ai-playbook.md`。改内容只改这里，代码里不做第二份。
>
> 这里只放**每次会话都必须知道的最小集合**：坐标约定、工作循环、硬坑。
> 具体做法（配方、门禁、排错、命令参数）在随包 Skill `hao2d-skeletal-animation` 里。
> 两者冲突时：**参数与命令名以编辑器 `/commands` 为准，流程以 Skill 为准。**
>
> **Skill 从哪来**：客户端已经加载了同名 Skill（用户级 skills 目录）就直接用它，
> **不要再去工程里找副本**；没有加载时，让用户打开「文件 → AI 接入…」面板点
> 「复制引导语」，那一句会给出本工程副本的位置。

## 坐标与单位（最先记住，错了全盘错）

- 世界坐标 y 轴向上；1 世界单位 = 100 像素（PPU=100），一张 512px 的图约 5.12 单位
- 角度单位是度；时间单位是秒，打帧给绝对时间点（不是相对偏移）
- 颜色 #RRGGBB，透明度 0-1；引用骨骼 / 插槽 / 附件 / 动画 / 皮肤一律用名字，不用下标

## 标准工作循环

1) 动手前先读状态：`getProjectState`；再用 `listBones` / `listSlots` / `listImages` /
   `listAnimations` / `listSkins` 核对名字，不要凭记忆猜
2) 一次搭多个东西走批量：`POST /batch {"commands":[…],"transaction":true,"label":"…"}`
   （一次不超过约 30 条；transaction 合并成一条撤销记录，失败整体回滚）
3) 做完就复核：`getAnimationKeys` 查打帧明细，`getProjectState` 复述文档状态；
   `ok:false` 时按 `error` 提示修正参数再试，不要原样重发

## 从零做一个动画（最小路径）

1) 没有工程：`createProject {name, dir}`（路径必须给全，不弹对话框）
2) 素材进池：`importImages {paths}` / `importImage` / `splitAtlas`；`listImages` 确认图片名
3) 搭骨骼：`addBone {name, parent, localPosition, rotation, length}`，先根后叶；
   返回值里的 `name` 才是最终名字（重名会加序号）
4) 装配：`addSlot {name, bone, zOrder}` → `addDisplay {slot, image}`
5) 打帧：`addAnimation {name, duration}` → `keyBoneFrame` / `keySlot*Frame` → `setKeyframeEasing` → `keyEvent`。
   **一次做完，不要中途停下来等确认**（不要先出缩略图问「这样可以吗」）
6) 收尾：`getAnimationKeys` 自查 → `saveProject`。**不要问要不要导出**；用户明确要求时才 `exportProject`

## 常见坑

- 所有文件类命令都不弹对话框：目录 / 路径必须在参数里给全（绝对路径）
- 撤销栈只有 80 条：大改动分批走 batch，不要拆成单发刷屏
- 「场景未就绪」= 视口还没画完第一帧，稍后重试（`autoWeightMesh`、`autoMeshFromImage`、
  `getDisplayWorldBounds` 这类依赖像素的命令都会这样）
- `setActiveSkeleton` / `setActiveSkin` 会清空选中与时间轴状态，切完先重新查状态
- 在线预览、画笔式刷权重是**有意不开放**的：要交付就 `exportProject` 落盘

## 需要更细的做法时（都在 Skill 里）

| 要做的事 | 读哪里 |
| --- | --- |
| 蒙皮 / FFD / 遮罩 / 皮肤换装 / 链接网格 / 骨架嵌套 / IK 的具体命令序列 | Skill `references/recipes.md` |
| 分阶段确认、跳步（图已放好 / 骨架已绑好、只差动画）、只做动画的硬约束 | Skill `references/pipeline.md` |
| `ok:false`、画面不对、打帧没生效 | Skill `references/troubleshooting.md` |
| 某条命令的准确参数与返回值 | Skill `references/commands.md`（由命令注册表生成）或 `GET /commands` |

**别猜命令名**：先 `GET /commands`（或 `__catalog`）拿目录，每条命令的参数说明都在里面。
