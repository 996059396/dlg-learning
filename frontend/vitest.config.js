// vitest 配置 —— 纯逻辑模块单测（utils/：api / offlineQueue / sessionCache）。
// 环境用 node，不给 jsdom：三个模块只依赖 localStorage + fetch + crypto，
// 由 test/setup.js 提供最小 polyfill，不引入重 DOM 依赖。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/*.test.js'],
  },
});
