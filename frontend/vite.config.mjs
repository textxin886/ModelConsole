import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物输出到仓库根的 web/，由 index.js 以 /admin 前缀静态服务
export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  build: {
    outDir: '../web',
    emptyOutDir: true,
  },
})
