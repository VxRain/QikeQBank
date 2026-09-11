/**
 * 应用内 Toast — 右下角堆叠通知（成功/错误/信息）
 * 挂载于 App.vue；由 stores/ui.js 的 toast() 驱动
 */
<template>
  <Teleport to="body">
    <TransitionGroup name="tst" tag="div" class="fixed right-4.5 bottom-4.5 z-[1100] flex flex-col gap-2.5 pointer-events-none">
      <div v-for="t in ui.toasts" :key="t.id" class="tst pointer-events-auto flex items-center gap-2.5 max-w-[380px] px-3.5 py-2.75 rounded-[12px] bg-card border border-line border-l-4 border-l-primary shadow-lg text-[13px] text-text-secondary" :class="t.type">
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

function iconClass(type) {
  if (type === 'success') return 'i-lucide-check'
  if (type === 'error') return 'i-lucide-x'
  return 'i-lucide-info'
}
</script>

<style scoped>
.tst.success { border-left-color: var(--success); }
.tst.error { border-left-color: var(--danger); }
.tst.success .tst-icon { background: var(--success); }
.tst.error .tst-icon { background: var(--danger); }
.tst-enter-active, .tst-leave-active { transition: all .2s ease; }
.tst-enter-from, .tst-leave-to { opacity: 0; transform: translateX(24px); }
.tst-move { transition: transform .2s ease; }
</style>
