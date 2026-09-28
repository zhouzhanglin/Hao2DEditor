import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 纯浏览器模式：仅用于在没有 Electron 外壳时调试渲染层与自动化验证。
 * 此时 window.hao 不存在，ui 层会退化为内存文件服务。
 */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [react()],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@importers': resolve(__dirname, 'src/importers'),
      '@render': resolve(__dirname, 'src/render'),
      '@editor': resolve(__dirname, 'src/editor'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5274
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  }
})
