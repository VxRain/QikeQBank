<template>
  <div class="page">
    <div class="card">
      <div class="flex justify-between items-center mb-4 pb-4 border-b border-line gap-3">
        <h2 class="section-title m-0 flex items-center gap-2 flex-wrap">
          <i class="i-lucide-pen-line text-primary" />{{ isEdit ? '编辑试题' : '新增试题' }}
          <span class="badge badge-type">{{ form.type }}</span>
          <span class="badge">所属题库：{{ bankBadgeText }}</span>
        </h2>
        <div class="flex gap-2 items-center">
          <button class="btn" @click="goBack"><i class="i-lucide-arrow-left" />返回列表</button>
          <button class="btn btn-primary" @click="onSave" :disabled="saving">
            <i class="i-lucide-save" />{{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
      <div v-if="error" class="error-box mb-3">{{ error }}</div>
      <div v-if="loading" class="text-muted py-4 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />加载中...
      </div>
      <div v-else class="grid grid-cols-1 gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div class="min-w-0">
          <QuestionEditor v-model="form" />
        </div>
        <div class="min-w-0 sticky top-[88px] self-start">
          <h3 class="m-0 mb-2 text-text font-700 text-[15px] flex items-center gap-1.5">
            <i class="i-lucide-eye text-primary text-[16px]" />实时预览（Web真渲染）
          </h3>
          <QuestionPreview :question="form" />
          <div class="mt-3.5 p-3 bg-bg-accent border border-line rounded-[12px]">
            <h4 class="m-0 mb-1.5 text-muted text-[13px] font-600 flex items-center gap-1.5">
              <i class="i-lucide-check-circle text-[14px]" />校验
            </h4>
            <div v-if="validation.valid" class="badge badge-ok"><i class="i-lucide-check" />校验通过</div>
            <div v-else class="badge badge-bad"><i class="i-lucide-x" />{{ validation.errors.join('; ') }}</div>
          </div>
          <details class="mt-3">
            <summary class="cursor-pointer text-muted text-[12px] font-500 select-none">查看 Blocks JSON</summary>
            <pre class="mt-2 bg-[#1b1a17] border border-line rounded-[8px] p-2.5 overflow-auto text-[11px] max-h-[300px] text-[#e3ddcd]">{{ prettyJSON }}</pre>
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

