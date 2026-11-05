/**
 * pixi.js 的「外部桥」：让打包后的运行库从**全局 `PIXI`** 取 pixi，而不是把整个 pixi 卷进库里。
 *
 * 用法：`scripts/build-hao2d-runtime.mjs` 用 esbuild 的 alias 把 `import ... from 'pixi.js'`
 * 重定向到本文件；本文件不打包任何 pixi 代码，只从 `globalThis.PIXI` 取引用。
 * 真正的 pixi 由预览页用独立的 `<script src="pixi.js">` 单独加载（与 spine-core 同思路）。
 *
 * 若某天运行库用到这里没列出的 pixi 导出，构建会报错，照着往下面加一行即可。
 */
// 全局没有 PIXI 的索引签名，这里显式说明「globalThis 上有个 pixi 命名空间」，
// 顺带让下面的转发按 pixi 的真实类型走（而不是 any），运行库内部也能被类型检查覆盖。
type PixiNamespace = typeof import('pixi.js')

const globalPIXI = (globalThis as unknown as { PIXI?: PixiNamespace }).PIXI

if (!globalPIXI) {
  throw new Error(
    '[hao2d] 没有找到全局 PIXI：hao2d-pixi.js 只包含 hao2d 功能，请先加载 pixi.js v8' +
      '（例如 `<script src="pixi.min.js"></script>`），再加载本文件'
  )
}

const PIXI = globalPIXI

export const Application = PIXI.Application
export const Container = PIXI.Container
export const Graphics = PIXI.Graphics
export const FillGradient = PIXI.FillGradient
export const Buffer = PIXI.Buffer
export const BufferUsage = PIXI.BufferUsage
export const Geometry = PIXI.Geometry
export const Mesh = PIXI.Mesh
export const Texture = PIXI.Texture
export const ImageSource = PIXI.ImageSource
export const TilingSprite = PIXI.TilingSprite
