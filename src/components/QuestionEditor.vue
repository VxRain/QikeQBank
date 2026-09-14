<template>
  <div class="flex flex-col gap-2.5">
    <div class="row type-row relative flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-1.5 flex-wrap">
        <label class="text-[13px] text-text-secondary">题型</label>
        <select :value="local.type" @change="onMainTypeChange($event.target.value)" class="select px-2 py-1.5 text-[12px] w-auto">
          <option value="single">单选</option>
          <option value="multi">多选</option>
          <option value="judge">判断</option>
          <option value="fill">填空</option>
          <option value="short">问答</option>
          <option value="material">材料（父子题）</option>
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
        <div v-for="(child, cIdx) in children" :key="child._uid" class="bg-bg-accent border border-line rounded-[8px] p-2.5 mb-2.5">
          <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <b class="text-[12px] text-text">子题 {{cIdx+1}} · {{ typeLabel(child.data.type) }}</b>
            <span class="flex items-center gap-1.5 flex-wrap">
              <label class="text-[12px] text-muted">分</label>
              <input v-model.number="child.data.score" type="number" class="input px-1.5 py-1 text-[12px] w-[60px]" @change="onChildUpdate(cIdx, child.data)" />
              <label class="text-[12px] text-muted">难度</label>
              <select v-model.number="child.data.difficulty" class="select px-1.5 py-1 text-[12px] w-[64px]" @change="onChildUpdate(cIdx, child.data)">
                <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
              </select>
              <button class="btn btn-small btn-danger" @click="removeChild(cIdx)"><i class="i-lucide-trash-2" />删除</button>
            </span>
          </div>
          <QuestionForm :key="child._uid" :question="child.data" :show-score="false" @update="v=>onChildUpdate(cIdx,v)" />
        </div>
        <div class="flex gap-1.5 flex-wrap mt-2">
          <button class="btn btn-small" @click="addChild('single')"><i class="i-lucide-plus" />单选</button>
          <button class="btn btn-small" @click="addChild('multi')"><i class="i-lucide-plus" />多选</button>
          <button class="btn btn-small" @click="addChild('judge')"><i class="i-lucide-plus" />判断</button>
          <button class="btn btn-small" @click="addChild('fill')"><i class="i-lucide-plus" />填空</button>
          <button class="btn btn-small" @click="addChild('short')"><i class="i-lucide-plus" />问答</button>
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
import { ref, reactive, computed, watch } from 'vue'
import TiptapDocEditor from './TiptapDocEditor.vue'
import QuestionForm from './QuestionForm.vue'
import PasteBox from './PasteBox.vue'
import { settings } from '@/stores/settings.js'

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
function createDefault(type){
  if(type==='material'){
    // v2: 母题无 score
    return { type:'material', difficulty:3, stem:createDoc('阅读下列材料：'),
      children:[
        { type:'single', score:5, stem:createDoc('子题1'),
          options:[
            {id:'o1',content:createDoc('选项A')},{id:'o2',content:createDoc('选项B')},
            {id:'o3',content:createDoc('选项C')},{id:'o4',content:createDoc('选项D')}
          ], answer:{ids:['o1']} },
        { type:'fill', score:5,
          stem:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'填空 '},{type:'blank',attrs:{id:'b1'}},{type:'text',text:' 元'}]}]},
          answer:{blanks:[{id:'b1',answers:['0']}]} }
      ], plain_text:'' }
  }
  const base = { difficulty:2, score:5, analysis:null, plain_text:'' }
  const opts4 = [
    {id:'o1',content:createDoc('选项A')},{id:'o2',content:createDoc('选项B')},
    {id:'o3',content:createDoc('选项C')},{id:'o4',content:createDoc('选项D')}
  ]
  if(type==='single') return { ...base, type:'single', stem:createDoc('题干'), options:opts4, answer:{ids:['o1']} }
  if(type==='multi') return { ...base, type:'multi', difficulty:3, stem:createDoc('多选题干'), options:opts4, answer:{ids:['o1','o2']} }
  if(type==='judge') return { ...base, type:'judge', difficulty:1, score:2, stem:createDoc('判断题'),
    options:[{id:'o1',content:createDoc('正确')},{id:'o2',content:createDoc('错误')}], answer:{ids:['o1']} }
  if(type==='fill') return { ...base, type:'fill',
    stem:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'填空 '},{type:'blank',attrs:{id:'b1'}},{type:'text',text:' 元'}]}]},
    answer:{blanks:[{id:'b1',answers:['0']}]} }
  if(type==='short') return { ...base, type:'short', difficulty:3, score:10, stem:createDoc('问答题干'), answer:{reference:createDoc('参考答案')}, analysis:null }
  return { ...base, type:'single', stem:createDoc('题干'),
    options:[{id:'o1',content:createDoc('选项A')}], answer:{ids:['o1']} }
}
function typeLabel(t){
  return ({single:'单选',multi:'多选',judge:'判断',fill:'填空',short:'问答'})[t] || t
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
  let def
  if (settings.keepContentOnTypeChange) {
    def = preserveTypeChange(child.data, newType)
  } else {
    const keepStem = JSON.parse(JSON.stringify(child.data.stem || createDoc('')))
    def = createDefault(newType)
    def.stem = preservedStem(keepStem, newType) || def.stem
  }
  child.data = def
  child._uid = `u${++uidSeq}`
  local.children[cIdx] = def
  emitUpdate()
}
function addChild(type){
  const def = createDefault(type)
  def.stem = createDoc(`子题${local.children.length+1}`)
  local.children.push(def)
  children.value.push(wrapChild(def))
  emitUpdate()
}
function removeChild(idx){
  local.children.splice(idx,1)
  children.value.splice(idx,1)
  emitUpdate()
}

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

