import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 4700,
    proxy: {
      // 开发期将 /api 代理到 EBMS 后端
      '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
  },
});
