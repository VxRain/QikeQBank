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

// 自动下一题停留时长归一化：非法回退 1200ms，钳制在 300–5000ms
function normalizeDelay(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1200
  return Math.min(5000, Math.max(300, Math.round(n)))
}

const saved = load()

export const settings = reactive({
  // 切换试题类型时尽量保持内容完整性（选项/答案/解析复用而非重置），默认启用
  keepContentOnTypeChange: saved.keepContentOnTypeChange ?? true,
  // 刷题模式答对后自动下一题（短暂停留展示结果），默认关闭
  autoNextOnCorrect: saved.autoNextOnCorrect ?? false,
  // 自动下一题前的停留时长（毫秒），默认 1200
  autoNextDelayMs: normalizeDelay(saved.autoNextDelayMs),
})

watch(
  () => ({ ...settings }),
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      /* 忽略持久化失败 */
    }
  },
  { deep: true }
)
