// vitest 配置 —— 纯逻辑模块单测（utils/：api / offlineQueue / sessionCache）+ 组件测试
// （context/GameContext 用 jsdom，per-file pragma）。必须带 @vitejs/plugin-react 以启用
// automatic JSX runtime，否则 .jsx 编译成 React.createElement 而 React 不在作用域内。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
