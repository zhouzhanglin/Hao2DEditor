import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: ['./src/index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * macOS 暗色（Finder 观感）取色。
         *
         * 取值来自 Finder 暗色窗口截图**实拍采样**：内容底 #232323~#2B2B2B（受窗口
         * 透明度影响会有偏移，这里归一到中性灰）、正文近白 #D7D8D7、选中蓝 #1E5CCA、
         * 文件夹图标蓝 #79CBF8。其余用 macOS 系统色暗色版（蓝 #0A84FF / 绿 #30D158 /
         * 黄橙 #FF9F0A / 红 #FF453A / 紫 #BF5AF2）。
         *
         * 强调色拆成两个是**必须**的：`accent` 当文字/线条用（播放头、关键帧、激活
         * 图标），要在 #242426 上可读（对比度 ≈ 5.2:1）；而整行选中要的是实拍那个
         * 更深的 #1E5CCA（`accent-deep`），拿它当文字几乎看不见。
         */
        ink: {
          900: '#1A1A1C', // 最深：视口井、输入框内底
          800: '#242426', // 面板底（窗口内容底色）
          700: '#2C2C2E', // 工具条 / 表头 / 输入框
          600: '#37373A', // hover（≈ 白色 8% 叠加）
          500: '#48484A' // pressed
        },
        line: '#333335',
        content: {
          // 比 macOS 原生次级灰再亮一档：编辑器信息密度高，太淡会看不清
          hi: '#F0F0F2',
          mid: '#B4B4B9',
          lo: '#8E8E93'
        },
        accent: {
          DEFAULT: '#0A84FF',
          deep: '#1E5CCA',
          violet: '#BF5AF2'
        },
        ok: '#30D158',
        warn: '#FF9F0A',
        danger: '#FF453A',
        bone: '#E0A45C'
      },
      fontFamily: {
        // macOS 系统字：-apple-system 在 mac 上就是 SF Pro，无需再排 Inter
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '15px'],
        '3xs': ['10px', '13px'],
        panel: ['12px', '16px']
      },
      transitionDuration: {
        panel: '150ms'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        glow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34,211,238,0.35)' },
          '50%': { boxShadow: '0 0 12px 1px rgba(34,211,238,0.45)' }
        }
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
        glow: 'glow 2.4s ease-in-out infinite'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}

export default config
