import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const alias = {
  '@core': resolve(root, 'src/core'),
  '@importers': resolve(root, 'src/importers'),
  '@render': resolve(root, 'src/render'),
  '@editor': resolve(root, 'src/editor'),
  '@ui': resolve(root, 'src/ui'),
  '@shared': resolve(root, 'src/shared'),
  // pixi 不打包进运行库：import 重定向到桥文件，运行时从全局 PIXI 取（pixi 由预览页单独加载）
  'pixi.js': resolve(root, 'src/main/preview/pixiShim.ts')
}

await build({
  entryPoints: [resolve(root, 'src/main/preview/hao2dRuntime.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Hao2dRuntime',
  platform: 'browser',
  target: 'es2019',
  outfile: resolve(root, 'src/main/preview/hao2dRuntime.generated.js'),
  alias,
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  logLevel: 'info'
})

console.log('hao2d runtime built -> src/main/preview/hao2dRuntime.generated.js (pixi.js 已拆为独立文件，预览页单独加载)')
