/**
 * 弹层可访问性（FE-P1-11）：Esc 关闭 / Tab 焦点圈 / 初始焦点 / 关闭后焦点归位 / 滚动锁定
 *
 * ── 为什么要抽成 composable 而不是每个弹层各写一遍 ──
 * 仓库里原本有两份手写实现（SettingsDialog 的 `trapTab`、SearchPalette 的 `onKeydown` 分支），
 * 其余弹层（ImportFileBox / Banks / ExamSheet / ExamHistory / DialogHost）**完全没有**焦点圈，
 * 也就没有「关闭后焦点回到触发元素」这一条。手写多份的必然结果就是行为分叉，
 * 而这类问题用眼睛看界面完全看不出来（Tab 一按焦点窜到背后页面才知道）。
 *
 * ── 四条规则（与 docs 的验收一一对应）──
 * 1. Esc 关闭：统一在 window 上监听（capture），弹层可用 `escDisabled` 让位给上层弹层
 * 2. 点击遮罩关闭：由弹层模板的 `@click.self` 负责（这里不动 DOM 结构）
 * 3. Tab 焦点圈：Tab / Shift+Tab 到边界回绕，焦点永不窜到背后页面
 * 4. 初始焦点 + 关闭后归位：打开时聚焦首选元素（没有就聚焦卡片本身），
 *    关闭时把焦点还给**打开前的那个元素**（用户按 Tab/空格继续操作的位置不丢）
 */

import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/** 可聚焦元素选择器（排除 disabled 与不可见） */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/** 取容器内真正可聚焦的节点（过滤 disabled / 隐藏 / 零尺寸） */
export function focusableIn(container) {
  if (!container) return []
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.disabled) return false
    if (el.offsetParent === null && el.getClientRects().length === 0) return false
    return true
  })
}

/**
 * @param {object} opts
 * @param {import('vue').Ref<boolean>} opts.isOpen 打开状态（watch 的源）
 * @param {import('vue').Ref<HTMLElement|null>} opts.containerRef 弹层卡片根节点
 * @param {import('vue').Ref<HTMLElement|null>} [opts.initialFocusRef] 首选初始焦点
 * @param {() => void} opts.onClose Esc 时调用（弹层自己的关闭函数）
 * @param {() => boolean} [opts.escDisabled] 返回 true 时忽略 Esc（让位给上层弹层）
 * @param {boolean} [opts.lockScroll] 打开期间锁定 body 滚动（默认 true）
 */
export function useDialogA11y({
  isOpen,
  containerRef,
  initialFocusRef,
  onClose,
  escDisabled,
  lockScroll = true
}) {
  let previouslyFocused = null
  let prevOverflow = ''

  function focusFirst() {
    const container = containerRef.value
    if (!container) return
    // 首选元素优先（如搜索框）；否则第一个可聚焦项；再不行就聚焦卡片本身
    const preferred = initialFocusRef?.value
    if (preferred && typeof preferred.focus === 'function' && preferred.offsetParent !== null) {
      preferred.focus()
      return
    }
    const nodes = focusableIn(container)
    if (nodes.length) {
      nodes[0].focus()
      return
    }
    if (typeof container.focus === 'function') {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')
      container.focus()
    }
  }

  /** Tab 焦点圈：到边界回绕；焦点不在容器内也拉回来 */
  function trapTab(e) {
    const container = containerRef.value
    if (!container) return
    const nodes = focusableIn(container)
    if (!nodes.length) {
      e.preventDefault()
      container.focus?.()
      return
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    const inside = container.contains(active)
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault()
      first.focus()
    }
  }

  function onKeydown(e) {
    if (!isOpen.value) return
    if (e.key === 'Tab') {
      trapTab(e)
      return
    }
    if (e.key !== 'Escape') return
    if (e.isComposing) return
    if (escDisabled?.()) return
    e.preventDefault()
    e.stopPropagation()
    onClose?.()
  }

  function attach() {
    // capture 阶段：保证弹层先拿到 Tab/Esc，不让底层页面的 keydown 抢走
    window.addEventListener('keydown', onKeydown, true)
    if (lockScroll) {
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
  }

  function detach() {
    window.removeEventListener('keydown', onKeydown, true)
    if (lockScroll) document.body.style.overflow = prevOverflow
  }

  watch(
    isOpen,
    async (v) => {
      if (v) {
        // 记录「谁打开的」：关闭后要还给它（触发按钮可能是工具栏图标钮）
        previouslyFocused = document.activeElement
        attach()
        await nextTick()
        focusFirst()
      } else {
        detach()
        const back = previouslyFocused
        previouslyFocused = null
        if (back && typeof back.focus === 'function' && document.contains(back)) {
          // 等一帧：关闭动画/子树卸载过程中聚焦会丢
          await nextTick()
          back.focus()
        }
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    detach()
  })

  return { focusFirst, trapTab }
}

/**
 * Toast 可访问性（FE-P1-11）：`role="status"` + `aria-live="polite"`。
 *
 * 为什么不用 `aria-live="assertive"`：错误 toast 会打断屏幕阅读器正在读的题目内容，
 * 而用户此时最需要听到的恰好是题面。polite 会等当前朗读结束再播报，体验更合理。
 * 容器固定 `aria-live` 区域（而不是每条 toast 各带一个 live region），
 * 因为后者在条目进出时反复创建 live region，多数实现会漏播。
 */
export const TOAST_CONTAINER_ATTRS = Object.freeze({
  role: 'status',
  'aria-live': 'polite',
  'aria-atomic': 'false'
})

/** 供测试断言：单条 toast 的类型 → 屏幕阅读器文案前缀（图标已 aria-hidden） */
export function toastSrLabel(type) {
  if (type === 'success') return '成功'
  if (type === 'error') return '错误'
  return '提示'
}

export { FOCUSABLE }
