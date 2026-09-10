<template>
  <div class="editor">
    <!-- 题型 + (material: 只读总分/难度) + (非material: 可编辑分值/难度) -->
    <div class="row type-row" style="position:relative; justify-content:space-between">
      <div class="row">
        <label>题型</label>
        <select :value="local.type" @change="onMainTypeChange($event.target.value)" class="select">
          <option value="single">单选</option>
          <option value="multi">多选</option>
          <option value="judge">判断</option>
          <option value="fill">填空</option>
          <option value="short">问答</option>
          <option value="material">材料（父子题）</option>
        </select>
        <template v-if="local.type==='material'">
          <label style="margin-left:12px">总分</label>
          <span class="badge">{{ totalScore }} 分</span>
          <label style="margin-left:12px">难度</label>
          <span class="badge">{{ materialDifficulty }}（子题加权）</span>
        </template>
        <template v-else>
          <label style="margin-left:12px">分值</label>
          <input v-model.number="local.score" type="number" class="input" style="width:80px" @change="emitUpdate" />
          <label style="margin-left:12px">难度</label>
          <select v-model.number="local.difficulty" class="select" style="width:80px" @change="emitUpdate">
            <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
          </select>
        </template>
      </div>
      <button class="icon-btn" @click="showPaste=!showPaste" title="粘贴智能填入">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
        智能粘贴
      </button>
      <div v-if="showPaste" class="paste-popover">
        <PasteBox @parsed="onPasteAndClose" />
      </div>
    </div>
    <div v-if="showPaste" class="paste-backdrop" @click="showPaste=false"></div>

    <!-- 非材料：单题表单复用 -->
    <QuestionForm
      v-if="local.type!=='material'"
      :key="'main-'+formKey"
      :question="local"
      @update="onFormUpdate"
    />

    <!-- 材料：材料 stem + 子题列表（子题复用 QuestionForm） -->
    <template v-else>
      <div class="section">
        <div class="row" style="justify-content:space-between;margin-bottom:6px">
          <h3 style="margin:0">材料</h3>
          <span class="muted">总分：{{ totalScore }} 分（= 子题分值之和，自动计算）</span>
        </div>
        <TiptapDocEditor :modelValue="local.stem" :showBlank="false" @update:modelValue="onMaterialStem" />
      </div>

      <div class="section">
        <h3>子题（{{children.length}}）</h3>
        <div v-for="(child, cIdx) in children" :key="child._uid" class="sub-card">
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <b>子题 {{cIdx+1}} · {{ typeLabel(child.data.type) }}</b>
            <span class="row">
              <label style="font-size:12px;color:var(--muted)">分</label>
              <input v-model.number="child.data.score" type="number" class="input" style="width:60px" @change="onChildUpdate(cIdx, child.data)" />
              <label style="font-size:12px;color:var(--muted)">难度</label>
              <select v-model.number="child.data.difficulty" class="select" style="width:64px" @change="onChildUpdate(cIdx, child.data)">
                <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option>
              </select>
              <button class="btn small danger" @click="removeChild(cIdx)">删除</button>
            </span>
          </div>
          <QuestionForm :key="child._uid" :question="child.data" :show-score="false" @update="v=>onChildUpdate(cIdx,v)" />
        </div>
        <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn small" @click="addChild('single')">+单选</button>
          <button class="btn small" @click="addChild('multi')">+多选</button>
          <button class="btn small" @click="addChild('judge')">+判断</button>
          <button class="btn small" @click="addChild('fill')">+填空</button>
          <button class="btn small" @click="addChild('short')">+问答</button>
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
  return { type:'doc', content:[{ type:'paragraph', content:[{type:'text', text:text||''}]}]}
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
  const keepStem = JSON.parse(JSON.stringify(local.stem || createDoc('')))
  const def = createDefault(newType)
  def.id = local.id
  def.stem = preservedStem(keepStem, newType) || def.stem
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
  const keepStem = JSON.parse(JSON.stringify(child.data.stem || createDoc('')))
  const def = createDefault(newType)
  def.stem = preservedStem(keepStem, newType) || def.stem
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

<style scoped>
.editor{ display:flex; flex-direction:column; gap:10px }
.row{ display:flex; align-items:center; gap:6px; flex-wrap:wrap }
.row label{ font-size:13px; color:var(--text-secondary) }
.section{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px }
.section h3{ margin:0 0 6px; font-size:13px; font-weight:700; color:var(--text) }
.input{ background:var(--card); border:1px solid var(--line); border-radius:6px; color:var(--text); padding:6px 8px; font-size:12px }
.select{ background:var(--card); border:1px solid var(--line); border-radius:6px; color:var(--text); padding:6px 8px; font-size:12px }
.btn{ background:var(--card); border:1px solid var(--line); color:var(--text-secondary); padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px; font-weight:500 }
.btn:hover{ background:var(--bg-accent); border-color:var(--line-strong) }
.btn.small{ padding:4px 8px; font-size:11px }
.btn.danger{ border-color:#fecaca; color:var(--danger); background:#fff }
.sub-card{ background:var(--bg-accent); border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:10px }
.sub-card .row b{ font-size:12px; color:var(--text) }
.muted{ color:var(--muted); font-size:11px }
.icon-btn{ display:inline-flex; align-items:center; gap:4px; background:var(--card); border:1px solid var(--line); color:var(--text-secondary); padding:5px 10px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:500 }
.icon-btn:hover{ background:var(--bg-accent); border-color:var(--line-strong); color:var(--text) }
.type-row{ position:relative }
.paste-popover{ position:absolute; top:calc(100% + 8px); right:0; width:min(560px, 92vw); z-index:30; background:var(--card); border:1px solid var(--line); border-radius:12px; box-shadow:0 12px 32px rgba(0,0,0,.12); padding:12px }
.paste-backdrop{ position:fixed; inset:0; z-index:20; background:transparent }
</style>
