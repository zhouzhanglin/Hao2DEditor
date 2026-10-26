import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@importers': resolve(__dirname, 'src/importers'),
      '@render': resolve(__dirname, 'src/render'),
      '@editor': resolve(__dirname, 'src/editor'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@i18n': resolve(__dirname, 'src/i18n'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // 固定简中：i18n 默认按 navigator.language 猜，英文系统上断言中文文案的用例会假失败
    setupFiles: ['tests/setup.ts']
  }
})
