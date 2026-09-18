// 本机设备身份：墓碑 actor 与未来同步游标用。localStorage 持久化，懒创建。
const KEY = 'qbank.device_id.v1'

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* 回退下行 */
  }
  // 回退：时间戳 + 随机数（非密码学用途，仅作设备区分）
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let cached = null

export function getDeviceId() {
  if (cached) return cached
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) {
      cached = saved
      return cached
    }
  } catch {
    /* 无存储时每次回退生成 */
  }
  cached = randomId()
  try {
    localStorage.setItem(KEY, cached)
  } catch {
    /* 忽略持久化失败 */
  }
  return cached
}
