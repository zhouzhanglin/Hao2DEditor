import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

/**
 * 生成「随 App 分发、拿去就能用」的两份**只含 hao2d 功能**的压缩运行库：
 * resources/runtimes/hao2d-pixi.js / hao2d-three.js。
 *
 * 关键点：第三方库**不打进来**。
 * - pixi 版 = `hao2dRuntime.generated.js`（预览页里那份外置 PIXI 的库，74 KB 左右）；
 * - three 版 = `threejsCore.generated.js`（构建时把 `three` alias 到 threeShim，只含 hao2d 逻辑）。
 *
 * 宿主需要先加载自己的 pixi.js / three.js 并挂到全局（`PIXI` / `THREE`），再加载这两个文件。
 * 这样游戏工程里已经有的第三方库不会被重复打包一份（体积 / 多实例问题都避免）。
 * 预览页不受影响：那里用的 `threejsRuntime.generated.js` / pixi vendor 仍是自包含的。
 *
 * 两份都过一遍 esbuild 压缩（去注释 / 空白 / 冗余语法），顶部只留一行单行注释说明依赖与用法。
 * `minifyIdentifiers: false` 是必须的：顶层 `Hao2dRuntime` / `Hao2dThreeRuntime` 是对外全局契约，
 * 一旦被压缩器改名就全废了。
 *
 * package.json 的 extraResources 会把这个目录放进安装包的 resources/runtimes。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const previewDir = resolve(root, 'src/main/preview')
const outDir = resolve(root, 'resources/runtimes')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version

const MINIFY = {
  loader: 'js',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'none',
  target: 'es2020'
}

function readRequired(file, label) {
  if (!existsSync(file)) {
    throw new Error(
      `缺少 ${label}：${file}\n请先运行 npm run build:hao2d-runtime 与 npm run build:threejs-runtime`
    )
  }
  return readFileSync(file, 'utf8')
}

async function compress(code) {
  // 压到稳定：产物是「再压也不会变小」的定稿，单测据此钉住 minified 状态。
  let out = (await transform(code, MINIFY)).code.trim()
  for (let i = 0; i < 3; i++) {
    const next = (await transform(out, MINIFY)).code.trim()
    if (next === out) break
    out = next
  }
  return out
}

const pixiSource = readRequired(resolve(previewDir, 'hao2dRuntime.generated.js'), 'pixi 版 hao2d 运行库')
const threeSource = readRequired(resolve(previewDir, 'threejsCore.generated.js'), 'three.js 版 hao2d 运行库')

const banner = (file, globalName, externals, api, license) =>
  `/*! Hao2D ${file} v${version} | minified hao2d-only runtime, ${externals} NOT bundled | ` +
  `requires global ${externals} (load it first) | ` +
  `${globalName}.${api} | ${license} */\n`

const pixiBanner = banner(
  'hao2d-pixi.js',
  'Hao2dRuntime',
  'PIXI',
  'createStage({canvas,pages,skeText,atlasText}) -> stage.play(name,loop)',
  'pixi.js v8 MIT'
)
const threeBanner = banner(
  'hao2d-three.js',
  'Hao2dThreeRuntime',
  'THREE',
  'createStage(...) / createView(...) / IHao2DView APIs',
  'three.js r170 MIT'
)

const pixiBundle = await compress(pixiSource)
const threeBundle = await compress(threeSource)

mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'hao2d-pixi.js'), `${pixiBanner}${pixiBundle}\n`, 'utf8')
writeFileSync(resolve(outDir, 'hao2d-three.js'), `${threeBanner}${threeBundle}\n`, 'utf8')

for (const file of ['hao2d-pixi.js', 'hao2d-three.js']) {
  const size = readFileSync(resolve(outDir, file)).length
  console.log(`[runtimes] resources/runtimes/${file} (hao2d only, minified, ${(size / 1024).toFixed(0)} KB)`)
}
console.log('[runtimes] 两份 hao2d 压缩运行库已生成（需要宿主先加载 PIXI / THREE）')
