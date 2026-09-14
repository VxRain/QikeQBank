/**
 * 通用说明气泡（InfoTip）— 把过长的功能描述收进 ⓘ 悬停提示
 * 用法：传 text 属性或默认 slot 二选一，slot 优先
 * 触发：鼠标悬停 / 键盘聚焦 / 触摸点击；移开、失焦或按 Esc 关闭
 * 视觉：复用 App.vue :root 变量（--card/--line/--text/--shadow-lg），与全局弹层同语言
 */
<template>
  <span
    ref="rootEl"
    class="info-tip"
    tabindex="0"
    :aria-label="tipText"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focus="open = true"
    @blur="open = false"
    @click.stop="open = !open"
    @keydown.esc="open = false"
  >
    <i class="i-lucide-info info-tip-icon" aria-hidden="true" />
    <Transition name="info-tip-fade">
      <span v-show="open" class="info-tip-bubble" :class="`place-${placement}`" :style="{ maxWidth }" role="tooltip">
        <slot>{{ text }}</slot>
      </span>
    </Transition>
  </span>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  /** 详细说明文本（与默认 slot 二选一，slot 优先） */
  text: { type: String, default: '' },
  /** 气泡方向：top | bottom | left | right */
  placement: { type: String, default: 'top' },
  /** 气泡最大宽度 */
  maxWidth: { type: String, default: '260px' }
})

const open = ref(false)
const rootEl = ref(null)
const tipText = computed(() => props.text || '查看说明')
</script>

<style scoped>
.info-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  outline: none;
  cursor: help;
}
.info-tip-icon {
  font-size: 14px;
  color: var(--muted-light);
  transition: color 0.15s ease;
}
.info-tip:hover .info-tip-icon,
.info-tip:focus-visible .info-tip-icon {
  color: var(--primary);
}
.info-tip-bubble {
  position: absolute;
  z-index: 60;
  width: max-content;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
  text-align: left;
  white-space: normal;
  word-break: break-word;
  color: var(--text-secondary);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  pointer-events: none;
}
/* 小箭头 */
.info-tip-bubble::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--card);
  border: 1px solid var(--line);
}
.place-top {
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
}
.place-top::after {
  top: 100%;
  left: 50%;
  margin: -5px 0 0 -5px;
  border-top: none;
  border-left: none;
  transform: rotate(45deg);
}
.place-bottom {
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
}
.place-bottom::after {
  bottom: 100%;
  left: 50%;
  margin: 0 0 -5px -5px;
  border-bottom: none;
  border-right: none;
  transform: rotate(45deg);
}
.place-left {
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
}
.place-left::after {
  left: 100%;
  top: 50%;
  margin: -5px 0 0 -5px;
  border-bottom: none;
  border-left: none;
  transform: rotate(45deg);
}
.place-right {
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
}
.place-right::after {
  right: 100%;
  top: 50%;
  margin: -5px -5px 0 0;
  border-top: none;
  border-right: none;
  transform: rotate(45deg);
}
.info-tip-fade-enter-active,
.info-tip-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.place-top.info-tip-fade-enter-from,
.place-top.info-tip-fade-leave-to,
.place-bottom.info-tip-fade-enter-from,
.place-bottom.info-tip-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
.place-left.info-tip-fade-enter-from,
.place-left.info-tip-fade-leave-to,
.place-right.info-tip-fade-enter-from,
.place-right.info-tip-fade-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(4px);
}
</style>
