import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@core': resolve(__dirname, 'src/core'),
  '@importers': resolve(__dirname, 'src/importers'),
  '@render': resolve(__dirname, 'src/render'),
  '@editor': resolve(__dirname, 'src/editor'),
  '@ui': resolve(__dirname, 'src/ui'),
  '@i18n': resolve(__dirname, 'src/i18n'),
  '@shared': resolve(__dirname, 'src/shared')
}

export default defineConfig({
  main: {
    /*
     * spine 官方运行时要以 `?raw` 内联进主进程包（在线预览页由本地服务直接把它发给浏览器，不依赖外网）。
     * 默认的 externalizeDepsPlugin 会把 `@esotericsoftware/spine-core/...` 当外部依赖，`?raw` 就不生效了，
     * 所以把它排除在外部化之外，让构建期真的把源码读成字符串打进来。
     */
    plugins: [externalizeDepsPlugin({ exclude: ['@esotericsoftware/spine-core'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: { alias }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    resolve: { alias },
    server: {
      host: '0.0.0.0',
      allowedHosts: true,
      port: 5273
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    }
  }
})
