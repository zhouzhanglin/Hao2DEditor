import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'

/** 从仓库根读文件：这些是构建产物，但会提交进仓库并随 App 分发，必须一直可用 */
const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
  build: { extraResources: Array<{ from: string; to: string }> }
}

/** 与 scripts/build-runtimes.mjs 一致的压缩参数（minifyIdentifiers 必须关掉，否则全局契约被改名） */
const MINIFY = {
  loader: 'js' as const,
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'none' as const,
  target: 'es2020'
}

/** 去掉顶部那行单行注释 banner，剩下的应是「再压也不会变」的定稿代码 */
const stripBanner = (source: string): string =>
  source.replace(/^\/\*![^\n]*\*\/\r?\n/, '').trim()

/**
 * `resources/runtimes/` 是给安装后的用户用的两份运行库：
 * 只含 hao2d 功能，pixi.js / three.js 由宿主提供（不打进来、不重复加载）。
 * 这里钉住「hao2d-only + 真压缩 + 全局依赖契约 + 打包配置」。
 */
describe('随 App 分发的 hao2d-only 压缩运行库（resources/runtimes）', () => {
  it('hao2d-pixi.js 只含 hao2d，pixi 由宿主的全局 PIXI 提供', () => {
    const source = read('resources/runtimes/hao2d-pixi.js')
    // 只含 hao2d：体积应接近 hao2dRuntime.generated.js，而不是 880KB 的 pixi 拼接版
    expect(source.length).toBeLessThan(200_000)
    expect(source).toContain('PIXI NOT bundled')
    expect(source).toContain('requires global PIXI')
    expect(source).toContain('Hao2dRuntime=')
    expect(source).toContain('createStage')
    expect(source).not.toContain('PixiJS - v8') // 第三方库没有被打进来
    expect(source).not.toContain('sourceMappingURL')
  })

  it('hao2d-three.js 只含 hao2d，three 由宿主的全局 THREE 提供', () => {
    const source = read('resources/runtimes/hao2d-three.js')
    expect(source.length).toBeLessThan(200_000)
    expect(source).toContain('THREE NOT bundled')
    expect(source).toContain('requires global THREE')
    expect(source).toContain('Hao2dThreeRuntime=')
    expect(source).toContain('createView')
    expect(source).not.toContain('sourceMappingURL')
  })

  it('两份都是 minified：单行代码 + 一行 banner，再压缩字节不变', async () => {
    for (const file of ['hao2d-pixi.js', 'hao2d-three.js']) {
      const source = read(`resources/runtimes/${file}`)
      const code = stripBanner(source)
      expect(source.startsWith('/*! ')).toBe(true) // 单行 banner
      expect(source.slice(1).includes('/*!')).toBe(false) // 没有第二块说明注释
      // 不含第三方库后，压缩产物是一整行（预览页的 generated.js 里那些换行来自 GLSL 字符串）
      expect(code).not.toContain('\n')
      const again = (await transform(code, MINIFY)).code.trim()
      expect(again).toBe(code)
      expect(code).toContain(file === 'hao2d-pixi.js' ? 'Hao2dRuntime=' : 'Hao2dThreeRuntime=')
    }
  })

  it('构建链路：pixi / three 均为外置，导出复用同一份分发文件', () => {
    const runtimesScript = read('scripts/build-runtimes.mjs')
    expect(runtimesScript).toContain('hao2dRuntime.generated.js')
    expect(runtimesScript).toContain('threejsCore.generated.js')
    // 不再拼接官方 pixi.min.js
    expect(runtimesScript).not.toContain('vendor/pixi.min.js')

    const threeScript = read('scripts/build-threejs-runtime.mjs')
    expect(threeScript).toContain('threeShim.ts')
    expect(threeScript).toContain('threejsCore.generated.js')
    expect(read('src/main/preview/threeShim.ts')).toContain('globalThis')

    // 导出 Three.js 用的是同一份「只含 hao2d」的文件
    expect(read('src/editor/services/exportService.ts')).toContain('resources/runtimes/hao2d-three.js?raw')
  })

  it('构建时重新生成，且随安装包一起分发', () => {
    expect(pkg.scripts['build:runtimes']).toBe('node scripts/build-runtimes.mjs')
    expect(pkg.scripts.build).toContain('build:runtimes')
    expect(pkg.build.extraResources).toContainEqual({ from: 'resources/runtimes', to: 'runtimes' })
  })
})
