/**
 * 会话离开提示（FE-P0-04 收口）
 *
 * 设计取舍：**只提示、不拦路**。
 * 进度已经由 stores/session.js 落进 sessionStorage，离开不会真的丢东西；
 * 再用 confirmDialog 拦一道，只会变成「每次切页都要点一下」的噪音。
 * 所以这里只在离开瞬间弹一条 toast（toast 在 App 根节点，跨路由存活），
 * 告诉用户「进度保住了，下次能接着来」。
 *
 * 真正的拦截型确认只留在「有未保存编辑内容」的场景（Form.vue 的 FE-P0-03）。
 */
import { onBeforeRouteLeave } from 'vue-router'
import { toast } from '@/stores/ui.js'

/**
 * 注册离开提示。
 * @param {() => boolean} isActive 当前是否处于进行中（例如 phase === 'card'）
 * @param {string} text 提示文案
 * @param {{before?: () => void}} [opts] before：离开前先落盘一次（同步动作）
 */
export function useSessionLeaveNotice(isActive, text, opts = {}) {
  onBeforeRouteLeave(() => {
    if (!isActive()) return true
    try {
      opts.before?.()
    } catch (e) {
      console.error(e)
    }
    toast(text, 'info', 4000)
    return true // 不拦路
  })
}
