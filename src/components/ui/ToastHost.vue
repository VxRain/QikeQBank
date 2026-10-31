/**
 * 应用内 Toast — 右下角堆叠通知（成功/错误/信息）
 * 挂载于 App.vue；由 stores/ui.js 的 toast() 驱动
 */
<template>
  <Teleport to="body">
    <!-- FE-P1-11：Toast 必须是 live region，否则屏幕阅读器用户完全听不到反馈。
         用 polite 而非 assertive：错误提示打断正在朗读的题面反而更糟。
         live region 只声明一次（挂在容器上），逐条声明会导致反复创建 live region 而漏播。 -->
    <TransitionGroup
      name="tst"
      tag="div"
      class="fixed right-4.5 bottom-4.5 z-[1100] flex flex-col gap-2.5 pointer-events-none"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      <div v-for="t in ui.toasts" :key="t.id" class="tst pointer-events-auto flex items-center gap-2.5 max-w-[380px] px-3.5 py-2.75 rounded-[12px] bg-card border border-line border-l-4 border-l-primary shadow-lg text-[13px] text-text-secondary" :class="t.type">
        <!-- 类型对屏幕阅读器不可见（图标 aria-hidden），这里补一个纯视觉隐藏的前缀 -->
        <span class="sr-only">{{ srLabel(t.type) }}</span>
        <span class="tst-icon shrink-0 w-5 h-5 inline-flex items-center justify-center rounded-full text-white bg-primary" aria-hidden="true">
          <i :class="iconClass(t.type)" class="text-[12px]" />
        </span>
        <span class="leading-[1.5] break-all">{{ t.text }}</span>
        <button type="button" class="shrink-0 border-none bg-transparent text-muted-light cursor-pointer text-[11px] px-1 py-0.5 rounded-[6px] transition-colors duration-150 hover:text-text hover:bg-bg-accent" aria-label="关闭" @click="dismissToast(t.id)"><i class="i-lucide-x" /></button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup>
import { ui, dismissToast } from '@/stores/ui.js'
import { toastSrLabel } from '@/composables/useDialogA11y.js'

/** 类型前缀（读屏用）。视觉上被 .sr-only 隐藏，不占位。 */
function srLabel(type) {
  return toastSrLabel(type)
}

function iconClass(type) {
  if (type === 'success') return 'i-lucide-check'
  if (type === 'error') return 'i-lucide-x'
  return 'i-lucide-info'
}
</script>

<style scoped>
/* 仅供屏幕阅读器的文本（视觉隐藏但仍在可访问性树里） */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.tst.success { border-left-color: var(--success); }
.tst.error { border-left-color: var(--danger); }
.tst.success .tst-icon { background: var(--success); }
.tst.error .tst-icon { background: var(--danger); }
.tst-enter-active, .tst-leave-active { transition: all .2s ease; }
.tst-enter-from, .tst-leave-to { opacity: 0; transform: translateX(24px); }
.tst-move { transition: transform .2s ease; }
</style>
