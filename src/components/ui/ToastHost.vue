/**
 * 应用内 Toast — 右下角堆叠通知（成功/错误/信息）
 * 挂载于 App.vue；由 stores/ui.js 的 toast() 驱动
 */
<template>
  <Teleport to="body">
    <TransitionGroup name="tst" tag="div" class="tst-wrap">
      <div v-for="t in ui.toasts" :key="t.id" class="tst" :class="t.type">
        <span class="tst-icon" aria-hidden="true">{{ icon(t.type) }}</span>
        <span class="tst-text">{{ t.text }}</span>
        <button type="button" class="tst-close" aria-label="关闭" @click="dismissToast(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup>
import { ui, dismissToast } from '@/stores/ui.js'

function icon(type) {
  if (type === 'success') return '✓'
  if (type === 'error') return '✕'
  return 'ℹ'
}
</script>

<style scoped>
.tst-wrap {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}
.tst {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  padding: 11px 14px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 4px solid var(--primary);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
  color: var(--text-secondary);
}
.tst.success { border-left-color: var(--success); }
.tst.error { border-left-color: var(--danger); }
.tst-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: var(--primary);
}
.tst.success .tst-icon { background: var(--success); }
.tst.error .tst-icon { background: var(--danger); }
.tst-text { line-height: 1.5; word-break: break-all; }
.tst-close {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--muted-light);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 6px;
}
.tst-close:hover { color: var(--text); background: var(--bg-accent); }

.tst-enter-active, .tst-leave-active { transition: all .2s ease; }
.tst-enter-from, .tst-leave-to { opacity: 0; transform: translateX(24px); }
.tst-move { transition: transform .2s ease; }
</style>
