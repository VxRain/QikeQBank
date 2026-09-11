import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [UnoCSS(), vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // tauri dev 下 vite 会监听项目文件，排除 Rust 构建产物（Windows 下 watch dll 会 EBUSY 崩溃）
    watch: { ignored: ['**/src-tauri/target/**', '**/node_modules/**'] }
  }
})
