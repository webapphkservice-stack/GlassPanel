/** @type {import('tailwindcss').Config} */
// 强调色取自 CSS 变量，主题切换只需改写 --accent-* 即可让全站 cyan 类名跟着变化
const accent = (shade) => `rgb(var(--accent-${shade}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: accent(400),
        cyan: {
          50: accent(50),
          100: accent(100),
          200: accent(200),
          300: accent(300),
          400: accent(400),
          500: accent(500),
          600: accent(600),
          700: accent(700),
          800: accent(800),
          900: accent(900),
          950: accent(950),
        },
        success: '#00e676',
        warning: '#ffea00',
        danger: '#ff1744',
        glass: {
          bg: 'rgba(255, 255, 255, 0.08)',
          border: 'rgba(255, 255, 255, 0.18)',
        },
      },
      boxShadow: {
        glass: '0 8px 24px 0 rgba(0, 0, 0, 0.22), 0 24px 64px -12px rgba(0, 0, 0, 0.35)',
      },
      backdropBlur: {
        glass: '24px',
      },
      animation: {
        'liquid': 'liquid 4s linear infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        liquid: {
          '0%': { transform: 'translate(-50%, -50%) rotate(0deg)' },
          '100%': { transform: 'translate(-50%, -50%) rotate(360deg)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
      },
    },
  },
  plugins: [],
};
