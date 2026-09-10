<template>
  <div class="form-page">
    <div class="card">
      <div class="card-head">
        <h2>
          {{ isEdit ? '编辑试题' : '新增试题' }}
          <span class="badge">{{ form.type }}</span>
          <span class="badge">所属题库：{{ bankBadgeText }}</span>
        </h2>
        <div class="row">
          <button class="btn" @click="goBack">返回列表</button>
          <button class="btn primary" @click="onSave" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
        </div>
      </div>
      <div v-if="error" class="error">{{ error }}</div>
      <div v-if="loading" class="muted">加载中...</div>
      <div v-else class="form-grid">
        <div class="editor-col">
          <QuestionEditor v-model="form" />
        </div>
        <div class="preview-col">
          <h3 style="margin:0 0 8px;color:var(--text);font-weight:700">实时预览（Web真渲染）</h3>
          <QuestionPreview :question="form" />
          <div style="margin-top:14px;padding:12px;background:var(--bg-accent);border:1px solid var(--line);border-radius:var(--radius)">
            <h4 style="margin:0 0 6px;color:var(--muted);font-size:13px;font-weight:600">校验</h4>
            <div v-if="validation.valid" class="badge ok">✓ 校验通过</div>
            <div v-else class="badge bad">✗ {{ validation.errors.join('; ') }}</div>
          </div>
          <details style="margin-top:12px">
            <summary style="cursor:pointer;color:var(--muted);font-size:12px;font-weight:500">查看 Blocks JSON</summary>
            <pre style="margin-top:8px;background:#0f172a;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:11px;max-height:300px;color:#e2e8f0">{{ prettyJSON }}</pre>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { get, create, update } from '@/api/questions.js'
import { normalizeQuestion, getAggregatedPlainText } from '@/utils/normalize.js'
import { bankStore, setCurrentBank } from '@/stores/bank.js'
import QuestionEditor from '@/components/QuestionEditor.vue'
import QuestionPreview from '@/components/QuestionPreview.vue'
import { validateQuestion } from '@/utils/validate.js'

const route = useRoute()
const router = useRouter()
const isEdit = computed(()=> !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

function createDefault(){
  // v2 schema：option 无 key；blank 用 b1..；material 母题无 score
  const doc=(t)=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:t}]}]})
  return {
    version: 2,
    type: 'single',
    difficulty: 2,
    score: 5,
    stem: doc('题干'),
    options: [
      { id:'o1', content:doc('选项A') },
      { id:'o2', content:doc('选项B') },
      { id:'o3', content:doc('选项C') },
      { id:'o4', content:doc('选项D') }
    ],
    answer: { ids:['o1'] },
    analysis: null,
    plain_text: '',
    created_at: new Date().toISOString()
  }
}

const form = ref(createDefault())

const validation = computed(()=>{
  try{ return validateQuestion(form.value) } catch(e){ return { valid:false, errors:[String(e)] } }
})
const prettyJSON = computed(()=> JSON.stringify(form.value, null, 2))

// 卡头「所属题库」徽章文案
// 编辑：显示该题 bank_id 对应的库名，找不到则回退显示 bank_id 原文
// 新建：优先 ?bank= 路由参数，其次 currentBankId，均无回退 banks[0]
const targetBankId = computed(()=>{
  if(isEdit.value) return form.value?.bank_id || ''
  const qb = route.query.bank
  if (typeof qb === 'string' && qb) return qb
  return bankStore.currentBankId || bankStore.banks[0]?.id || ''
})
const bankBadgeText = computed(()=>{
  if(isEdit.value){
    const bid = form.value?.bank_id
    if(!bid) return '未归属'
    const bank = bankStore.banks.find(b=> b.id === bid)
    return bank ? bank.name : bid
  }
  const bank = bankStore.banks.find(b=> b.id === targetBankId.value)
  return (bank ? bank.name : (targetBankId.value || '未选择')) + '（新题将存入）'
})

// 返回目标：从题库语境进入则回到该库列表，否则回首页
function backTarget(){
  if(isEdit.value){
    const bid = form.value?.bank_id
    return bid ? `/library?bank=${bid}` : '/library'
  }
  const qb = route.query.bank
  if (typeof qb === 'string' && qb) return `/library?bank=${qb}`
  return '/'
}
function goBack(){ router.push(backTarget()) }

onMounted(async ()=>{
  // 从题库语境进入（/create?bank=xxx）：同步当前库，让归属与返回路径一致
  if(!isEdit.value){
    const qb = route.query.bank
    if (typeof qb === 'string' && qb) setCurrentBank(qb)
  }
  if(isEdit.value){
    loading.value=true
    try{
      const res = await get(route.params.id)
      form.value = res.data
    } catch(e){ error.value = e.response?.data?.error || e.message }
    finally{ loading.value=false }
  }
})

async function onSave(){
  error.value=''
  const v = validateQuestion(form.value)
  if(!v.valid){ error.value = '校验失败：' + v.errors.join('; '); return }
  saving.value=true
  try{
    const payload = isEdit.value ? form.value : { ...form.value }
    if(!isEdit.value){
      delete payload.id   // id 留空由后端生成
      // 新建：归属优先 ?bank=，其次当前题库，空回退第一个（后端再兜底 bank_default）
      payload.bank_id = targetBankId.value || bankStore.banks[0]?.id
    }
    normalizeQuestion(payload)
    payload.plain_text = getAggregatedPlainText(payload)
    if(isEdit.value){
      await update(route.params.id, payload)
    } else {
      await create(payload)
    }
    router.push(backTarget())
  } catch(e){
    error.value = e.response?.data?.error || e.message
  } finally{ saving.value=false }
}
</script>

<style scoped>
.form-page{ padding:0 }
.card{ background:var(--card); border:1px solid var(--line); border-radius:var(--radius-lg); padding:20px; box-shadow:var(--shadow) }
.card-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid var(--line) }
.card-head h2{ margin:0; font-size:20px; font-weight:700; letter-spacing:-0.01em }
.badge{ font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted); background:var(--bg-accent); font-weight:500 }
.badge.ok{ color:var(--success); border-color:#86efac; background:var(--success-bg) }
.badge.bad{ color:var(--danger); border-color:#fecaca; background:var(--danger-bg) }
.form-grid{ display:grid; grid-template-columns:1fr; gap:20px }
@media(min-width:1100px){ .form-grid{ grid-template-columns:1.15fr 0.85fr } }
.editor-col{ min-width:0 }
.preview-col{ min-width:0; position:sticky; top:88px; align-self:start }
.row{ display:flex; gap:8px; align-items:center }
.btn{ background:var(--card); border:1px solid var(--line); color:var(--text-secondary); padding:8px 14px; border-radius:10px; cursor:pointer; font-weight:500; transition:all .15s ease; box-shadow:var(--shadow-sm) }
.btn:hover{ background:var(--bg-accent); border-color:var(--line-strong); transform:translateY(-1px); box-shadow:var(--shadow) }
.btn.primary{ background:var(--text); color:#fff; border-color:var(--text) }
.btn.primary:hover{ background:#1e293b }
.error{ background:var(--danger-bg); border:1px solid #fecaca; color:#b91c1c; padding:12px; border-radius:10px; margin-bottom:12px }
.muted{ color:var(--muted) }
</style>
