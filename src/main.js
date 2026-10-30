import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import 'katex/dist/katex.min.css'
import 'virtual:uno.css'
// FE-ARCH-08 性能辅助类（content-visibility 等），需早于组件样式生效
import './styles/perf.css'

// 去网页感：全局禁用右键菜单；输入框 / 文本域 / 富文本编辑区保留原生菜单（复制粘贴）
window.addEventListener('contextmenu', (e) => {
  const t = e.target instanceof Element ? e.target : null
  if (t && t.closest('input, textarea, select, [contenteditable], .tiptap, .ProseMirror')) return
  e.preventDefault()
}, { capture: true })

createApp(App).use(router).mount('#app')
