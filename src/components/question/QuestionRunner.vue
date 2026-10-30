<!--
  QuestionRunner（FE-ARCH-02）：三个答题页共用的"题目渲染 + 作答交互"层。

  职责边界（页面只做编排，不再各写一套渲染/键盘）：
  - 材料面板（母题题干 + 展开/收起，M 键）
  - 题干渲染（填空注入输入框；背题模式注入答案章）
  - 选项按钮（单选/判断/多选；A–F 键与点击选中）
  - 简答作答（文本域 + 查看参考答案）
  - 填空输入的事件委托（含回车跳下一空，末空 emit fill-enter）
  - 向上暴露渲染片段（参考答案/解析/答案对照），供各模式的结果区复用

  模式差异放到 slot，不塞进组件：
  - #result     判分结果区（练习/复习）
  - #short-actions 简答自评区（练习 会/不会、模考 会/不会）
  - 默认 slot   背题答案/解析、底部按钮等模式专属内容
-->
<template>
  <div class="qr flex flex-col gap-3.5" @keydown="onKeydown">
    <!-- 材料面板 -->
    <div v-if="item.isChild" class="border border-dashed border-primary-border bg-bg-accent rounded-[12px] px-3.5 py-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[12px] font-600 text-muted flex items-center gap-1.5 min-w-0">
          <i class="i-lucide-book-open shrink-0" />材料 · 共 {{ item.childCount }} 问 · 第 {{ item.childIdx + 1 }} 问
        </span>
        <button type="button" class="btn btn-small shrink-0" title="M 展开/收起" @click="toggleMaterial">
          <i :class="materialOpen ? 'i-lucide-eye-off' : 'i-lucide-eye'" />{{ materialOpen ? '收起' : '展开' }}
        </button>
      </div>
      <div v-if="materialOpen" class="text-[13px] text-text-secondary pt-2" v-html="materialHtml"></div>
    </div>

    <!-- 题干：填空输入框由本组件注入，事件委托在 onStemInput/onStemKeydown -->
    <div
      ref="stemRef"
      class="stem leading-[1.8] text-text-secondary"
      :key="item.uid"
      v-html="stemHtml"
      @input="onStemInput"
      @keydown.stop="onStemKeydown"
    ></div>

    <!-- 作答区（背题模式直接看答案，不渲染作答控件） -->
    <template v-if="mode !== 'recite'">
      <div v-if="isChoiceLike" class="flex flex-col gap-2">
        <button
          v-for="(o, i) in options"
          :key="o.id"
          type="button"
          class="option-btn"
          :title="interactiveHint"
          :disabled="locked"
          :class="isPicked(o.id) && 'bg-primary-bg border-primary-border text-text shadow-[0_0_0_3px_rgba(31,77,58,0.12)]'"
          @click="pick(o.id)"
        >
          <span class="key font-700 text-primary shrink-0">{{ keyOf(i) }}</span>
          <span class="opt-body" v-html="optHtml(o)"></span>
        </button>
      </div>

      <div v-else-if="isShort" class="flex flex-col gap-2.5">
        <textarea
          :value="shortText"
          rows="5"
          class="w-full p-3 border border-line rounded-[8px] text-[14px] text-text bg-card outline-none resize-y shadow-sm transition-[border-color,box-shadow] duration-150 focus:border-primary focus:shadow-[0_0_0_3px_rgba(31,77,58,0.15)]"
          :placeholder="shortPlaceholder"
          @input="emit('update:shortText', $event.target.value)"
        ></textarea>
        <div class="flex gap-2 flex-wrap">
          <button type="button" class="btn" @click="toggleRef">
            <i :class="showRef ? 'i-lucide-eye-off' : 'i-lucide-eye'" />{{ showRef ? '收起参考答案' : '查看参考答案' }}
          </button>
          <slot name="short-toolbar" :show-ref="showRef"></slot>
        </div>
        <div v-if="showRef" class="p-3.5 bg-success-bg border border-[#bcd9c4] rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
          <b class="text-success flex items-center gap-1"><i class="i-lucide-book-open text-[14px]" />参考答案：</b>
          <div v-html="refHtml"></div>
        </div>
      </div>

      <slot name="short-actions" :show-ref="showRef"></slot>
    </template>

    <!-- 模式专属：判分结果、背题答案/解析、底部操作 -->
    <slot :analysis-html="analysisHtml" :answer-html="answerHtml" :ref-html="refHtml"></slot>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { renderDoc, renderOptions } from '@/utils/render.js'

const props = defineProps({
  // { q, parent, isChild, childIdx, childCount, uid }
  item: { type: Object, required: true },
  // practice | review | exam | recite
  mode: { type: String, default: 'practice' },
  selected: { type: String, default: '' },
  picked: { type: Array, default: () => [] },
  fillValues: { type: Object, default: () => ({}) },
  shortText: { type: String, default: '' },
  showRef: { type: Boolean, default: false },
  materialOpen: { type: Boolean, default: true },
  // 已判分/交卷中：禁用作答控件（判分后不允许改答案）
  locked: { type: Boolean, default: false },
  shortPlaceholder: { type: String, default: '请输入你的答案…' },
  interactiveHint: { type: String, default: 'A–F 选择' }
})

const emit = defineEmits([
  'update:selected',
  'update:picked',
  'update:shortText',
  'update:showRef',
  'update:materialOpen',
  'fill-enter'
])

const q = computed(() => props.item?.q || {})
const options = computed(() => q.value.options || [])
const isChoiceLike = computed(() => ['single', 'multi', 'judge'].includes(q.value.type))
const isShort = computed(() => q.value.type === 'short')

const materialHtml = computed(() => (props.item?.parent ? renderDoc(props.item.parent.stem) : ''))
const refHtml = computed(() => {
  const r = q.value.answer?.reference
  return isShort.value && r ? renderDoc(r) : ''
})
const analysisHtml = computed(() => {
  const a = q.value.analysis
  return a && Array.isArray(a.content) && a.content.length ? renderDoc(a) : ''
})
const answerHtml = computed(() => (isChoiceLike.value ? renderOptions(options.value, q.value.answer?.ids) : ''))

// 题干：填空注入输入框；背题模式把空位替换成答案章
const stemHtml = computed(() => {
  const question = q.value
  if (!question?.stem) return ''
  if (question.type !== 'fill') return renderDoc(question.stem)
  if (props.mode === 'recite') {
    const map = {}
    for (const b of question.answer?.blanks || []) map[b.id] = (b.answers || []).join(' / ')
    return renderDoc(question.stem).replace(
      /<span class="blank"[^>]*data-id="([^"]+)"[^>]*>[\s\S]*?<\/span>/g,
      (m, id) => `<span class="blank-recite">${map[id] || '—'}</span>`
    )
  }
  return renderDoc(question.stem).replace(
    /<span class="blank"[^>]*data-id="([^"]+)"[^>]*>[\s\S]*?<\/span>/g,
    (m, id) => `<input class="qb-fill-input" data-blank="${id}" type="text" autocomplete="off" placeholder="填写答案" />`
  )
})

// v-html 重建后输入框是空的：把已有作答写回 DOM（切题返回/会话恢复都靠它）
const stemRef = ref(null)
watch(
  () => [props.item?.uid, stemHtml.value],
  async () => {
    await nextTick()
    const el = stemRef.value
    if (!el) return
    for (const inp of el.querySelectorAll('.qb-fill-input')) {
      const v = props.fillValues?.[inp.dataset.blank]
      if (v != null && inp.value !== String(v)) inp.value = String(v)
    }
  },
  { immediate: true }
)

function keyOf(i) {
  return String.fromCharCode(65 + (i || 0))
}
function optHtml(o) {
  return renderDoc(o?.content).replace(/^<p>/, '').replace(/<\/p>$/, '')
}
function isPicked(id) {
  return q.value.type === 'multi' ? props.picked.includes(id) : props.selected === id
}

function pick(id) {
  if (props.locked) return
  if (q.value.type === 'multi') {
    // 就地对父组件传入的数组增删：同一 tick 连点多个选项也不会读到过期 props
    const i = props.picked.indexOf(id)
    if (i >= 0) props.picked.splice(i, 1)
    else props.picked.push(id)
    emit('update:picked', props.picked)
  } else {
    emit('update:selected', id)
  }
}
function toggleMaterial() {
  emit('update:materialOpen', !props.materialOpen)
}
function toggleRef() {
  emit('update:showRef', !props.showRef)
}

// 填空输入：直接写进传入的 fillValues（父组件持有同一对象）
function onStemInput(e) {
  const id = e.target?.dataset?.blank
  if (id) props.fillValues[id] = e.target.value
}

// 填空回车：跳下一空并全选；末空交给页面（练习=判分 / 模考=下一题）
function onStemKeydown(e) {
  if (e.key !== 'Enter') return
  const t = e.target
  if (!t?.classList?.contains('qb-fill-input')) return
  e.preventDefault()
  const inputs = [...e.currentTarget.querySelectorAll('.qb-fill-input')]
  const i = inputs.indexOf(t)
  if (i >= 0 && i < inputs.length - 1) {
    inputs[i + 1].focus()
    inputs[i + 1].select?.()
  } else {
    emit('fill-enter')
  }
}

// 选项键盘：A–F 选中/切换、M 切换材料（Enter/数字键等模式语义留在页面）
function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target
  if (t?.closest?.('textarea, select, input, [contenteditable], .tiptap, .ProseMirror')) return
  const k = typeof e.key === 'string' ? e.key.toUpperCase() : ''
  if (k === 'M' && props.item?.isChild) {
    e.preventDefault()
    toggleMaterial()
    return
  }
  if (!/^[A-F]$/.test(k)) return
  if (props.mode === 'recite' || props.locked) return
  if (!isChoiceLike.value) return
  const opt = options.value[k.charCodeAt(0) - 65]
  if (opt) {
    e.preventDefault()
    pick(opt.id)
  }
}
</script>

<style>
/* 三个答题页原本各写一份，现收敛到这里（v-html 内容无法用 scoped 选择器命中） */
.stem p { margin: 10px 0; }
.stem figure { margin: 14px 0; text-align: center; }
.stem img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); background: #fffdf7; }
.stem .math-block { margin: 12px 0; padding: 12px; background: var(--bg-accent); border: 1px solid var(--line); border-radius: 8px; text-align: center; }
.stem .qb-fill-input {
  min-width: 92px; padding: 6px 10px; margin: 0 4px;
  border: 1px solid var(--line-strong); border-bottom: 2px solid var(--primary);
  border-radius: 8px; font-size: 14px; color: var(--text); background: var(--card);
  outline: none; transition: border-color .15s ease, box-shadow .15s ease; box-shadow: var(--shadow-sm);
}
.stem .qb-fill-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(31,77,58,.15); }
.stem .blank-recite {
  display: inline-block; padding: 0 8px; margin: 0 2px;
  border-bottom: 2px solid var(--success); border-radius: 4px;
  background: var(--success-bg); color: var(--text); font-weight: 500; line-height: 1.5;
}
.opt-body p { margin: 0; }
.answer-view .option { padding: 6px 8px; border-radius: 8px; }
.answer-view .option.correct { color: var(--success); font-weight: 600; }
.answer-view .key { font-weight: 700; color: var(--primary); margin-right: 6px; }
.answer-view p { margin: 4px 0; }
.analysis p { margin: 6px 0; }
</style>
