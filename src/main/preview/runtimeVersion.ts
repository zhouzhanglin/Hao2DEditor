/**
 * 运行库版本：由构建脚本在打包时注入，不读 package.json 的编辑器版本。
 *
 * 目的：编辑器功能继续按 1.0.x 发版，但 `hao2d-pixi.js` / `hao2d-three.js`
 * 只有在**运行库代码真的改了**时才升自己的版本（版本清单见 resources/runtimes/versions.json）。
 *
 * 这是编译期替换符；dev:web 直接跑 TS 时还没注入，给一个明确的本地开发占位值。
 */
declare const __HAO2D_RUNTIME_VERSION__: string | undefined

export const RUNTIME_VERSION: string =
  typeof __HAO2D_RUNTIME_VERSION__ === 'string' ? __HAO2D_RUNTIME_VERSION__ : '0.0.0-dev'
