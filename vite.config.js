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
    // tauri dev 下 vite 会监听项目文件，排除构建产物与打包目录：
    // - src-tauri/target：Rust 产物，Windows 下 watch dll 会 EBUSY 崩溃
    // - dist / dist-portable：打包产物；便携版内的 EBWebView 数据目录含被 WebView 独占的
    //   Cookies/Network 文件，watch 会 EBUSY 直接把 dev server 打挂（e2e 白跑的真因）
    watch: { ignored: ['**/src-tauri/target/**', '**/node_modules/**', '**/dist/**', '**/dist-portable/**'] }
  }
})
