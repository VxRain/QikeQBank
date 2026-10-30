<template>
  <div class="page">
    <div class="card">
      <div class="flex justify-between items-center mb-4 pb-4 border-b border-line gap-3">
        <h2 class="section-title m-0 flex items-center gap-2 flex-wrap">
          <i class="i-lucide-pen-line text-primary" />{{ isEdit ? '编辑试题' : '新增试题' }}
          <span class="badge badge-type">{{ form.type }}</span>
          <span v-if="isEdit" class="badge">所属题库：{{ bankBadgeText }}</span>
          <span v-else class="badge">将存入：{{ newBankName }}</span>
          <span v-if="dirty" class="badge badge-bad" title="Ctrl/Cmd+S 保存">未保存</span>
        </h2>
        <div class="flex gap-2 items-center">
          <button class="btn" @click="goBack"><i class="i-lucide-arrow-left" />返回列表</button>
          <button class="btn btn-primary" @click="onSave" :disabled="saving" title="Ctrl/Cmd+S">
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
          <QuestionEditor ref="editorRef" v-model="form" />
        </div>
        <div class="min-w-0 sticky top-[88px] self-start">
          <h3 class="m-0 mb-2 text-text font-700 text-[15px] flex items-center gap-1.5">
            <i class="i-lucide-eye text-primary text-[16px]" />实时预览
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { get, create, update } from '@/api/questions.js'
import { expandQuestions, normalizeDocAssets } from '@/api/assets.js'
import { normalizeQuestion, getAggregatedPlainText } from '@/utils/normalize.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { toast, confirmDialog } from '@/stores/ui.js'
import {
  draftKey,
  snapshotOf,
  isDirty,
  saveDraft,
  loadDraft,
  clearDraft,
  ageText,
  startDraftTimer
} from '@/stores/formDraft.js'
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
const editorRef = ref(null)

const validation = computed(()=>{
  try{ return validateQuestion(form.value) } catch(e){ return { valid:false, errors:[String(e)] } }
})
const prettyJSON = computed(()=> JSON.stringify(form.value, null, 2))

// 卡头「所属题库」徽章文案（编辑模式只读显示）
// 新建归属：?bank= 参数优先，其次按设置记忆，否则必须手动选（不再静默回退首库）
const newBankId = ref('')
const newBankName = computed(()=>{
  const bank = bankStore.banks.find(b=> b.id === newBankId.value)
  return bank ? bank.name : '未选择'
})
const bankBadgeText = computed(()=>{
  const bid = form.value?.bank_id
  if(!bid) return '未归属'
  const bank = bankStore.banks.find(b=> b.id === bid)
  return bank ? bank.name : bid
})

// 返回目标：从题库语境进入则回到该库列表，否则回首页
function backTarget(){
  if(isEdit.value){
    const bid = form.value?.bank_id
    return bid ? `/library?bank=${bid}` : '/library'
  }
  const bid = newBankId.value || (typeof route.query.bank === 'string' ? route.query.bank : '')
  return bid ? `/library?bank=${bid}` : '/'
}

// ══ FE-P0-03 防丢失：脏状态 + 离开确认 + Ctrl/Cmd+S + 30s 草稿 ══
const dirty = ref(false)
let baseline = null // 挂载（或重置）时的表单快照，脏判定基准
let allowLeave = false // 已确认放行（保存成功 / 用户明确放弃），不再二次拦截
let stopDraftTimer = () => {}
const dkey = computed(()=> draftKey({ isEdit: isEdit.value, id: route.params.id, bankId: newBankId.value }))

function resetBaseline(){
  baseline = snapshotOf(form.value)
  dirty.value = false
}

function goBack(){ router.push(backTarget()) }

// 脏了就问一句（应用内弹窗，不用原生 confirm）
async function confirmDiscard(){
  if(!dirty.value) return true
  return await confirmDialog({
    title: '放弃未保存的修改？',
    message: '当前录入内容还没有保存，离开后这次修改会丢失（最近 30 秒内的内容仍可从草稿恢复）。',
    okText: '放弃修改',
    cancelText: '继续编辑',
    danger: true
  })
}

onBeforeRouteLeave(async ()=>{
  if(allowLeave) { allowLeave = false; return true }
  if(!dirty.value) return true // 干净离开：草稿是崩溃兜底，不因普通导航销毁
  const ok = await confirmDiscard()
  if(ok) clearDraft(dkey.value) // 用户明确放弃才清 → 下次不再弹恢复
  return ok
})

// 关窗口/刷新：交给浏览器自己的原生提示（该场景没有应用内 UI 可用，非「套壳式弹窗」）
function onBeforeUnload(e){
  if(!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

function onKeydown(e){
  const mod = e.ctrlKey || e.metaKey
  if(!mod || e.altKey) return
  const key = (e.key || '').toLowerCase()
  if(key !== 's') return
  e.preventDefault()
  if(!saving.value) onSave()
}

// 进入时：有未过期的草稿就问一句要不要恢复
async function offerDraftRestore(){
  const draft = loadDraft(dkey.value)
  if(!draft) return
  const ok = await confirmDialog({
    title: '恢复未保存的录入内容？',
    message: `检测到 ${ageText(draft.savedAt)}自动保存的草稿（可能是上次异常关闭留下的）。恢复会覆盖当前表单内容。`,
    okText: '恢复草稿',
    cancelText: '忽略'
  })
  if(ok){
    form.value = draft.form
    toast('已恢复上次未保存的内容', 'success')
  } else {
    clearDraft(dkey.value)
  }
}

onMounted(async ()=>{
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  // 新建归属：?bank= 优先，其次按设置记忆
  if(!isEdit.value){
    newBankId.value = resolveBankFilter('create', route.query.bank)
  }
  if(isEdit.value){
    loading.value=true
    try{
      const q = await get(route.params.id)
      // asset: 引用展开成可显示 URL（保存时再归一回去）
      const list = await expandQuestions([q])
      form.value = list[0] || q
    } catch(e){ error.value = e?.message || String(e) }
    finally{ loading.value=false }
  }
  // 基线必须在草稿恢复之前建立？——不：草稿恢复本身就是一次「已脏」的差异，
  // 所以先建基线（脏判定基准＝进入时内容），再问是否恢复草稿；恢复后 dirty 自然为 true。
  resetBaseline()
  await offerDraftRestore()
  // 进入后才开始脏检测与草稿定时器：加载期间的 programmatic 变更不能算用户改动
  stopDraftTimer = startDraftTimer(dkey.value, ()=> form.value)
  window.addEventListener('beforeunload', onBeforeUnload)
  // capture 阶段：编辑器（TipTap）拿到键事件之前先拦，保证 Ctrl+S 到得了保存
  window.addEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(()=>{
  stopDraftTimer()
  if(draftDebounce) clearTimeout(draftDebounce)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onKeydown, true)
})

// 脏标记 + 草稿：每次表单变化重算（deep，因为编辑器是原地改嵌套对象）。
// 定时器 30 秒一次粒度太粗（意外关闭会丢半分钟内容），脏变化再叠 2 秒防抖写一次。
let draftDebounce = null
watch(
  ()=> form.value,
  (v)=> {
    dirty.value = isDirty(baseline, v)
    if(!dirty.value) return
    if(draftDebounce) clearTimeout(draftDebounce)
    draftDebounce = setTimeout(()=> { draftDebounce = null; saveDraft(dkey.value, form.value) }, 2000)
  },
  { deep: true }
)

async function onSave(){
  if(saving.value) return // Ctrl+S 连按与按钮点击不叠加
  error.value=''
  const v = validateQuestion(form.value)
  if(!v.valid){ error.value = '校验失败：' + v.errors.join('; '); return }
  saving.value=true
  try{
    const raw = isEdit.value ? form.value : { ...form.value }
    // 深拷贝后归一：显示期 asset URL → asset: 引用；不碰编辑器内状态
    const payload = normalizeDocAssets(JSON.parse(JSON.stringify(raw)))
    if(!isEdit.value){
      delete payload.id   // id 留空由后端生成
      if (!newBankId.value) {
        error.value = '未确定所属题库，请从题库页进入后重试'
        saving.value = false
        return
      }
      payload.bank_id = newBankId.value
      persistBankFilter('create', newBankId.value)
    }
    normalizeQuestion(payload)
    payload.plain_text = getAggregatedPlainText(payload)
    if(isEdit.value){
      await update(route.params.id, payload)
      clearDraft(dkey) // 保存成功即清草稿，离开时不再提示
      dirty.value = false
      allowLeave = true
      toast('已保存', 'success')
      router.push(backTarget())
    } else {
      await create(payload)
      toast(`已保存到「${bankStore.banks.find(b=> b.id === newBankId.value)?.name || ''}」，可继续录入`, 'success')
      // 留页连续录入：走编辑器正规重置通道（各题型答案结构不同，不能直接改 type）
      // 连续录入：草稿归零、基线重设为重置后的新表单，页面保持干净
      clearDraft(dkey)
      editorRef.value?.resetTo(form.value.type, { difficulty: form.value.difficulty, score: form.value.score })
      resetBaseline()
      window.scrollTo(0, 0)
    }
  } catch(e){
    console.error(e)
    // invoke 拒因即后端 Err 字符串（无 .message），axios 式取法会吞错显空
    error.value = typeof e === 'string' ? e : (e?.message || '保存失败')
  } finally{ saving.value=false }
}
</script>

