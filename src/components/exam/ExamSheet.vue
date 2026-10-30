<template>
  <!-- 模考答题卡（FE-P0-07）：三态网格 + 材料题按母题分组 + 点击跳题 -->
  <Teleport to="body">
    <Transition name="sc">
      <div v-if="open" class="sc-mask fixed inset-0 z-[1050] flex bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="$emit('close')">
        <aside class="sc-panel ml-auto w-full max-w-[420px] h-full bg-card border-l border-line shadow-lg flex flex-col">
          <div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
            <h3 class="m-0 text-[16px] font-700 text-text flex items-center gap-2">
              <i class="i-lucide-layout-grid text-primary" />答题卡
            </h3>
            <button type="button" class="i-btn w-8 h-8" aria-label="关闭" @click="$emit('close')">
              <i class="i-lucide-x" />
            </button>
          </div>

          <!-- 图例与计数 -->
          <div class="px-5 py-3 border-b border-line flex flex-wrap items-center gap-3 text-[12px]">
            <span class="inline-flex items-center gap-1.5"><span class="sc-dot sc-done"></span>已答 <b class="text-text">{{ counts.answered }}</b></span>
            <span class="inline-flex items-center gap-1.5"><span class="sc-dot sc-todo"></span>未答 <b class="text-text">{{ counts.unanswered }}</b></span>
            <span class="inline-flex items-center gap-1.5"><span class="sc-dot sc-flag"></span>标记 <b class="text-text">{{ counts.flagged }}</b></span>
          </div>

          <div class="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4">
            <div v-for="g in groups" :key="g.key" class="flex flex-col gap-2">
              <div v-if="g.isMaterial" class="text-[12px] text-muted font-600 flex items-center gap-1.5">
                <i class="i-lucide-files text-[13px]" />
                材料题 · 第 {{ g.items[0].idx + 1 }} 题
                <span class="font-400 text-muted-light">
                  （{{ g.items.filter((x) => x.answered).length }}/{{ g.items.length }} 问已答）
                </span>
              </div>
              <div class="flex flex-wrap gap-2" :class="g.isMaterial && 'pl-3 border-l-2 border-line'">
                <button
                  v-for="it in g.items"
                  :key="it.uid"
                  type="button"
                  class="sc-cell"
                  :class="[
                    cellClass(it),
                    it.idx === currentIdx && 'sc-current'
                  ]"
                  :title="cellTitle(it)"
                  @click="$emit('jump', it.idx)"
                >
                  <span class="leading-none">{{ it.idx + 1 }}</span>
                  <i v-if="it.flagged" class="i-lucide-flag absolute -top-1 -right-1 text-[10px] text-danger bg-card rounded-full" />
                </button>
              </div>
            </div>
          </div>

          <div class="px-5 py-4 border-t border-line flex flex-col gap-2">
            <div class="flex gap-2">
              <button type="button" class="btn flex-1" @click="$emit('jump-first-unanswered')">
                <i class="i-lucide-corner-down-right" />跳到首个未答
              </button>
              <button type="button" class="btn btn-danger flex-1" @click="$emit('submit')">
                <i class="i-lucide-flag" />交卷
              </button>
            </div>
            <div class="text-[11px] text-muted-light text-center">
              点击题号跳转；标 ⚑ 的题目交卷前会再提醒一次
            </div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 模考答题卡（FE-P0-07a）
 *
 * 职责只有「展示状态 + 发出跳转意图」，不持有任何作答数据：
 * 组数据由 Exam.vue 计算后传入（items + answers + flagged），跳转由父级执行。
 *
 * 材料题的粒度：**母题分组，子题作为组内小组件**——材料题的判分单位是子题，
 * 但用户心智里它是一道大题，所以分组标题用母题序号，格子用子题序号。
 */
import { computed } from 'vue'
import { groupSheetItems, countSheet, cellStateOf } from '@/utils/examSheet.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 条目：{ uid, idx, q, parent, isChild, childIdx, childCount } */
  items: { type: Array, default: () => [] },
  /** uid → 作答对象（与 Exam 的 answers 同引用） */
  answers: { type: Object, default: () => ({}) },
  /** uid → 是否标记 */
  flagged: { type: Object, default: () => ({}) },
  currentIdx: { type: Number, default: -1 }
})

defineEmits(['close', 'jump', 'submit', 'jump-first-unanswered'])

/** 与 Exam.vue 的 hasAnswer 同口径（判分前「有内容」即可，简答自评也算）——统一在 examSheet.js */

/**
 * 分组：材料题把连续子题折成一组（按 parent 引用归并，不依赖子题是否相邻）。
 * 非材料题各自成组，保证顺序与 items 一致。
 */
const groups = computed(() => groupSheetItems(props.items, props.answers, props.flagged))

const counts = computed(() => countSheet(props.items, props.answers, props.flagged))

function cellClass(it) {
  return `sc-${cellStateOf(it)}`
}

function cellTitle(it) {
  const state = it.flagged ? '已标记' : it.answered ? '已答' : '未答'
  const q = it.q
  const type = q?.type ? ` · ${q.type}` : ''
  return `第 ${it.idx + 1} 题 · ${state}${type}`
}
</script>

<style scoped>
.sc-enter-active, .sc-leave-active { transition: opacity .18s ease; }
.sc-enter-active .sc-panel, .sc-leave-active .sc-panel { transition: transform .22s ease; }
.sc-enter-from, .sc-leave-to { opacity: 0; }
.sc-enter-from .sc-panel, .sc-leave-to .sc-panel { transform: translateX(24px); }

.sc-cell {
  position: relative;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid var(--line);
  cursor: pointer;
  transition: background-color .15s, border-color .15s, color .15s, transform .15s;
}
.sc-cell:hover { transform: translateY(-1px); }
.sc-dot {
  width: 10px; height: 10px; border-radius: 3px; display: inline-block;
  border: 1px solid var(--line);
}
.sc-cell.sc-done, .sc-dot.sc-done { background: var(--success-bg); border-color: #bcd9c4; color: var(--success); }
.sc-cell.sc-todo, .sc-dot.sc-todo { background: var(--card); color: var(--muted); }
.sc-cell.sc-flag, .sc-dot.sc-flag { background: var(--danger-bg); border-color: #e3c9c5; color: var(--danger); }
.sc-cell.sc-current { outline: 2px solid var(--primary); outline-offset: 1px; }
</style>
