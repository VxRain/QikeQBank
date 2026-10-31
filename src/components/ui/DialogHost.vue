/**
 * 应用内弹层（confirm / prompt）— 全屏遮罩 + 居中卡片 + 入场动画
 * 挂载于 App.vue；由 stores/ui.js 驱动，替代浏览器原生 confirm()/prompt()
 */
<template>
  <Teleport to="body">
    <Transition name="dg">
      <div v-if="ui.dialog" class="dg-mask fixed inset-0 z-[1050] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="onCancel">
        <div
          ref="cardEl"
          class="dg-card w-[min(420px,calc(100vw-48px))] bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5"
          role="dialog"
          aria-modal="true"
          :aria-label="ui.dialog.title"
          tabindex="-1"
        >
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

          <select
            v-if="ui.dialog.type === 'select'"
            ref="inputEl"
            v-model="inputValue"
            class="select w-full mb-4"
          >
            <option value="" disabled>请选择…</option>
            <option v-for="o in ui.dialog.options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <div class="flex justify-end gap-2.5">
            <button type="button" class="btn" @click="onCancel">{{ ui.dialog.cancelText }}</button>
            <button
              type="button"
              data-dialog-ok
              class="btn"
              :class="ui.dialog.danger ? 'btn-danger' : 'btn-primary'"
              :disabled="(ui.dialog.type === 'prompt' || ui.dialog.type === 'select') && !inputValue.trim()"
              @click="onOk"
            >{{ ui.dialog.okText }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, computed, nextTick } from 'vue'
import { ui, closeDialog } from '@/stores/ui.js'
import { useDialogA11y } from '@/composables/useDialogA11y.js'

const inputValue = ref('')
const inputEl = ref(null)

watch(
  () => ui.dialog,
  async (d) => {
    if (d) {
      inputValue.value = d.initial || ''
      await nextTick()
    }
  }
)

/**
 * FE-P1-11：弹层可访问性统一走 composable。
 *
 * 为什么替换掉原来手写的 `window.addEventListener('keydown')`：
 * 那份实现只有 Esc，没有 Tab 焦点圈，也没有「关闭后焦点回到触发元素」——
 * 用户点「删除」确认后焦点落到 body 顶部，键盘操作断裂。
 * 初始焦点：prompt/select 落到输入框（要输入），confirm 落到主按钮（Enter 直接确认）。
 */
const cardEl = ref(null)
useDialogA11y({
  isOpen: computed(() => !!ui.dialog),
  containerRef: cardEl,
  initialFocusRef: computed(() => {
    const d = ui.dialog
    if (!d) return null
    if ((d.type === 'prompt' || d.type === 'select') && inputEl.value) return inputEl.value
    // confirm：聚焦主按钮，符合「回车确认」的预期；找不到就交给默认逻辑（第一个可聚焦项）
    return cardEl.value?.querySelector('[data-dialog-ok]') || null
  }),
  onClose: () => onCancel()
})

function onOk() {
  const d = ui.dialog
  if (!d) return
  if (d.type === 'prompt') {
    if (!inputValue.value.trim()) return
    closeDialog(inputValue.value)
  } else if (d.type === 'select') {
    if (!inputValue.value.trim()) return
    closeDialog(inputValue.value)
  } else {
    closeDialog(true)
  }
}

function onCancel() {
  closeDialog(null)
}


</script>

<style scoped>
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
