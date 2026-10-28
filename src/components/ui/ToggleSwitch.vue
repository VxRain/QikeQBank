/**
 * 开关视觉件（纯展示，不含交互）
 * 交互由父级 role=switch 的可点击行承担，避免嵌套可点击元素
 * 用法：ToggleSwitch :model-value="x" —— 颜色/圆点位移复用全局 CSS 变量
 */
<template>
  <span
    class="toggle-switch shrink-0 relative rounded-full transition-colors duration-150"
    :class="[modelValue ? 'bg-primary' : 'bg-[var(--line-strong)]', sizeClass]"
    aria-hidden="true"
  >
    <span
      class="toggle-knob absolute rounded-full bg-white shadow transition-all duration-150"
      :class="[sizeClass === 'small' ? 'knob-small' : 'knob-normal', modelValue ? 'on' : 'off']"
    />
  </span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** normal: 40×22 | small: 32×18 */
  size: { type: String, default: 'normal' }
})

const sizeClass = computed(() => (props.size === 'small' ? 'small' : ''))
</script>

<style scoped>
.toggle-switch {
  width: 40px;
  height: 22px;
}
.toggle-switch.small {
  width: 32px;
  height: 18px;
}
.toggle-knob {
  width: 16px;
  height: 16px;
  top: 3px;
}
.knob-normal.off {
  left: 3px;
}
.knob-normal.on {
  left: 21px;
}
.knob-small {
  width: 12px;
  height: 12px;
  top: 3px;
}
.knob-small.off {
  left: 3px;
}
.knob-small.on {
  left: 17px;
}
</style>
