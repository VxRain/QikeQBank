/**
 * 设置弹窗（左右分栏 + 全局搜索）
 * 布局：左侧分类栏 / 右侧内容区，内容全部由 registry.js 驱动，
 * 设置项涨到几十条时只需在 registry 里加 item，分类栏与搜索会自动跟随。
 */
<template>
  <Teleport to="body">
    <Transition name="sd">
      <div v-if="modelValue" class="sd-mask" @mousedown.self="close">
        <div
          ref="cardEl"
          class="sd-card"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          tabindex="-1"
        >
          <!-- 顶栏：标题 + 搜索 + 关闭 -->
          <header class="sd-head">
            <span class="sd-head-title">
              <i class="i-lucide-settings-2 text-primary" />设置
            </span>
            <div class="sd-search">
              <i class="i-lucide-search sd-search-icon" aria-hidden="true" />
              <input
                ref="searchEl"
                v-model="query"
                class="input sd-search-input"
                type="text"
                placeholder="搜索设置项（如：复习、错题、同步）"
                autocomplete="off"
                spellcheck="false"
                @input="onInput"
                @keydown.esc.stop.prevent="onSearchEsc"
              />
              <button v-if="query" type="button" class="sd-search-clear" title="清空搜索" @click="clearQuery">
                <i class="i-lucide-x" aria-hidden="true" />
              </button>
            </div>
            <button type="button" class="i-btn sd-close" title="关闭（Esc）" @click="close">
              <i class="i-lucide-x" aria-hidden="true" />
            </button>
          </header>

          <div class="sd-body">
            <!-- 左：分类栏 -->
            <nav class="sd-rail" aria-label="设置分类">
              <button
                v-for="s in sections"
                :key="s.id"
                type="button"
                class="sd-rail-item"
                :class="{ 'is-active': !searching && s.id === activeId }"
                :aria-current="!searching && s.id === activeId ? 'page' : undefined"
                @click="selectSection(s.id)"
              >
                <i :class="s.icon" class="sd-rail-icon" aria-hidden="true" />
                <span class="sd-rail-label">{{ s.title }}</span>
                <span v-if="searching && hitCount(s)" class="sd-rail-count">{{ hitCount(s) }}</span>
              </button>
            </nav>

            <!-- 右：内容区 -->
            <div ref="paneEl" class="sd-pane">
              <!-- 搜索态：跨分类汇总命中 -->
              <template v-if="searching">
                <div v-if="!groups.length" class="sd-empty">
                  <i class="i-lucide-search-x" />
                  <p>没有匹配的设置项</p>
                  <span>换个关键词试试，例如「错题」「保持率」「同步」</span>
                </div>
                <section v-for="g in groups" :key="g.section.id" class="sd-group">
                  <div class="sd-group-head">
                    <i :class="g.section.icon" class="sd-group-icon" aria-hidden="true" />
                    <span>{{ g.section.title }}</span>
                    <span class="sd-group-count">{{ g.items.length }}</span>
                  </div>
                  <SettingRow v-for="item in g.items" :key="item.key" :item="item" />
                </section>
              </template>

              <!-- 分类态：只看当前分类 -->
              <template v-else-if="current">
                <header class="sd-section-head">
                  <h4 class="sd-section-title">
                    <i :class="current.icon" class="sd-section-icon" aria-hidden="true" />{{ current.title }}
                  </h4>
                  <p v-if="current.desc" class="sd-section-desc">{{ current.desc }}</p>
                </header>
                <SettingRow v-for="item in currentItems" :key="item.key" :item="item" />
              </template>
            </div>
          </div>

          <!-- 底栏 -->
          <footer class="sd-foot">
            <span class="sd-foot-note">修改即时生效 · 自动保存</span>
            <button type="button" class="btn btn-primary" @click="close">完成</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import SettingRow from './SettingRow.vue'
import { SETTINGS_SECTIONS, isItemVisible, matchItem } from './registry.js'
import { ui } from '@/stores/ui.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const sections = SETTINGS_SECTIONS

// 当前分类：模块级持有，关掉再打开停在原分类（不落盘，跟随会话）
let lastSectionId = sections[0]?.id || ''
const activeId = ref(lastSectionId)
const query = ref('')
const cardEl = ref(null)
const searchEl = ref(null)
const paneEl = ref(null)

const searching = computed(() => query.value.trim().length > 0)
const current = computed(() => sections.find((s) => s.id === activeId.value) || sections[0])

/** 分类态：按 visible() 过滤（依赖项未开启的行不占位） */
const currentItems = computed(() =>
  (current.value?.items || []).filter((item) => isItemVisible(item))
)

/** 搜索态：忽略 visible()，但未满足依赖的行会显示"需先开启 …"提示而不是凭空消失 */
const groups = computed(() => {
  const q = query.value
  const out = []
  for (const section of sections) {
    const items = (section.items || []).filter((item) => matchItem(item, section, q))
    if (items.length) out.push({ section, items })
  }
  return out
})

function hitCount(section) {
  const q = query.value
  return (section.items || []).filter((item) => matchItem(item, section, q)).length
}

function selectSection(id) {
  activeId.value = id
  lastSectionId = id
  query.value = ''
  if (paneEl.value) paneEl.value.scrollTop = 0
}

function clearQuery() {
  query.value = ''
  searchEl.value?.focus()
}

/** 搜索框内按 Esc：有关键词先清空，否则交给全局 Esc 关闭 */
function onSearchEsc() {
  if (query.value) clearQuery()
  else close()
}
function onInput() {
  if (paneEl.value) paneEl.value.scrollTop = 0
}

function close() {
  emit('update:modelValue', false)
}

function onKeydown(e) {
  if (!props.modelValue) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchEl.value?.focus()
    searchEl.value?.select?.()
    return
  }
  if (e.key === 'Tab') {
    trapTab(e)
    return
  }
  if (e.key !== 'Escape') return
  // 上层确认弹窗（如云同步下载确认）正在显示时，Esc 归它处理
  if (ui.dialog) return
  e.preventDefault()
  close()
}

/** 焦点圈在弹窗内：Tab / Shift+Tab 到边界时回绕，避免焦点窜到背后页面 */
function trapTab(e) {
  const card = cardEl.value
  if (!card) return
  const nodes = [...card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null)
  if (!nodes.length) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === card || !card.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !card.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

let prevOverflow = ''

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      query.value = ''
      activeId.value = lastSectionId
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', onKeydown)
      await nextTick()
      cardEl.value?.focus?.()
      if (paneEl.value) paneEl.value.scrollTop = 0
    } else {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeydown)
    }
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (props.modelValue) document.body.style.overflow = prevOverflow
})
</script>

<style scoped>
/* ── 遮罩与卡片：与 DialogHost 同一套入场语言 ── */
.sd-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(3px);
}
.sd-card {
  display: flex;
  flex-direction: column;
  width: min(920px, calc(100vw - 56px));
  height: min(640px, calc(100vh - 80px));
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 40px rgba(2, 6, 23, 0.25), 0 4px 12px rgba(2, 6, 23, 0.12);
  overflow: hidden;
  outline: none;
}

/* ── 顶栏 ── */
.sd-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  height: 56px;
  padding: 0 12px 0 18px;
  border-bottom: 1px solid var(--line);
}
.sd-head-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-family: var(--serif);
  font-size: 16.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
}
.sd-search {
  position: relative;
  flex: 1;
  max-width: 320px;
  margin-left: auto;
}
.sd-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: var(--muted-light);
  pointer-events: none;
}
.sd-search-input {
  width: 100%;
  padding: 7px 28px 7px 30px;
  font-size: 13px;
}
.sd-search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  padding: 1px;
  border-radius: 4px;
  color: var(--muted-light);
  cursor: pointer;
}
.sd-search-clear:hover {
  color: var(--text);
  background: var(--bg-accent);
}
.sd-close {
  padding: 5px 7px;
  flex-shrink: 0;
}

/* ── 主体 ── */
.sd-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 左分类栏 */
.sd-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  width: 176px;
  padding: 10px;
  overflow-y: auto;
  border-right: 1px solid var(--line);
  background: var(--bg);
}
.sd-rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sd-rail-item:hover {
  background: var(--bg-accent);
  color: var(--text);
}
.sd-rail-item.is-active {
  background: var(--card);
  color: var(--primary);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--line);
  padding: 6px 8px;
}
.sd-rail-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--muted);
}
.sd-rail-item.is-active .sd-rail-icon {
  color: var(--primary);
}
.sd-rail-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-rail-count {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-accent);
  color: var(--muted);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  font-weight: 500;
}

/* 右内容区 */
.sd-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 16px 18px 20px;
  overflow-y: auto;
}
.sd-section-head {
  padding: 2px 2px 4px;
}
.sd-section-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.sd-section-icon {
  font-size: 15px;
  color: var(--primary);
}
.sd-section-desc {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}

/* 搜索结果的分类分组 */
.sd-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sd-group + .sd-group {
  margin-top: 10px;
}
.sd-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.sd-group-icon {
  font-size: 13px;
  color: var(--muted-light);
}
.sd-group-count {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-accent);
  font-size: 11px;
  font-weight: 500;
}

/* 空态 */
.sd-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1;
  padding: 48px 20px;
  color: var(--muted);
  text-align: center;
}
.sd-empty i {
  font-size: 26px;
  color: var(--muted-light);
}
.sd-empty p {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.sd-empty span {
  font-size: 12.5px;
  color: var(--muted-light);
}

/* ── 底栏 ── */
.sd-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  padding: 10px 14px 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--card);
}
.sd-foot-note {
  font-size: 12px;
  color: var(--muted-light);
}

/* ── 入场动画（与 DialogHost 一致）── */
.sd-enter-active,
.sd-leave-active {
  transition: opacity 0.18s ease;
}
.sd-enter-active .sd-card,
.sd-leave-active .sd-card {
  transition: transform 0.18s ease;
}
.sd-enter-from,
.sd-leave-to {
  opacity: 0;
}
.sd-enter-from .sd-card,
.sd-leave-to .sd-card {
  transform: translateY(8px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .sd-enter-active,
  .sd-leave-active,
  .sd-enter-active .sd-card,
  .sd-leave-active .sd-card {
    transition: none;
  }
}
</style>
