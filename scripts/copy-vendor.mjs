import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// pixi.js v8 的 package.json `exports` 不允许直接 import 其 dist 下的子路径
// （如 `pixi.js/dist/pixi.min.js`），而主进程模块在运行期由 Node 解析，
// `?raw` 无法被 Vite 在打包期改写为内联字符串，于是运行期 Node 解析失败。
// 这里在打包前把 pixi.min.js 拷到项目内（随 pixi 升级重新拷贝即可），
// 主进程用相对路径 `./preview/vendor/pixi.min.js?raw` 引入，Vite 会把它内联为字符串。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/pixi.js/dist/pixi.min.js')
const destDir = resolve(root, 'src/main/preview/vendor')
const dest = resolve(destDir, 'pixi.min.js')

if (!existsSync(src)) {
  console.warn('[copy-vendor] 未找到 node_modules/pixi.js/dist/pixi.min.js，跳过（请确认已安装 pixi.js）')
  process.exit(0)
}
mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log('[copy-vendor] pixi.min.js -> src/main/preview/vendor/pixi.min.js')
