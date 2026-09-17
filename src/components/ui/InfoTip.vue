/**
 * 通用说明气泡（InfoTip）— 把过长的功能描述收进 ⓘ 悬停提示
 * 用法：传 text 属性或默认 slot 二选一，slot 优先
 * 触发：鼠标悬停 / 键盘聚焦 / 触摸点击；移开、失焦或按 Esc 关闭
 * 视觉：复用 App.vue :root 变量（--card/--line/--text/--shadow-lg），与全局弹层同语言
 * 定位：气泡 Teleport 到 body 用 fixed 定位（按触发元素 rect 计算），不受任何
 * overflow 祖先裁剪；打开期间滚动/resize 会跟随重算
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
    <Teleport to="body">
      <Transition name="info-tip-fade">
        <span v-show="open" class="info-tip-bubble teleported" :class="`place-${placement}`" :style="bubbleStyle" role="tooltip">
          <slot>{{ text }}</slot>
        </span>
      </Transition>
    </Teleport>
  </span>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

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
const pos = ref({ left: 0, top: 0, transform: '' })

const bubbleStyle = computed(() => ({
  position: 'fixed',
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
  transform: pos.value.transform,
  maxWidth: props.maxWidth,
}))

/** 按触发元素 rect 计算气泡 fixed 坐标（top/bottom 水平居中并钳制在视口内） */
function calcPos() {
  const el = rootEl.value
  if (!el || !el.getBoundingClientRect) return
  const r = el.getBoundingClientRect()
  const half = Math.min(260, window.innerWidth / 2 - 8) / 2
  const cx = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
  const cy = r.top + r.height / 2
  const gap = 8
  switch (props.placement) {
    case 'bottom':
      pos.value = { left: cx, top: r.bottom + gap, transform: 'translate(-50%, 0)' }
      break
    case 'left':
      pos.value = { left: r.left - gap, top: cy, transform: 'translate(-100%, -50%)' }
      break
    case 'right':
      pos.value = { left: r.right + gap, top: cy, transform: 'translate(0, -50%)' }
      break
    default:
      pos.value = { left: cx, top: r.top - gap, transform: 'translate(-50%, -100%)' }
  }
}

function onScrollResize() {
  if (open.value) calcPos()
}

watch(open, (v) => {
  if (v) {
    nextTick(calcPos)
    window.addEventListener('scroll', onScrollResize, true)
    window.addEventListener('resize', onScrollResize)
  } else {
    window.removeEventListener('scroll', onScrollResize, true)
    window.removeEventListener('resize', onScrollResize)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScrollResize, true)
  window.removeEventListener('resize', onScrollResize)
})
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
  z-index: 1200;
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
/* Teleport 到 body 后：锚定属性全部复位，坐标走内联 fixed */
.info-tip-bubble.teleported {
  bottom: auto;
  top: auto;
  left: auto;
  right: auto;
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
.place-top::after {
  top: 100%;
  left: 50%;
  margin: -5px 0 0 -5px;
  border-top: none;
  border-left: none;
  transform: rotate(45deg);
}
.place-bottom::after {
  bottom: 100%;
  left: 50%;
  margin: 0 0 -5px -5px;
  border-bottom: none;
  border-right: none;
  transform: rotate(45deg);
}
.place-left::after {
  left: 100%;
  top: 50%;
  margin: -5px 0 0 -5px;
  border-bottom: none;
  border-left: none;
  transform: rotate(45deg);
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
  transition: opacity 0.15s ease;
}
.info-tip-fade-enter-from,
.info-tip-fade-leave-to {
  opacity: 0;
}
</style>
