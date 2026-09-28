import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: ['./src/index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pro Dark Tool 主题：深灰蓝底 + 青蓝强调
        ink: {
          900: '#101018',
          800: '#16161F',
          700: '#1E1E28',
          600: '#262632',
          500: '#2F2F3D'
        },
        line: '#2A2A38',
        content: {
          hi: '#E8E8F2',
          mid: '#A0A0B8',
          lo: '#6B6B82'
        },
        accent: {
          DEFAULT: '#22D3EE',
          deep: '#0EA5E9',
          violet: '#8B5CF6'
        },
        ok: '#34D399',
        warn: '#FBBF24',
        danger: '#F87171',
        bone: '#F97316'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        '3xs': ['9px', '12px'],
        'panel': ['11px', '16px']
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
