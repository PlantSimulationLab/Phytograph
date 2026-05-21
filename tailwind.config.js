/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        dark: '#0a0a0a',
        glass: 'rgba(255, 255, 255, 0.05)',
        'glass-border': 'rgba(255, 255, 255, 0.1)',
      },
      backdropBlur: {
        xs: '2px',
        xl: '20px',
        '2xl': '40px',
      },
      animation: {
        float: 'float 30s ease-in-out infinite',
        'float-slow': 'float 40s ease-in-out infinite',
        'float-delayed': 'float 30s ease-in-out 5s infinite',
        glow: 'glow 4s ease-in-out infinite',
        'electric-jolt': 'electric-jolt 0.4s ease-out',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translate(0, 0) rotate(0deg)' },
          '33%': { transform: 'translate(30px, -30px) rotate(120deg)' },
          '66%': { transform: 'translate(-20px, 20px) rotate(240deg)' },
        },
        glow: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.5 },
        },
        'electric-jolt': {
          '0%': { opacity: 0, transform: 'scale(0.8) rotate(0deg)' },
          '50%': { opacity: 1, transform: 'scale(1.2) rotate(180deg)' },
          '100%': { opacity: 0, transform: 'scale(1) rotate(360deg)' },
        },
      },
      boxShadow: {
        glow: '0 0 60px 20px rgba(255, 255, 255, 0.05)',
        'glow-lg': '0 0 100px 40px rgba(255, 255, 255, 0.08)',
      },
    },
  },
  plugins: [],
};
