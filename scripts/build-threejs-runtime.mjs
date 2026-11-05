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
  // core 里的提示文本会 import { t } from '@i18n'：指到替身，避免把 react 与词典打进运行库
  '@i18n': resolve(root, 'src/i18n/runtimeStub.ts')
}

const common = {
  entryPoints: [resolve(root, 'src/main/preview/threejsRuntime.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Hao2dThreeRuntime',
  platform: 'browser',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  logLevel: 'info'
}

/**
 * 预览页 / 编辑器内部用的**自包含**版本：three 直接打包进来。
 * 预览页只加载一个 threejs-runtime.js 就能跑，不依赖预览环境里有没有全局 THREE。
 */
await build({
  ...common,
  outfile: resolve(root, 'src/main/preview/threejsRuntime.generated.js'),
  alias
})

/**
 * 给 `resources/runtimes/hao2d-three.js` 用的**瘦版**：只含 hao2d 功能，three 从全局 `THREE` 取
 * （见 threeShim.ts）。宿主项目自己引 three，避免同一个页面里重复加载一份 three。
 */
await build({
  ...common,
  outfile: resolve(root, 'src/main/preview/threejsCore.generated.js'),
  alias: { ...alias, three: resolve(root, 'src/main/preview/threeShim.ts') }
})

console.log(
  'three.js hao2d runtime built -> threejsRuntime.generated.js（预览用，three 已打包） + ' +
    'threejsCore.generated.js（分发用，只含 hao2d，依赖全局 THREE）'
)
