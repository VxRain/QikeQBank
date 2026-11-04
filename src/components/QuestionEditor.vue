<template>
  <div class="flex flex-col gap-2.5">
    <div class="row type-row relative flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-1.5 flex-wrap">
        <label class="text-[13px] text-text-secondary">题型</label>
        <select :value="local.type" @change="onMainTypeChange(valueOf($event))" class="select px-2 py-1.5 text-[12px] w-auto">
          <option v-for="t in QUESTION_TYPES" :key="t.key" :value="t.key">{{ t.key === 'material' ? `${t.label}（父子题）` : t.label }}</option>
        </select>
        <template v-if="local.type==='material'">
          <label class="text-[13px] text-text-secondary ml-3">总分</label>
          <span class="badge">{{ totalScore }} 分</span>
          <label class="text-[13px] text-text-secondary ml-3">难度</label>
          <span class="badge">{{ materialDifficulty }}（子题加权）</span>
        </template>
        <template v-else>
          <label class="text-[13px] text-text-secondary ml-3">分值</label>
          <input v-model.number="local.score" type="number" class="input px-2 py-1.5 text-[12px] w-[80px]" @change="emitUpdate" />
          <label class="text-[13px] text-text-secondary ml-3">难度</label>
          <select v-model.number="local.difficulty" class="select px-2 py-1.5 text-[12px] w-[80px]" @change="emitUpdate">
            <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
          </select>
        </template>
      </div>
      <button class="i-btn px-2.5 py-1.5 text-[12px]" @click="showPaste=!showPaste" title="粘贴智能填入">
        <i class="i-lucide-clipboard text-[14px]" />智能粘贴
      </button>
      <div v-if="showPaste" class="absolute top-[calc(100%+8px)] right-0 w-[min(560px,92vw)] z-30 bg-card border border-line rounded-[12px] shadow-[0_12px_32px_rgba(0,0,0,0.12)] p-3">
        <PasteBox @parsed="onPasteAndClose" />
      </div>
    </div>
    <div v-if="showPaste" class="fixed inset-0 z-20" @click="showPaste=false"></div>

    <QuestionForm
      v-if="local.type!=='material'"
      :key="'main-'+formKey"
      :question="local"
      @update="onFormUpdate"
    />

    <template v-else>
      <div class="bg-card border border-line rounded-[8px] p-2.5">
        <div class="flex items-center justify-between mb-1.5">
          <h3 class="m-0 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-file-text text-primary text-[14px]" />材料</h3>
          <span class="text-muted text-[11px]">总分：{{ totalScore }} 分（= 子题分值之和，自动计算）</span>
        </div>
        <TiptapDocEditor :modelValue="local.stem" :showBlank="false" @update:modelValue="onMaterialStem" />
      </div>

      <div class="bg-card border border-line rounded-[8px] p-2.5">
        <h3 class="m-0 mb-2 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-list text-primary text-[14px]" />子题（{{children.length}}）</h3>
        <!--
          子题列表容器：拖拽排序用 pointer 事件自实现，不用 HTML5 DnD。
          原因：原生 DnD 只能靠 drop 事件的 target 判定落点，要求指针恰好落在某张卡上。
          而单卡实测 1227px > 1024 最小窗可视高 768px，于是拖一行仍在同卡内
          （from===to，无反应），拖到卡片间隙或页面空白则没有任何元素接收 drop（同样静默失败）。
          pointer 方案直接按坐标算插入位，只要指针在列表区域内就一定能算出目标。
        -->
        <div ref="childListEl" class="relative">
          <div
            v-for="(child, cIdx) in children"
            :key="child._uid"
            class="bg-bg-accent border border-line rounded-[8px] transition-[border-color,box-shadow,opacity] duration-150"
            :class="[dragMode ? 'p-1.5 mb-1' : 'p-2.5 mb-2.5', childDragFrom === cIdx ? 'opacity-40' : '']"
            :data-child-card="cIdx"
          >
          <div class="flex items-center justify-between gap-2 flex-wrap" :class="dragMode ? 'gap-1' : 'mb-2'">
            <b class="text-[12px] text-text shrink-0">子题 {{cIdx+1}} · {{ typeLabel(child.data.type) }}</b>
            <span class="flex items-center gap-1.5 flex-wrap">
              <!-- 子题排序（FE-P1-05）：首/末位禁用而非隐藏，位置不跳动 -->
              <span class="inline-flex items-center gap-0.5" role="group" :aria-label="`调整第 ${cIdx+1} 个子题顺序`">
                <button
                  type="button"
                  class="btn btn-tiny !px-1.5"
                  :title="`上移子题 ${cIdx+1}`"
                  :aria-label="`上移子题 ${cIdx+1}`"
                  :disabled="!canMoveChild(cIdx, children.length, -1)"
                  @click="moveChildBy(cIdx, -1)"
                ><i class="i-lucide-chevron-up text-[13px]" /></button>
                <button
                  type="button"
                  class="btn btn-tiny !px-1.5"
                  :title="`下移子题 ${cIdx+1}`"
                  :aria-label="`下移子题 ${cIdx+1}`"
                  :disabled="!canMoveChild(cIdx, children.length, 1)"
                  @click="moveChildBy(cIdx, 1)"
                ><i class="i-lucide-chevron-down text-[13px]" /></button>
                <i
                  class="i-lucide-grip-vertical text-[14px] text-muted-light cursor-grab active:cursor-grabbing px-0.5 touch-none"
                  title="拖拽调整顺序"
                  @pointerdown="onChildDragStart(cIdx, $event)"
                />
              </span>
              <!-- 子题改题型（FE-P1-05）：onChildTypeChange 原先是死代码，从未接到任何控件 -->
              <select
                :value="child.data.type"
                class="select px-1.5 py-1 text-[12px] w-auto"
                title="改子题题型（已填内容按「切换题型时保留内容」设置复用）"
                :aria-label="`第 ${cIdx+1} 个子题的题型`"
                @change="onChildTypeChange(cIdx, valueOf($event))"
              >
                <option v-for="t in CHILD_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
              <label class="text-[12px] text-muted">分</label>
              <input v-model.number="child.data.score" type="number" class="input px-1.5 py-1 text-[12px] w-[60px]" @change="onChildUpdate(cIdx, child.data)" />
              <label class="text-[12px] text-muted">难度</label>
              <select v-model.number="child.data.difficulty" class="select px-1.5 py-1 text-[12px] w-[64px]" @change="onChildUpdate(cIdx, child.data)">
                <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
              </select>
              <button
                type="button"
                class="btn btn-small btn-danger"
                :title="`删除子题 ${cIdx+1}`"
                :aria-label="`删除子题 ${cIdx+1}`"
                @click="removeChild(cIdx)"
              ><i class="i-lucide-trash-2" />删除</button>
            </span>
          </div>
          <QuestionForm v-if="!dragMode" :key="child._uid" :question="child.data" :show-score="false" @update="v=>onChildUpdate(cIdx,v)" />
          <!--
            拖拽期间折叠正文：单卡实测 1227px，比 1024 最小窗可视高 768px 还高。
            不折叠时相邻两张卡的中线不同屏，必须拖 280px+ 才能让指示线跳一位（实测），
            既看不出在拖也没法准对位。折叠后全部子题一眼看完，拖过一行即到位。
          -->
          <div v-else class="text-[11px] text-muted truncate pl-1">{{ childSummary(child.data) }}</div>
          </div>
          <!-- 插入位指示线：拖拽时显示「将插到这里」 -->
          <div
            v-if="childDragFrom >= 0 && childDragInsertAt >= 0"
            class="h-[2px] rounded-full bg-primary mx-1 pointer-events-none"
            :style="insertLineStyle"
          />
        </div>
        <div class="flex gap-1.5 flex-wrap mt-2">
          <button v-for="t in CHILD_TYPES" :key="t.key" class="btn btn-small" @click="addChild(t.key)"><i class="i-lucide-plus" />{{ t.label }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * QuestionEditor — 顶层调度器（schema v2）
 * material 母题不存 score；总分 = sum(children.score)，只读展示。
 */
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import TiptapDocEditor from './TiptapDocEditor.vue'
import QuestionForm from './QuestionForm.vue'
import PasteBox from './PasteBox.vue'
import { settings } from '@/stores/settings.js'
import { QUESTION_TYPES, QUESTION_TYPE_MAP, CHILD_QUESTION_TYPES as CHILD_TYPES, typeLabel } from '@/constants/questions.js'
import { createDefaultQuestion } from '@/utils/gradeQuestion.js'
import { valueOf } from '@/utils/domEvent.js'
import { toast } from '@/stores/ui.js'
import {
  childIdSeed, childIdForAppend, dedupeChildIds, moveChild, canMoveChild, removeChildAt,
  insertionIndexFromY, insertIndexToMoveTarget, edgeScrollDelta
} from '@/utils/materialChildren.js'

const props = defineProps({ modelValue: Object })
const emit = defineEmits(['update:modelValue'])

const local = reactive(JSON.parse(JSON.stringify(props.modelValue || createDefault('single'))))
const formKey = ref(0)
const showPaste = ref(false)

const totalScore = computed(()=> (local.children||[]).reduce((s,c)=> s + (Number(c.score)||0), 0))
// 难度 = 子题分值加权平均，四舍五入取整对齐 1..5
const materialDifficulty = computed(()=>{
  const cs = local.children||[]
  const total = totalScore.value
  if(!cs.length || !total) return 3
  const w = cs.reduce((s,c)=> s + (Number(c.score)||0)*(Number(c.difficulty)||3), 0) / total
  return Math.min(5, Math.max(1, Math.round(w)))
})

function createDoc(text){
  // 空文本产出空段落（不带 content），而非空 text 节点——后者被 ProseMirror 视为非法
  const t = String(text||'')
  return t
    ? { type:'doc', content:[{ type:'paragraph', content:[{type:'text', text:t}]}]}
    : { type:'doc', content:[{ type:'paragraph' }]}
}
// 各题型默认模板的唯一实现在 utils/gradeQuestion.js（注册表 createDefault），这里只做分发；
// 未知题型保留历史兜底（1 个选项的单选），避免将来脏数据把编辑器打空。
function createDefault(type){
  if (QUESTION_TYPE_MAP[type]) return createDefaultQuestion(type)
  return {
    difficulty:2, score:5, analysis:null, plain_text:'',
    type:'single', stem:createDoc('题干'),
    options:[{id:'o1',content:createDoc('选项A')}], answer:{ids:['o1']}
  }
}

// ---------- 主试题 ----------
let lastEmitted = null
function onFormUpdate(payload){
  for(const k of Object.keys(local)) delete local[k]
  Object.assign(local, JSON.parse(JSON.stringify(payload)))
  lastEmitted = JSON.parse(JSON.stringify(local))
  emit('update:modelValue', lastEmitted)
}
function onMainTypeChange(newType){
  if(newType === local.type) return
  let def
  if (settings.keepContentOnTypeChange) {
    def = preserveTypeChange(local, newType)
  } else {
    const keepStem = JSON.parse(JSON.stringify(local.stem || createDoc('')))
    def = createDefault(newType)
    def.id = local.id
    def.stem = preservedStem(keepStem, newType) || def.stem
  }
  replaceLocal(def)
}

function preservedStem(stem, newType){
  if(!stem?.content?.length) return null
  if(newType === 'fill'){
    let has=false
    ;(function w(n){ if(!n) return; if(n.type==='blank') has=true; if(n.content) n.content.forEach(w) })(stem)
    return has ? stem : null
  }
  ;(function clean(n){
    if(!n) return null
    if(n.type==='blank') return null
    if(n.content) n.content = n.content.map(clean).filter(Boolean)
    return n
  })(stem)
  if(!stem.content.length) return null
  return stem
}

/* ---------- 类型切换保持内容完整性（设置 keepContentOnTypeChange 启用时） ---------- */
const cloneQ = (o) => JSON.parse(JSON.stringify(o))
const CHOICE_TYPES = ['single', 'multi', 'judge']

// 题干纯文本（去 blank/图片等节点，只要文字）
function stemTextOf(stem) {
  const parts = []
  ;(function w(n) {
    if (!n) return
    if (n.type === 'text' && n.text) parts.push(n.text)
    if (n.content) n.content.forEach(w)
  })(stem)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function defaultOptions(n = 4) {
  const names = ['选项A', '选项B', '选项C', '选项D', '选项E', '选项F']
  const arr = []
  for (let i = 0; i < n; i++) arr.push({ id: `o${i + 1}`, content: createDoc(names[i] || `选项${i + 1}`) })
  return arr
}

function judgeOptions() {
  return [
    { id: 'o1', content: createDoc('正确') },
    { id: 'o2', content: createDoc('错误') },
  ]
}

// 单题互切：保留题干/分值/难度/解析，选项答案尽量映射复用
function preserveSingle(old, newType) {
  const wasChoice = CHOICE_TYPES.includes(old.type)
  const q = {
    type: newType,
    id: old.id,
    difficulty: old.difficulty ?? 2,
    score: old.score ?? (newType === 'judge' ? 2 : newType === 'short' ? 10 : 5),
    stem: null,
    analysis: old.analysis || null,
    plain_text: '',
  }
  // 问答参考答案转存为解析（反向在 short 分支处理），避免内容丢失
  if (old.type === 'short' && newType !== 'short') {
    q.analysis = old.answer?.reference || old.analysis || null
  }
  // 题干：fill 无 blank 时保留纯文字；其余去 blank 节点保留
  if (newType === 'fill') {
    let has = false
    ;(function w(n) { if (!n) return; if (n.type === 'blank') has = true; if (n.content) n.content.forEach(w) })(old.stem)
    if (has) q.stem = cloneQ(old.stem)
    else {
      const t = stemTextOf(old.stem)
      q.stem = t ? createDoc(t) : createDefault('fill').stem
    }
  } else {
    const text = stemTextOf(old.stem)
    q.stem = preservedStem(cloneQ(old.stem || createDoc('')), newType)
      || (text ? createDoc(text) : createDefault(newType).stem)
  }

  if (newType === 'single' || newType === 'multi') {
    q.options = wasChoice && old.options?.length >= 2 ? cloneQ(old.options) : defaultOptions(4)
    while (q.options.length < 2) q.options.push({ id: `o${q.options.length + 1}`, content: createDoc(`选项${q.options.length + 1}`) })
    const set = new Set(q.options.map((o) => o.id))
    let ids = ((old.answer?.ids) || []).filter((id) => set.has(id))
    if (newType === 'single') ids = ids.slice(0, 1)
    if (!ids.length) ids = [q.options[0].id]
    q.answer = { ids }
  } else if (newType === 'judge') {
    q.options = judgeOptions()
    // 原首个有效答案为 o1 → 正确，否则 → 错误；无答案默认正确
    let correct = true
    if (wasChoice) {
      const set = new Set((old.options || []).map((o) => o.id))
      const first = ((old.answer?.ids) || []).find((id) => set.has(id))
      if (first != null) correct = first === 'o1'
    }
    q.answer = { ids: [correct ? 'o1' : 'o2'] }
  } else if (newType === 'fill') {
    if (old.type === 'fill') q.answer = cloneQ(old.answer || { blanks: [] })
    else q.answer = { blanks: [] }
  } else if (newType === 'short') {
    const ref = old.type === 'short' ? old.answer?.reference : old.analysis || null
    q.answer = { reference: ref ? cloneQ(ref) : createDoc('参考答案') }
    // 解析已转存为参考答案，不再重复保留
    if (old.type !== 'short') q.analysis = null
  }
  return q
}

// 含材料互切的完整切换
function preserveTypeChange(old, newType) {
  // 材料 → 单题：首个子题整体接管（类型内容全保留）， analysis 取子题或材料级
  if (old.type === 'material' && newType !== 'material') {
    const kids = old.children || []
    const first = kids[0] && kids[0].type !== 'material' ? cloneQ(kids[0]) : null
    let base
    if (first) {
      base = first
      base.analysis = first.analysis || old.analysis || null
      base.score = first.score ?? 5
      base.difficulty = first.difficulty ?? 3
    } else {
      base = createDefault('single')
      const t = stemTextOf(old.stem)
      base.stem = t ? createDoc(t) : cloneQ(old.stem)
      base.analysis = old.analysis || null
    }
    base.id = old.id
    delete base.children
    if (base.type !== newType) return preserveSingle(base, newType)
    base.plain_text = ''
    return base
  }
  // 单题 → 材料：原题原样成为子题 1（类型保留零丢失），原题干转纯文本作材料正文
  if (newType === 'material') {
    const mat = createDefault('material')
    mat.id = old.id
    const t = stemTextOf(old.stem)
    mat.stem = t ? createDoc(t) : createDoc('阅读下列材料：')
    const child = cloneQ(old)
    delete child.id
    delete child.children
    delete child.plain_text
    child.score = child.score ?? 5
    child.difficulty = child.difficulty ?? 2
    mat.children = [child]
    mat.analysis = old.analysis || null
    return mat
  }
  return preserveSingle(old, newType)
}

function replaceLocal(def){
  for(const k of Object.keys(local)) delete local[k]
  Object.assign(local, JSON.parse(JSON.stringify(def)))
  formKey.value++
  children.value = (local.children||[]).map(wrapChild)
  emitUpdate()
}

// 对外：整体重置为指定题型的新模板（连录下一题用，保留难度/分值）
function resetTo(type, keep) {
  const def = createDefault(type || 'single')
  if (keep) {
    if (keep.difficulty != null) def.difficulty = keep.difficulty
    if (keep.score != null) def.score = keep.score
  }
  replaceLocal(def)
}
defineExpose({ resetTo })

// ---------- material ----------
const children = ref([])
let uidSeq = 0
const wrapChild = (c)=>({ _uid:`u${++uidSeq}`, data:c })
children.value = (local.children||[]).map(wrapChild)

function onMaterialStem(doc){ local.stem = doc; emitUpdate() }

function onChildUpdate(cIdx, payload){
  children.value[cIdx].data = payload
  local.children[cIdx] = payload
  emitUpdate()
}
function onChildTypeChange(cIdx, newType){
  const child = children.value[cIdx]
  if (!child || newType === child.data.type) return
  let def
  if (settings.keepContentOnTypeChange) {
    def = preserveTypeChange(child.data, newType)
  } else {
    const keepStem = JSON.parse(JSON.stringify(child.data.stem || createDoc('')))
    def = createDefault(newType)
    def.stem = preservedStem(keepStem, newType) || def.stem
  }
  // 子题 id 必须原样保留：它是答题记录（detail.child_id）的引用锚点，
  // 重编会让历史回看指向别的题。只要没换位置，id 就不该变。
  def.id = child.data.id
  child.data = def
  child._uid = `u${++uidSeq}`
  local.children[cIdx] = def
  emitUpdate()
}
function addChild(type){
  const def = createDefault(type)
  // 只有已持久化的题才前端发号；新建题交给后端 ensure_child_ids 按新父 id 分配，
  // 否则写死 q_c1 会让所有新建材料题的子题撞号（详见 utils/materialChildren.js）
  const newId = childIdForAppend(local, local.children)
  if (newId) def.id = newId
  def.stem = createDoc(`子题${local.children.length+1}`)
  local.children.push(def)
  children.value.push(wrapChild(def))
  emitUpdate()
}
function removeChild(idx){
  const r = removeChildAt(local.children, idx)
  // removeChildAt 返回 {error} | {children}，按 'in' 判别而不是读可能不存在的字段
  if ('error' in r) {
    if (r.error === 'empty') {
      // 子题清空后会变成「抽得到但点不进去」的空材料题，而列表里看不出异常
      toast('材料题至少要保留 1 个子题；要换成单题请改题型', 'error')
    }
    return
  }
  local.children = r.children
  children.value = r.children.map(wrapChild)
  emitUpdate()
}

// ---------- 子题排序（FE-P1-05）----------
const childListEl = ref(null)
const childDragFrom = ref(-1)
/** 当前插入位（0..children.length）；-1 表示未在拖拽 */
const childDragInsertAt = ref(-1)

/** 拖拽期间折叠子题正文（单卡 1227px，必须折叠才能一眼看完、快速对位） */
const dragMode = computed(() => childDragFrom.value >= 0)

/** 折叠态的一行摘要：拖拽时靠它分辨是哪道题（题干首段文字优先） */
function childSummary(q) {
  const t = stemTextOf(q && q.stem)
  if (t) return t
  const n = Array.isArray(q && q.options) ? q.options.length : 0
  return n ? `（${n} 个选项，未填题干）` : '（未填写）'
}

/**
 * 插入指示线的位置：算到第几张卡片处，就把线画在那张卡的上沿。
 * 不用重新排序 DOM（那会在拖拽中改变坐标、造成逐帧抖动）。
 */
/** @type {import('vue').ComputedRef<import('vue').CSSProperties|null>} */
const insertLineStyle = computed(() => {
  const list = childListEl.value
  const at = childDragInsertAt.value
  if (!list || at < 0) return null
  const cards = [...list.querySelectorAll('[data-child-card]')]
  if (!cards.length) return null
  const base = list.getBoundingClientRect().top
  let y
  if (at <= 0) y = cards[0].getBoundingClientRect().top - base - 3
  else if (at >= cards.length) {
    const last = cards[cards.length - 1].getBoundingClientRect()
    y = last.bottom - base + 3
  } else y = cards[at].getBoundingClientRect().top - base - 3
  return { top: `${y}px`, left: '0', right: '0', position: 'absolute' }
})

/**
 * 每张卡片中线的**视口坐标**（clientY 同一坐标系）。
 *
 * 必须与指针同为视口坐标：滚动会同时改变卡片中线与指针的视口位置，二者保持可比。
 * 曾误用文档坐标，结果自动滚动反而让指针「后退」，插入位恒为 0。
 */
function childCardMids() {
  const list = childListEl.value
  if (!list) return []
  return [...list.querySelectorAll('[data-child-card]')].map((el) => {
    const r = el.getBoundingClientRect()
    return r.top + r.height / 2
  })
}

let dragScrollTimer = 0
let lastPointerY = 0

/**
 * 开始拖拽：**用 pointer 事件自实现，不用 HTML5 DnD**。
 *
 * 为什么不用原生 DnD（实测踩过的两个坑）：
 * ① 落点靠 `drop` 事件的 target 判定，要求指针恰好落在某张卡上。单卡实测 1227px
 *    而 1024 最小窗可视高仅 768px —— 拖一行仍在同一张卡内（from === to）、
 *    拖到卡片间隙或页面空白则没有元素接收 drop。两种都是静默失败，看不到任何报错。
 * ② 原生 DnD 的自动滚动在本页面会失控（实测 scrollY 138 → 3288，
 *    目标区块被甩出视口）。
 * pointer 方案自己按坐标算插入位、自己控滚动，两个问题一起消失。
 */
function onChildDragStart(cIdx, e) {
  if (e.button != null && e.button !== 0) return
  // 阻止这次按下的默认行为（文本选中开始 / 原生图片拖拽）
  e.preventDefault()
  childDragFrom.value = cIdx
  childDragInsertAt.value = cIdx
  lastPointerY = e.clientY
  // 关键：只 preventDefault 不够，必须**全局禁用文本选中**。
  // 实测：从卡片任意位置按下拖动（用户很可能直接抓标题或空白处，不只抓手柄），
  // 会把「分」「难度」「题干」这些字选中并高亮，松手后还残留 —— 看上去完全不像拖拽，
  // 像误操作。preventDefault 只对 pointerdown 自身生效，后续 pointermove 仍会扩展选区。
  document.documentElement.classList.add('qbank-dragging')
  window.addEventListener('pointermove', onDragPointerMove)
  window.addEventListener('pointerup', onDragPointerUp)
  window.addEventListener('pointercancel', onDragPointerUp)
  startDragScrollLoop()
}

function onDragPointerMove(e) {
  if (childDragFrom.value < 0) return
  lastPointerY = e.clientY
  const at = insertionIndexFromY(e.clientY, childCardMids())
  if (at >= 0) childDragInsertAt.value = at
}

/**
 * 指针靠近视口上下边缘时自动滚动（卡片高于视口时必须靠它才能跨题拖）。
 *
 * 用 setInterval 而不是 requestAnimationFrame：rAF 在后台标签页不触发，
 * 且 e2e 装时钟后也需要能被显式驱动；定时器两条路都稳。
 */
function startDragScrollLoop() {
  stopDragScrollLoop()
  dragScrollTimer = setInterval(() => {
    if (childDragFrom.value < 0) return
    const d = edgeScrollDelta(lastPointerY, 0, window.innerHeight)
    if (!d) return
    window.scrollBy(0, d)
    // 滚动后卡片的文档位置不变，但指针的文档坐标变了 → 重新算插入位
    const at = insertionIndexFromY(lastPointerY, childCardMids())
    if (at >= 0) childDragInsertAt.value = at
  }, 16)
}

function stopDragScrollLoop() {
  if (dragScrollTimer) clearInterval(dragScrollTimer)
  dragScrollTimer = 0
}

function onDragPointerUp() {
  const from = childDragFrom.value
  const at = childDragInsertAt.value
  onChildDragEnd()
  if (from < 0 || at < 0) return
  const to = insertIndexToMoveTarget(from, at, children.value.length)
  if (to === from) return
  moveChildTo(from, to)
}

function onChildDragEnd() {
  stopDragScrollLoop()
  document.documentElement.classList.remove('qbank-dragging')
  window.removeEventListener('pointermove', onDragPointerMove)
  window.removeEventListener('pointerup', onDragPointerUp)
  window.removeEventListener('pointercancel', onDragPointerUp)
  childDragFrom.value = -1
  childDragInsertAt.value = -1
}

/**
 * 消除子题 id 重复（只修重复，不补缺失）。重复意味着同一材料里两道题同号，
 * `detail.child_id` 回看只能命中第一个 —— 成绩张冠李戴，而界面上完全看不出来。
 */
function normalizeChildIdsInPlace() {
  const list = Array.isArray(local.children) ? local.children : []
  const next = dedupeChildIds(list, local.id ? childIdSeed(local) : null)
  next.forEach((c, i) => {
    if (!c || c === list[i]) return
    if (typeof c.id === 'string' && c.id) list[i].id = c.id
    else delete list[i].id
  })
}

/**
 * 移动子题：上移/下移/拖拽三路共用 moveChild（底层是 utils/arrayMove.js::moveItem）。
 * 只挪位置，不重编 id —— 见 utils/materialChildren.js 文件头的取舍说明。
 */
function moveChildTo(from, to) {
  const next = moveChild(local.children || [], from, to)
  if (!next) return
  local.children = next
  children.value = next.map(wrapChild)
  normalizeChildIdsInPlace()
  emitUpdate()
}

function moveChildBy(cIdx, dir) {
  moveChildTo(cIdx, cIdx + dir)
}

onBeforeUnmount(() => onChildDragEnd())

// ---------- 外部整体替换（切换编辑的题目）----------
watch(()=>props.modelValue, (m)=>{
  if(!m) return
  if(m===lastEmitted) return
  if(JSON.stringify(m)===JSON.stringify(lastEmitted)) return // 自己发出的回声
  for(const k of Object.keys(local)) delete local[k]
  Object.assign(local, JSON.parse(JSON.stringify(m)))
  formKey.value++
  children.value = (local.children||[]).map(wrapChild)
}, {deep:false})

function onPasteParsed(q){
  // 保留当前 id，整体替换为解析结果
  const id = local.id
  const parsed = JSON.parse(JSON.stringify(q))
  if(id) parsed.id = id
  for(const k of Object.keys(local)) delete local[k]
  Object.assign(local, parsed)
  formKey.value++
  children.value = (local.children||[]).map(wrapChild)
  emitUpdate()
}
function onPasteAndClose(q){ onPasteParsed(q); showPaste.value=false }

function emitUpdate(){
  if(local.type==='material'){
    // 派生字段自动计算入库（可搜索/组卷直接用）
    local.score = totalScore.value
    local.difficulty = materialDifficulty.value
  }
  if(local.stem) local.plain_text = extractPlain(local.stem)
  lastEmitted = JSON.parse(JSON.stringify(local))
  emit('update:modelValue', lastEmitted)
}
function extractPlain(doc){
  if(!doc||!doc.content) return ''
  return doc.content.map(n=>{
    if(n.type==='paragraph') return (n.content||[]).map(c=> c.type==='text'?c.text : c.type==='inlineMath'?c.attrs.latex : c.type==='blank'?'___':'').join('')
    if(n.type==='imageBlock') return ' [图] '
    return ''
  }).join(' ').trim()
}
</script>


<style>
/*
  拖拽中全局禁选：只靠 pointerdown 的 preventDefault 不够 —— 它只作用于按下那一刻，
  后续 pointermove 仍会扩展选区。实测从卡片任意位置（标题、空白、正文）按下拖动，
  会把「分」「难度」「题干」等文字选中并高亮，松手后还残留，看上去像误操作。
  !important 是为了盖过编辑器内部（ProseMirror）自己的 user-select 规则。
*/
html.qbank-dragging,
html.qbank-dragging * {
  user-select: none !important;
  -webkit-user-select: none !important;
}
/* 拖拽中光标保持抓取态，不随悬停元素变化，避免「到底在拖还是点」的困惑 */
html.qbank-dragging,
html.qbank-dragging * {
  cursor: grabbing !important;
}
</style>
