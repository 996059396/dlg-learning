import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import viteCompression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    react(),
    // compare60 C06/C16：构建时预生成 .br/.gz，express.static 自动伺服（大 JS chunk
    // 271KB → brotli 约 68KB），减少服务器端压缩 CPU 与首屏时间。
    viteCompression({ algorithm: 'brotliCompress', threshold: 10240, deleteOriginFile: false }),
    viteCompression({ algorithm: 'gzip', threshold: 10240, deleteOriginFile: false }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
