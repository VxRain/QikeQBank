import { reactive, watch } from 'vue'

// 应用设置：localStorage 持久化（key 独立于题库记忆）
const KEY = 'qbank.settings.v1'

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {}
  } catch {
    return {}
  }
}

const saved = load()

export const settings = reactive({
  // 切换试题类型时尽量保持内容完整性（选项/答案/解析复用而非重置），默认启用
  keepContentOnTypeChange: saved.keepContentOnTypeChange ?? true,
})

watch(
  () => settings.keepContentOnTypeChange,
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ keepContentOnTypeChange: v }))
    } catch {
      /* 忽略持久化失败 */
    }
  }
)
