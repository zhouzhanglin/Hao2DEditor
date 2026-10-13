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
  '@shared': resolve(root, 'src/shared')
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
  logLevel: 'info'
})

console.log('hao2d pixi runtime built -> src/main/preview/hao2dRuntime.generated.js')
