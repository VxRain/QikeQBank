<!--
  快捷键帮助（FE-P0-08）

  为什么要独立成一个弹层而不是塞进设置页：
  「我忘了这个页面能按什么键」是**当下**的问题，用户不会为了查一个键位去开设置、
  翻分类、再找小字说明。`?` 就地弹出是本任务要求的入口；设置页入口属于 FE-P1-10。

  内容来源的诚实性：这里的键位表是**手写镜像**，不是从各页面自动生成的。
  为避免它和实际绑定漂移，tests/unit/shortcuts.test.js 逐条把这些键位和各页面
  （Practice/Review/Exam/QuestionRunner/Form/App）的 keydown 分支做源码级核对——
  改了绑定却忘了改这张表，单测立刻失败。
-->
<template>
  <Teleport to="body">
    <Transition name="sc">
      <div v-if="modelValue" class="sc-mask" @mousedown.self="close">
        <div ref="cardEl" class="sc-card" role="dialog" aria-modal="true" aria-label="快捷键" tabindex="-1">
          <header class="sc-head">
            <span class="sc-head-title"><i class="i-lucide-keyboard text-primary" aria-hidden="true" />快捷键</span>
            <button type="button" class="sc-close" title="关闭（Esc）" @click="close">
              <i class="i-lucide-x" aria-hidden="true" />
            </button>
          </header>

          <div class="sc-body">
            <section v-for="group in GROUPS" :key="group.id" class="sc-group">
              <h4 class="sc-group-title">
                <i :class="group.icon" class="sc-group-icon" aria-hidden="true" />{{ group.title }}
              </h4>
              <p v-if="group.note" class="sc-group-note">{{ group.note }}</p>
              <dl class="sc-list">
                <template v-for="item in group.items" :key="item.keys">
                  <dt class="sc-keys">
                    <kbd v-for="k in item.keys.split(' ')" :key="k" class="sc-kbd">{{ k }}</kbd>
                  </dt>
                  <dd class="sc-desc">{{ item.desc }}</dd>
                </template>
              </dl>
            </section>
          </div>

          <footer class="sc-foot">
            <span class="sc-foot-note">按 <kbd class="sc-kbd">?</kbd> 或点顶栏键盘图标随时打开</span>
            <button type="button" class="btn btn-primary btn-small" @click="close">知道了</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'open-search'])

const cardEl = ref(null)
let prevOverflow = ''

/**
 * 键位表 —— 与各页面实际绑定逐条对应（守卫见 tests/unit/shortcuts.test.js）。
 * 只列**当前真的存在**的键位；计划中的键不要写进来，否则用户按了没反应。
 */
const GROUPS = Object.freeze([
  {
    id: 'global',
    title: '全局',
    icon: 'i-lucide-globe',
    items: [
      { keys: 'Ctrl K', desc: '打开 / 关闭全局搜索面板' },
      { keys: '?', desc: '打开本快捷键帮助（输入框内不触发）' },
      { keys: 'Esc', desc: '关闭当前弹层；搜索面板中先清空关键词' }
    ]
  },
  {
    id: 'search',
    title: '搜索面板',
    icon: 'i-lucide-search',
    items: [
      { keys: '↑ ↓', desc: '在结果间移动' },
      { keys: 'Enter', desc: '打开选中结果' },
      { keys: '→', desc: '展开 / 收起该题的题面预览' },
      { keys: 'Esc', desc: '清空关键词，再按一次关闭面板' }
    ]
  },
  {
    id: 'practice',
    title: '刷题',
    icon: 'i-lucide-zap',
    note: '输入框内与弹窗打开时不劫持按键。',
    items: [
      { keys: 'A B C D', desc: '选择选项（多选为切换）' },
      { keys: 'M', desc: '展开 / 收起材料题材料' },
      { keys: 'Enter', desc: '提交答案；判分后为下一题' },
      { keys: '1 2', desc: '简答题看答案后自评：1 不会 / 2 会' },
      { keys: '← →', desc: '背题模式下翻上一题 / 下一题' },
      { keys: 'Esc', desc: '取消自动下一题' }
    ]
  },
  {
    id: 'review',
    title: '复习',
    icon: 'i-lucide-repeat',
    note: '判分后必须显式自评，Enter 不替你选。',
    items: [
      { keys: 'A B C D', desc: '选择选项' },
      { keys: 'M', desc: '展开 / 收起材料题材料' },
      { keys: 'Enter', desc: '提交作答并判分' },
      { keys: '1 2 3 4', desc: '自评：忘记 / 困难 / 良好 / 简单' }
    ]
  },
  {
    id: 'exam',
    title: '模考',
    icon: 'i-lucide-clipboard-list',
    items: [
      { keys: 'A B C D', desc: '选择选项' },
      { keys: 'M', desc: '展开 / 收起材料题材料' },
      { keys: 'Enter', desc: '下一题（焦点在按钮上时走原生）' },
      { keys: '1 2', desc: '简答题看答案后自评' }
    ]
  },
  {
    id: 'form',
    title: '录题',
    icon: 'i-lucide-pencil-line',
    items: [{ keys: 'Ctrl S', desc: '保存试题' }]
  }
])

function close() {
  emit('update:modelValue', false)
}

function onKeydown(e) {
  if (!props.modelValue) return
  if (e.key !== 'Escape') return
  e.preventDefault()
  close()
}

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', onKeydown)
      await nextTick()
      cardEl.value?.focus?.()
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
/* 遮罩与卡片：与 DialogHost / SettingsDialog / SearchPalette 同一套入场语言 */
.sc-mask {
  position: fixed;
  inset: 0;
  z-index: 1030;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(3px);
}
.sc-card {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(640px, calc(100vh - 48px));
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 40px rgba(2, 6, 23, 0.25), 0 4px 12px rgba(2, 6, 23, 0.12);
  overflow: hidden;
  outline: none;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  height: 52px;
  padding: 0 12px 0 18px;
  border-bottom: 1px solid var(--line);
}
.sc-head-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--serif);
  font-size: 16.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.sc-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
}
.sc-close:hover { color: var(--text); background: var(--bg-accent); }

.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 6px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 18px;
  align-content: start;
}
@media (max-width: 720px) {
  .sc-body { grid-template-columns: minmax(0, 1fr); }
}
.sc-group { padding: 4px 0 10px; }
.sc-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--primary);
}
.sc-group-icon { font-size: 13px; }
.sc-group-note {
  margin: 0 0 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.sc-list {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 5px 10px;
  margin: 0;
  align-items: baseline;
}
.sc-keys { display: flex; gap: 3px; flex-wrap: wrap; margin: 0; }
.sc-desc { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.sc-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  white-space: nowrap;
}

.sc-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.sc-foot-note { font-size: 12px; color: var(--muted); }

/* 入场动画（与 .dg / .sd / .sp 同语言） */
.sc-enter-active, .sc-leave-active { transition: opacity .16s ease; }
.sc-enter-active .sc-card, .sc-leave-active .sc-card { transition: transform .16s ease; }
.sc-enter-from, .sc-leave-to { opacity: 0; }
.sc-enter-from .sc-card, .sc-leave-to .sc-card { transform: translateY(6px) scale(.985); }
@media (prefers-reduced-motion: reduce) {
  .sc-enter-active, .sc-leave-active,
  .sc-enter-active .sc-card, .sc-leave-active .sc-card { transition: none; }
}
</style>
