/**
 * 应用内弹层（confirm / prompt）— 全屏遮罩 + 居中卡片 + 入场动画
 * 挂载于 App.vue；由 stores/ui.js 驱动，替代浏览器原生 confirm()/prompt()
 */
<template>
  <Teleport to="body">
    <Transition name="dg">
      <div v-if="ui.dialog" class="dg-mask" @click.self="onCancel">
        <div class="dg-card" role="dialog" :aria-label="ui.dialog.title">
          <h3 class="dg-title">{{ ui.dialog.title }}</h3>
          <p v-if="ui.dialog.message" class="dg-msg">{{ ui.dialog.message }}</p>

          <input
            v-if="ui.dialog.type === 'prompt'"
            ref="inputEl"
            v-model="inputValue"
            class="dg-input"
            type="text"
            :placeholder="ui.dialog.placeholder"
            @keyup.enter="onOk"
            @keyup.esc="onCancel"
          />

          <div class="dg-actions">
            <button type="button" class="btn" @click="onCancel">{{ ui.dialog.cancelText }}</button>
            <button
              type="button"
              class="btn ok"
              :class="{ danger: ui.dialog.danger }"
              :disabled="ui.dialog.type === 'prompt' && !inputValue.trim()"
              @click="onOk"
            >{{ ui.dialog.okText }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { ui, closeDialog } from '@/stores/ui.js'

const inputValue = ref('')
const inputEl = ref(null)

watch(
  () => ui.dialog,
  async (d) => {
    if (d) {
      inputValue.value = d.initial || ''
      await nextTick()
      if (d.type === 'prompt' && inputEl.value) inputEl.value.focus()
    }
  }
)

function onOk() {
  const d = ui.dialog
  if (!d) return
  if (d.type === 'prompt') {
    if (!inputValue.value.trim()) return
    closeDialog(inputValue.value)
  } else {
    closeDialog(true)
  }
}

function onCancel() {
  closeDialog(null)
}

function onKey(e) {
  if (!ui.dialog) return
  if (e.key === 'Escape') onCancel()
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.dg-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.dg-card {
  width: min(420px, calc(100vw - 48px));
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 40px rgba(2, 6, 23, 0.25), 0 4px 12px rgba(2, 6, 23, 0.12);
  padding: 22px 24px 18px;
}
.dg-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
}
.dg-msg {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-line;
}
.dg-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  border-color: var(--line-strong);
  background: var(--card);
  color: var(--text);
  font-size: 14px;
  outline: none;
  margin-bottom: 16px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dg-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.15);
}
.dg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn {
  padding: 8px 18px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all .15s ease;
  box-shadow: var(--shadow-sm);
}
.btn:hover { background: var(--bg-accent); border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow); }
.btn.ok { background: var(--text); color: #fff; border-color: var(--text); }
.btn.ok:hover { background: #1e293b; }
.btn.ok.danger { background: var(--danger); border-color: var(--danger); }
.btn.ok.danger:hover { background: #dc2626; }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
