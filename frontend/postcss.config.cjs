module.exports = {
  // 是什么：PostCSS 插件配置。
  // 做什么：在 Vite 构建阶段执行 Tailwind 与 Autoprefixer。
  // 为什么：让 utility class 在构建时落地为静态 CSS，避免依赖浏览器运行时脚本。
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
