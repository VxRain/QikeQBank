/**
 * 单个设置行的通用渲染器（switch / number / text / select / segmented / custom / note）
 * 只认 registry.js 里的 item 契约，自身不含任何具体业务，新增设置项无需改本文件
 */
<template>
  <!-- 自定义面板：整块交给组件自己排版 -->
  <component :is="item.component" v-if="item.type === 'custom'" v-bind="item.props || {}" />

  <!-- 说明块（分组小标题 / 注意事项） -->
  <p v-else-if="item.type === 'note'" class="setting-note">{{ item.title }}</p>

  <!-- 开关整行可点 -->
  <button
    v-else-if="item.type === 'switch'"
    type="button"
    role="switch"
    :aria-checked="!!item.value()"
    class="setting-row setting-row--click"
    :class="{ 'setting-row--sub': item.indent }"
    @click="item.set(!item.value())"
  >
    <span class="setting-main">
      <span class="setting-title">
        {{ item.title }}
        <InfoTip v-if="item.desc" :text="item.desc" placement="left" />
      </span>
      <span v-if="hint" class="setting-hint">{{ hint }}</span>
    </span>
    <ToggleSwitch :model-value="!!item.value()" />
  </button>

  <!-- 其余控件：左标题 + 右控件 -->
  <div v-else class="setting-row" :class="{ 'setting-row--sub': item.indent }">
    <span class="setting-main">
      <span class="setting-title">
        {{ item.title }}
        <InfoTip v-if="item.desc" :text="item.desc" placement="left" />
      </span>
      <span v-if="hint" class="setting-hint">{{ hint }}</span>
    </span>

    <span class="setting-control">
      <!-- 数值 -->
      <template v-if="item.type === 'number' || item.type === 'text'">
        <input
          v-model="draft"
          class="input px-2 py-1.5 text-[13px] text-center"
          :class="item.width || 'w-[84px]'"
          type="text"
          :inputmode="item.type === 'number' ? 'decimal' : 'text'"
          autocomplete="off"
          spellcheck="false"
          :placeholder="item.placeholder || ''"
          @focus="onFocus"
          @change="commit"
          @blur="commit"
          @keyup.enter="commit"
          @keyup.esc="revert"
        />
        <span v-if="item.unit" class="setting-unit">{{ item.unit }}</span>
      </template>

      <!-- 下拉 -->
      <select
        v-else-if="item.type === 'select'"
        class="select px-2 py-1.5 pr-7 text-[13px]"
        :value="item.value()"
        @change="onSelect"
      >
        <option v-for="o in item.options" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
      </select>

      <!-- 分段按钮 -->
      <span v-else-if="item.type === 'segmented'" class="setting-segmented">
        <button
          v-for="o in item.options"
          :key="String(o.value)"
          type="button"
          class="setting-segmented-btn"
          :class="{ 'is-active': String(item.value()) === String(o.value) }"
          :aria-pressed="String(item.value()) === String(o.value)"
          @click="item.set(o.value)"
        >{{ o.label }}</button>
      </span>
    </span>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { isItemVisible } from './registry.js'
import { toast } from '@/stores/ui.js'

const props = defineProps({
  item: { type: Object, required: true }
})

/** 依赖项未开启（如「停留时长」需要「答对自动下一题」）：搜索态下给出说明而不是静默隐藏 */
const hint = computed(() => {
  if (isItemVisible(props.item)) return ''
  return props.item.dependsOn ? `需先开启「${props.item.dependsOn}」` : props.item.hiddenHint || ''
})

const draft = ref('')

function fmt(v) {
  if (v === null || v === undefined || v === '') return ''
  if (props.item.type === 'number') {
    const n = Number(v)
    if (!Number.isFinite(n)) return ''
    return props.item.decimals != null ? String(Number(n.toFixed(props.item.decimals))) : String(n)
  }
  return String(v)
}

// custom / note 类目没有 value()，只在可控控件上跟踪 store 值
const tracked = computed(() => (typeof props.item.value === 'function' ? props.item.value() : undefined))

watch(
  tracked,
  (v) => {
    draft.value = fmt(v)
  },
  { immediate: true }
)

function revert() {
  draft.value = fmt(typeof props.item.value === 'function' ? props.item.value() : '')
}
function onFocus(e) {
  e.target.select?.()
}
function commit() {
  const it = props.item
  if (it.type === 'number') {
    const raw = String(draft.value).trim()
    const n = Number(raw)
    const min = it.min ?? -Infinity
    const max = it.max ?? Infinity
    const needInt = it.integer ?? it.decimals == null
    const ok = raw !== '' && Number.isFinite(n) && n >= min && n <= max && (!needInt || Number.isInteger(n))
    if (!ok) {
      revert()
      toast(it.invalidMsg || '数值不合法', 'error')
      return
    }
    it.set(n)
  } else {
    const res = it.normalize ? it.normalize(draft.value) : { ok: true, value: draft.value }
    if (!res.ok) {
      revert()
      toast(res.msg || '输入不合法', 'error')
      return
    }
    it.set(res.value)
  }
  // 以 store 归一化后的值为准回填（如步长 1M → 1m、钳制后的数值）
  revert()
}
function onSelect(e) {
  const raw = e.target.value
  const opt = (props.item.options || []).find((o) => String(o.value) === String(raw))
  props.item.set(opt ? opt.value : raw)
}
</script>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.setting-row:hover {
  border-color: var(--line-strong);
}
.setting-row--click {
  width: 100%;
  text-align: left;
  cursor: pointer;
}
.setting-row--click:hover {
  background: var(--card-hover);
}
/* 子项：缩进 + 弱化，挂在父项下面的从属设置 */
.setting-row--sub {
  margin-left: 16px;
  padding: 9px 12px;
  background: var(--bg);
}
.setting-row--sub .setting-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.setting-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.setting-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.5;
}
.setting-hint {
  font-size: 12px;
  color: var(--muted-light);
  line-height: 1.5;
}
.setting-control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.setting-unit {
  font-size: 12px;
  color: var(--muted);
}
.setting-segmented {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.setting-segmented-btn {
  padding: 6px 11px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--card);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.setting-segmented-btn + .setting-segmented-btn {
  border-left: 1px solid var(--line);
}
.setting-segmented-btn:hover {
  background: var(--bg-accent);
  color: var(--text);
}
.setting-segmented-btn.is-active,
.setting-segmented-btn.is-active:hover {
  background: var(--primary-bg);
  color: var(--primary);
  font-weight: 600;
}
.setting-note {
  margin: 0;
  padding: 0 2px;
  font-size: 12px;
  color: var(--muted-light);
  line-height: 1.6;
}
</style>
