<template>
  <div class="flex flex-col gap-2.5">
    <div v-if="showScore" class="flex items-center gap-1.5 flex-wrap">
      <label class="text-[13px] text-text-secondary">分值</label>
      <input v-model.number="local.score" type="number" class="input px-2 py-1.5 text-[12px] w-[80px]" @change="emitUpdate" />
      <label class="text-[13px] text-text-secondary ml-3">难度</label>
      <select v-model.number="local.difficulty" class="select px-2 py-1.5 text-[12px] w-[80px]" @change="emitUpdate">
        <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
      </select>
    </div>

    <div class="bg-card border border-line rounded-[8px] p-2.5">
      <h3 class="m-0 mb-1.5 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-help-circle text-primary text-[14px]" />题干</h3>
      <TiptapDocEditor :modelValue="local.stem" :showBlank="local.type==='fill'" @update:modelValue="onStemUpdate" @blankInserted="onBlankInserted" />
    </div>

    <div v-if="['single','multi','judge'].includes(local.type)" class="bg-card border border-line rounded-[8px] p-2.5">
      <h3 class="m-0 mb-1.5 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-list-checks text-primary text-[14px]" />选项</h3>
      <OptionBlock
        v-for="(opt, idx) in local.options"
        :key="opt.id || idx"
        :modelValue="opt"
        :displayKey="displayKeys[idx]"
        :isCorrect="local.answer?.ids?.includes(opt.id)"
        compact
        @update:modelValue="onOptionUpdate(idx,$event)"
        @toggle="toggleAnswer(idx)"
        @remove="removeOption(idx)"
        :removable="local.options.length>2"
      />
      <button class="btn btn-small" @click="addOption" v-if="local.type!=='judge'"><i class="i-lucide-plus" />选项</button>
    </div>

    <div v-if="local.type==='fill'" class="bg-card border border-line rounded-[8px] p-2.5">
      <h3 class="m-0 mb-1.5 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-pencil-line text-primary text-[14px]" />填空答案</h3>
      <div v-for="(b, idx) in blanks" :key="b.id" class="flex items-center gap-1.5 mb-1">
        <span class="text-[12px] min-w-[28px]">空{{idx+1}}</span>
        <input v-model="fillAnswers[idx]" placeholder="答案，逗号分隔多解" class="input flex-1 px-2 py-1.5 text-[12px]" @input="updateFillAnswer" />
      </div>
      <div v-if="blanks.length===0" class="text-muted text-[11px] flex items-center gap-1"><i class="i-lucide-info text-[12px]" />在题干编辑器点“__ 填空”插入填空位</div>
    </div>

    <div v-if="local.type==='short'" class="bg-card border border-line rounded-[8px] p-2.5">
      <h3 class="m-0 mb-1.5 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-book-open text-primary text-[14px]" />参考答案</h3>
      <TiptapDocEditor :modelValue="local.answer?.reference || emptyDoc()" :showBlank="false" @update:modelValue="onReferenceDoc" />
    </div>

    <div class="bg-card border border-line rounded-[8px] p-2.5">
      <h3 class="m-0 mb-1.5 text-[13px] font-700 text-text font-[var(--serif)] flex items-center gap-1.5"><i class="i-lucide-lightbulb text-primary text-[14px]" />解析</h3>
      <TiptapDocEditor :modelValue="local.analysis || emptyDoc()" :showBlank="false" @update:modelValue="onAnalysisDoc" />
    </div>
  </div>
</template>

<script setup>
/**
 * QuestionForm — 单道（非材料）试题编辑表单（schema v2）
 * blank 用 attrs.id (b1..bn) 绑定答案；option 用 id (o1..on)；key 运行时生成不落库。
 */
import { ref, reactive, computed } from 'vue'
import TiptapDocEditor from './TiptapDocEditor.vue'
import OptionBlock from './OptionBlock.vue'

const props = defineProps({
  question: { type: Object, required: true },
  showScore: { type: Boolean, default: false } // 主试题 false（顶层行管理）；子题 true
})
const emit = defineEmits(['update'])

const local = reactive(JSON.parse(JSON.stringify(props.question)))
const fillAnswers = ref([])
const blanks = ref([])
// short：初始化保证 answer.reference 存在（参考答案与解析分离）
if(local.type==='short' && !local.answer) local.answer = { reference: emptyDoc() }

function createDoc(text){
  return { type:'doc', content:[{ type:'paragraph', content:[{type:'text', text:text||''}]}]}
}
function emptyDoc(){ return createDoc('') }

// 展示序号：运行时按下标 A/B/C/D（不落库）
const displayKeys = computed(()=> (local.options||[]).map((_,i)=>String.fromCharCode(65+i)))

// ---------- blank 派生 ----------
function stemBlankIds(stem){
  const list=[]
  ;(function walk(n){ if(!n) return; if(n.type==='blank') list.push(n.attrs?.id); if(n.content) n.content.forEach(walk) })(stem)
  return [...new Set(list)]
}
function syncFillAnswers(){
  const ids = stemBlankIds(local.stem)
  blanks.value = ids.map(id=>({id}))
  fillAnswers.value = ids.map(id=>{
    const b = local.answer?.blanks?.find(x=>x.id===id)
    return b ? b.answers.join(',') : ''
  })
}
function rebuildAnswerBlanks(){
  local.answer = { ...(local.answer||{}), blanks: blanks.value.map((b,i)=>({
    id: b.id,
    answers: (fillAnswers.value[i]||'').split(',').map(s=>s.trim()).filter(Boolean)
  }))}
}
if(local.type==='fill') syncFillAnswers()

// ---------- 输出 ----------
function emitUpdate(){
  local.plain_text = extractPlain(local.stem)
  emit('update', JSON.parse(JSON.stringify(local)))
}
function extractPlain(doc){
  if(!doc||!doc.content) return ''
  return doc.content.map(n=>{
    if(n.type==='paragraph') return (n.content||[]).map(c=> c.type==='text'?c.text : c.type==='inlineMath'?c.attrs.latex : c.type==='blank'?'___':'').join('')
    if(n.type==='imageBlock') return ' [图] '
    return ''
  }).join(' ').trim()
}

// ---------- 题干 ----------
function onStemUpdate(doc){
  const before = stemBlankIds(local.stem).join(',')
  local.stem = doc
  if(local.type==='fill'){
    const after = stemBlankIds(doc).join(',')
    if(after !== before) syncFillAnswers()
  }
  emitUpdate()
}
function onBlankInserted({id, text}){
  if(local.type!=='fill') return
  syncFillAnswers()
  const idx = blanks.value.findIndex(b=>b.id===id)
  while(fillAnswers.value.length <= idx) fillAnswers.value.push('')
  if(text) fillAnswers.value[idx] = text
  rebuildAnswerBlanks()
  emitUpdate()
}

// ---------- 选项 ----------
function onOptionUpdate(idx, val){
  local.options[idx] = val
  emitUpdate()
}
function toggleAnswer(idx){
  const opt = local.options[idx]
  if(!opt.id){
    opt.id = `o${local.options.indexOf(opt)+1}`
    const used = new Set(local.options.map(o=>o.id))
    while(used.has(opt.id)) opt.id = 'o'+(Number(opt.id.slice(1))+1)
  }
  if(!local.answer) local.answer={ids:[]}
  if(!Array.isArray(local.answer.ids)) local.answer.ids=[]
  if(local.type==='single' || local.type==='judge'){
    local.answer.ids = [opt.id]
  } else {
    const set = new Set(local.answer.ids)
    set.has(opt.id) ? set.delete(opt.id) : set.add(opt.id)
    local.answer.ids = [...set]
  }
  emitUpdate()
}
function addOption(){
  // id 取现有 max+1，避免删除后复用旧 id 造成答案错绑
  let max=0
  for(const o of local.options){ const m=/^o(\d+)$/.exec(o.id||''); if(m) max=Math.max(max,Number(m[1])) }
  const id=`o${max+1}`
  local.options.push({id, content:createDoc('选项'+id.replace('o',''))})
  emitUpdate()
}
function removeOption(idx){
  const removedId = local.options[idx]?.id
  const wasAnswer = local.answer?.ids?.includes(removedId)
  local.options.splice(idx,1)
  if(wasAnswer && local.answer) local.answer.ids = []
  emitUpdate() // key 运行时生成，无需重编
}

// ---------- 填空 / 解析 ----------
function updateFillAnswer(){
  rebuildAnswerBlanks()
  emitUpdate()
}
function onReferenceDoc(doc){
  local.answer = { ...(local.answer||{}), reference: isDocEmpty(doc) ? null : doc }
  emitUpdate()
}
function onAnalysisDoc(doc){
  local.analysis = isDocEmpty(doc) ? null : doc
  emitUpdate()
}
function isDocEmpty(doc){
  if(!doc || !doc.content) return true
  return doc.content.every(b=>{
    if(b.type==='paragraph') return !b.content || b.content.every(n=> !n.text || !n.text.trim())
    return false
  })
}
</script>

