/** @type {import('tailwindcss').Config} */
module.exports = {
  // 是什么：Tailwind 内容扫描配置。
  // 做什么：扫描前端 HTML/TS/TSX 文件中的类名，生成实际需要的样式。
  // 为什么：替代外链 CDN 运行时解析，确保本地构建产物自带完整样式。
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './contexts/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
