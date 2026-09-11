/**
 * 应用内弹层（confirm / prompt）— 全屏遮罩 + 居中卡片 + 入场动画
 * 挂载于 App.vue；由 stores/ui.js 驱动，替代浏览器原生 confirm()/prompt()
 */
<template>
  <Teleport to="body">
    <Transition name="dg">
      <div v-if="ui.dialog" class="dg-mask fixed inset-0 z-[1050] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="onCancel">
        <div class="dg-card w-[min(420px,calc(100vw-48px))] bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5" role="dialog" :aria-label="ui.dialog.title">
          <h3 class="m-0 mb-2 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)]">{{ ui.dialog.title }}</h3>
          <p v-if="ui.dialog.message" class="m-0 mb-3.5 text-[14px] leading-[1.7] text-text-secondary whitespace-pre-line break-all">{{ ui.dialog.message }}</p>

          <input
            v-if="ui.dialog.type === 'prompt'"
            ref="inputEl"
            v-model="inputValue"
            class="input w-full mb-4"
            type="text"
            :placeholder="ui.dialog.placeholder"
            @keyup.enter="onOk"
            @keyup.esc="onCancel"
          />

          <div class="flex justify-end gap-2.5">
            <button type="button" class="btn" @click="onCancel">{{ ui.dialog.cancelText }}</button>
            <button
              type="button"
              class="btn"
              :class="ui.dialog.danger ? 'btn-danger' : 'btn-primary'"
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
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
