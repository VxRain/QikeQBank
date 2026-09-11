import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import 'katex/dist/katex.min.css'
import 'virtual:uno.css'

createApp(App).use(router).mount('#app')
