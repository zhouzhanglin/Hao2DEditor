![截图](./screenshot.png)

# Hao2D Editor

> 免费、轻量、跨平台的 2D 骨骼动画编辑器 · A free, lightweight 2D skeletal animation editor
>
> 使用手册: [wiki/index.md](wiki/index.md) （安装、界面、工具、教程、导入导出、AI 接入）

---

## release 1.0.3

- 支持物理约束（Physics）
- 支持 Three.js 运行库与 Three.js 预览
- 修复 RuntimeIK：从 Spine 烘焙来的动画不再被 Hao2D 的 IkSolver 二次求解
- 预览页跟随编辑器语言（简体中文 / English）
- 运行时（pixi）预览补齐换装、显隐、显示下标、嵌套子骨架面板
- `resources/runtimes` 提供压缩版 `hao2d-pixi.js` / `hao2d-three.js`（只含 hao2d 功能）

---

## 中文简介

**Hao2D Editor** 是一款**完全免费**的 2D 骨骼动画编辑器，基于 Electron + TypeScript + React + PixiJS 打造，当前提供 Windows / macOS 安装包，无需购买授权。

它覆盖网格蒙皮与 FFD 自由变形、IK / 变换 / 路径约束、物理约束、曲线编辑器、时间轴与实时预览，可直接导入 **Spine**、**DragonBones** 工程及 PSD 分层文件；导出侧支持 Spine 4.3 JSON + atlas、Unity `.hao2d`（含图集/材质）、自研运行时数据（pixi / Three.js）以及 MP4 视频。编辑器内置本地 HTTP / WebSocket 接口，配合 `docs/ai-command-api.md` 和 `resources/skills` 里的技能文档，AI 工具可以脚本化完成建模与动画。

相比 DragonBones（已停止维护），它持续更新、双格式互通；相比 Spine（商业授权），它零成本、无节点限制。

### 主要能力

- **编辑**：骨骼 / 插槽 / 皮肤、网格蒙皮、FFD（含权重网格）、IK / 变换 / 路径约束、物理约束、曲线编辑器、时间轴、自动关键帧、撤销重做、多语言界面。
- **导入**：Spine 4.x（JSON + atlas + 图片）、DragonBones（`_ske.json` / `_tex.json`）、PSD 分层文件。
- **导出**：
  - Spine 4.3：`*.json` + `*.atlas` + 图集页；
  - Unity：`.hao2d` + 图集页 + 材质配置；
  - 运行时数据：`*_ske.json` + `*_atlas.json` + 图集页，供 `hao2d-pixi.js` / `hao2d-three.js` 直接加载；
  - Three.js：在运行时数据之外附 `hao2d-three.js` 与 `demo.html`；
  - MP4：通过 ffmpeg 逐帧编码（可选，见下文）。
- **预览**：Spine / 运行时（pixi）/ Three.js 三种预览页；运行时与 Three.js 预览支持换装、显隐、显示下标、嵌套子骨架，界面语言跟随编辑器。
- **运行库**：`resources/runtimes/hao2d-pixi.js` 与 `hao2d-three.js` 是压缩后的单文件，**只包含 hao2d 功能**；pixi.js / three.js 由宿主提供（先挂到全局 `PIXI` / `THREE`），便于游戏工程复用已有依赖。
- **AI**：本地 HTTP / WebSocket 接口 + AI 命令 API + 技能文档，支持从外部脚本驱动导入、编辑、导出与预览。

### 运行时数据与预览

`resources/runtimes` 随安装包分发（macOS 位于 `Hao2D Editor.app/Contents/Resources/runtimes/`，Windows 位于安装目录的 `resources/runtimes/`）：

| 文件 | 全局对象 | 前置依赖 |
| :--- | :--- | :--- |
| `hao2d-pixi.js` | `Hao2dRuntime` | 宿主先加载 pixi.js v8，提供全局 `PIXI` |
| `hao2d-three.js` | `Hao2dThreeRuntime` | 宿主先加载 three.js，提供全局 `THREE` |

两份文件都是 minified 单文件；编辑器里「导出运行时数据」/「导出 Three.js」会产出配套的 `*_ske.json`、`*_atlas.json` 和图集页。

「导出 Three.js」附带的 `demo.html` 同样只含 hao2d 逻辑：页面优先使用已有的 `window.THREE`，没有才从 CDN 取 three；离线部署时请把 three 换成本地构建，并确保在加载 `hao2d-three.js` 之前挂好全局 `THREE`。

---

## English Overview

**Hao2D Editor** is a **completely free** 2D skeletal animation editor built with Electron, TypeScript, React, and PixiJS. It ships Windows and macOS builds — no license fees, no seat limits.

It covers mesh skinning, weighted FFD, IK / transform / path / physics constraints, curve editing, timeline, and real-time preview. Import **Spine**, **DragonBones**, and layered PSD files; export Spine 4.3 JSON + atlas, Unity `.hao2d` (with atlas/material), standalone runtime data for **pixi** and **three.js**, or MP4 video. A built-in local HTTP / WebSocket API plus the AI command docs and skill files let external tools script the whole workflow.

The bundled runtimes live in `resources/runtimes` (`hao2d-pixi.js`, `hao2d-three.js`). They are minified, hao2d-only single files; the host supplies `PIXI` or `THREE` from its own dependency set.

Unlike DragonBones (no longer maintained), Hao2D stays updated and bridges both ecosystems. Unlike Spine (paid licensing), it costs nothing.

### Build from source

Requires Node.js 20+ (22 LTS recommended):

```bash
npm install
npm run dev      # Electron + Vite dev server with HMR
npm run build    # regenerate runtimes and build into out/
npm run package  # installers / unpacked app in release/
```

See the Chinese section below for per-step details, packaging targets, and ffmpeg setup.

---

## 与 DragonBones / Spine 对比

| 对比项 | **Hao2D Editor** | DragonBones | Spine |
| :--- | :---: | :---: | :---: |
| 价格 | **完全免费** | 免费 | 商业付费授权 |
| Windows / macOS | ✅ | ✅ | ✅ |
| 网格蒙皮 + FFD 变形 | ✅ | ✅ | ✅ |
| IK / 变换 / 路径约束 | ✅ | 部分 | ✅ |
| 物理约束 | ✅ | ✕ | ✅ |
| 导入 Spine 数据 | ✅ | ✕ | — |
| 导入 DragonBones 数据 | ✅ | — | ✕ |
| 导入 PSD 分层 | ✅ | ✕ | ✕ |
| 内置 Three.js 运行库 / 预览 | ✅ | ✕ | 官方 runtime 另装 |
| AI 脚本接口（HTTP / WS） | ✅ 内置 | ✕ | ✕ |
| 授权与节点限制 | **无** | 无 | 按授权收费 |

> **一句话总结**：想要 Spine 的能力、DragonBones 的免费，又不想被授权和停更困住 —— 用 Hao2D Editor。

---

## 自己 build 项目（npm）

### 环境要求

- **Node.js 20 LTS 及以上**（推荐 22 LTS），npm 10+
- Windows 10+ / macOS 11+
- 首次安装依赖与 Electron 需要联网，预留约 1–2 GB 磁盘空间
- 仓库根目录的 `.npmrc` 已把 Electron / electron-builder 二进制指向国内镜像；海外网络或使用代理时可以删掉该文件

### 1. 安装依赖

```bash
git clone <仓库地址> Hao2DEditor
cd Hao2DEditor
npm install
```

首次会下载 Electron（约 100 MB+）。`ffmpeg-static` 是可选依赖，装不上不影响编辑器与打包。

### 2. 开发模式

```bash
npm run dev
```

`predev` 会自动执行 `copy-vendor` 和 `build:runtimes`（准备 pixi / spine-core 的浏览器副本、生成运行库），然后启动 Electron + Vite 热更新。

只调试渲染层 UI（浏览器里打开，不包含 Electron 主进程、文件 IPC、原生对话框）：

```bash
npm run dev:web
```

### 3. 生产构建

```bash
npm run build
```

它会依次执行（`prebuild` 会先自动执行 `copy-vendor`）：

1. `build:hao2d-runtime` → `src/main/preview/hao2dRuntime.generated.js`（pixi 版预览运行库，pixi 外置）
2. `build:threejs-runtime` → `threejsRuntime.generated.js`（预览用，three 已打包）+ `threejsCore.generated.js`（瘦版，导出/分发用）
3. `build:runtimes` → `resources/runtimes/hao2d-pixi.js`、`hao2d-three.js`（压缩版，只含 hao2d 功能）
4. `electron-vite build` → `out/main`、`out/preload`、`out/renderer`

构建完成后运行构建产物：

```bash
npm run preview
```

### 4. 检查与测试

```bash
npm run typecheck       # TypeScript 类型检查
npm test                # Vitest 单元测试
npm run check:skill-docs  # 校验 AI 技能文档与命令定义是否同步
```

### 5. 打安装包

```bash
npm run package        # 当前平台的未打包目录，输出到 release/
npm run package:mac    # macOS dmg + zip（x64 / arm64）
npm run package:win    # Windows NSIS 安装包（x64）
npm run package:all    # macOS + Windows
```

说明：

- 产物统一在 `release/`。macOS 打 Windows 包需要 Wine；Windows 上不能打 macOS 包，需要 macOS 环境。
- 默认不签名 / 不公证；正式分发需要自备证书（electron-builder 的 `CSC_*` 与 Apple 公证环境变量）。
- 打包会把 `resources/skills`（AI 技能文档）、`resources/ffmpeg`、`resources/runtimes` 放进安装目录的 `resources/`（macOS 为 `.app/Contents/Resources/`）。

### 6. 只重新生成运行库

改了运行库源码（`src/main/preview/*.ts`）或只想刷新 `resources/runtimes` 时：

```bash
npm run copy-vendor          # 首次/缺少 vendor 时先执行
npm run build:hao2d-runtime
npm run build:threejs-runtime
npm run build:runtimes
```

产物：

- `src/main/preview/hao2dRuntime.generated.js` / `threejsRuntime.generated.js` / `threejsCore.generated.js`：编辑器预览与导出内联使用；
- `resources/runtimes/hao2d-pixi.js` / `hao2d-three.js`：随安装包分发、可直接拷给用户使用的压缩运行库。

### 7. 可选：MP4 导出所需的 ffmpeg

编辑器通过 ffmpeg 把逐帧 RGBA 编成 H.264。按优先级自动查找：

1. 环境变量 `HAO2D_FFMPEG=/绝对路径/ffmpeg`
2. `resources/ffmpeg/<mac|win|linux>/ffmpeg`（Windows 为 `ffmpeg.exe`）
3. `ffmpeg-static`（`npm i ffmpeg-static`）
4. 系统 PATH 中的 `ffmpeg`

不配置也能正常构建 / 打包，只是点「导出 MP4」时会提示找不到 ffmpeg。

### 常见问题

- **Electron 下载失败 / 提示 Electron uninstall**：检查 `.npmrc` 镜像是否可访问；海外网络可删除 `.npmrc` 后重装。
- **`build:runtimes` 报缺少 `vendor/pixi.min.js`**：先执行 `npm run copy-vendor`。
- **打包 Windows 包失败**：macOS 上需要安装 Wine；或者直接在 Windows 上执行 `npm run package:win`。
- **运行库没有更新**：`npm run dev` / `npm run build` 会自动生成；单独调试时执行上面的「只重新生成运行库」。
