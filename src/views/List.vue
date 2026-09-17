<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-list text-primary" />试题列表
        </h2>
        <div class="flex gap-2 items-center">
          <span v-if="bankName" class="badge badge-cur">{{ bankName }}</span>
          <span class="badge">{{ filteredCount }} 题</span>
          <router-link to="/banks" class="btn btn-small"><i class="i-lucide-arrow-left" />题库管理</router-link>
        </div>
      </div>

      <div v-if="!bankId" class="text-center py-8 text-muted flex flex-col items-center gap-3">
        <i class="i-lucide-folder-open text-[28px]" />
        <div class="text-[14px]">请先到题库管理选择一个题库</div>
        <router-link to="/banks" class="btn btn-primary btn-small"><i class="i-lucide-library" />去题库管理</router-link>
      </div>

      <template v-else>

      <div class="flex flex-wrap gap-2 items-center p-3 mb-4 bg-bg-accent border border-line rounded-[12px]">
        <div class="relative flex-1 min-w-[180px]">
          <i class="i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-light pointer-events-none" />
          <input
            v-model="query"
            class="input w-full pl-9"
            placeholder="搜索题干..."
            @keyup.enter="search"
          />
        </div>
        <select v-model="type" class="select min-w-[130px]" @change="search">
          <option value="">全部类型</option>
          <option value="single">单选</option>
          <option value="multi">多选</option>
          <option value="judge">判断</option>
          <option value="fill">填空</option>
          <option value="short">问答</option>
          <option value="material">材料</option>
        </select>
        <button class="btn btn-primary" @click="search">
          <i class="i-lucide-search" />搜索
        </button>
        <button class="btn" @click="reset">
          <i class="i-lucide-rotate-ccw" />重置
        </button>
        <button
          class="btn"
          :title="'导入试题到「' + bankName + '」'"
          @click="showImport = true"
        ><i class="i-lucide-file-up" />导入试题</button>
        <button
          class="btn btn-primary ml-auto"
          :title="'新增到「' + bankName + '」'"
          @click="onAdd"
        ><i class="i-lucide-plus" />新增试题</button>
      </div>
      <ImportFileBox
        :open="showImport"
        :bank-id="bankId"
        :bank-name="bankName"
        @done="onImportDone"
        @close="showImport = false"
      />

      <div v-if="loading" class="text-muted py-4 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />加载中...
      </div>
      <div v-else-if="error" class="error-box mb-3">{{ error }}</div>

      <template v-else>
      <div v-if="selected.size" class="flex flex-wrap items-center gap-2 px-3.5 py-2.5 mb-3 bg-primary-bg border border-primary-border rounded-[10px] text-[13px]">
        <span class="font-600 text-primary">已选 {{ selected.size }} 题</span>
        <button type="button" class="btn btn-small" :disabled="batchBusy" @click="onBatchMove"><i class="i-lucide-folder-input" />移动</button>
        <button type="button" class="btn btn-small btn-danger" :disabled="batchBusy" @click="onBatchDelete"><i class="i-lucide-trash-2" />删除</button>
        <button type="button" class="btn btn-small btn-ghost" @click="clearSelection">取消选择</button>
      </div>

      <div class="overflow-x-auto border border-line rounded-[12px]">
        <table class="w-full border-collapse text-[14px]">
          <thead>
            <tr>
              <th class="px-3 py-3 border-b border-line bg-bg-accent" style="width: 40px">
                <input type="checkbox" class="accent-[#1f4d3a] w-4 h-4 cursor-pointer align-middle" title="全选本页" :checked="allChecked" :indeterminate="someChecked && !allChecked" @change="toggleAll($event.target.checked)" />
              </th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 80px">类型</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent">题干</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">分值</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 240px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="questions.length === 0">
              <td colspan="5" class="text-center py-6 text-muted">暂无数据</td>
            </tr>
            <template v-for="q in questions" :key="q.id">
            <tr class="transition-[background-color] duration-100 hover:bg-card-hover" :class="selected.has(q.id) && 'bg-primary-bg'">
              <td class="px-3 py-3 border-b border-line text-center">
                <input type="checkbox" class="accent-[#1f4d3a] w-4 h-4 cursor-pointer align-middle" :checked="selected.has(q.id)" @change="toggleOne(q.id, $event.target.checked)" />
              </td>
              <td class="px-3.5 py-3 border-b border-line"><span class="badge badge-type">{{ typeLabel(q.type) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line max-w-[420px] truncate text-text-secondary font-500" :title="getPlainText(q)">{{ truncate(getPlainText(q), 80) }}</td>
              <td class="px-3.5 py-3 border-b border-line">{{ displayScore(q) }}</td>
              <td class="px-3.5 py-3 border-b border-line">
                <div class="flex gap-1.5 flex-wrap">
                  <router-link :to="`/edit/${q.id}`" class="btn btn-small" title="编辑"><i class="i-lucide-pencil" />编辑</router-link>
                  <button type="button" class="btn btn-small" :title="previewId === q.id ? '收起预览' : '预览渲染效果'" @click="togglePreview(q.id)"><i :class="previewId === q.id ? 'i-lucide-eye-off' : 'i-lucide-eye'" />预览</button>
                  <button type="button" class="btn btn-small" title="移动到其他题库" @click="onMoveOne(q.id)"><i class="i-lucide-folder-input" />移动</button>
                  <button class="btn btn-small btn-danger" @click="onDelete(q)"><i class="i-lucide-trash-2" />删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="previewId === q.id" :key="q.id + '_preview'">
              <td colspan="5" class="px-3.5 py-3 border-b border-line bg-bg-accent">
                <div v-if="previewLoading && !previewCache[q.id]" class="text-muted py-4 flex items-center gap-2">
                  <i class="i-lucide-loader-circle animate-spin" />加载中...
                </div>
                <QuestionPreview v-else-if="previewCache[q.id]" :question="previewCache[q.id]" />
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="!loading && !error && total > 0" class="flex items-center justify-center gap-3 py-4">
        <button type="button" class="btn btn-small" :disabled="page <= 1" @click="gotoPage(page - 1)">
          <i class="i-lucide-chevron-left" />上一页
        </button>
        <span class="text-[13px] text-muted font-500">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 题</span>
        <button type="button" class="btn btn-small" :disabled="page >= pageCount" @click="gotoPage(page + 1)">
          下一页<i class="i-lucide-chevron-right" />
        </button>
      </div>
      </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { list, get, remove, update } from '@/api/questions.js'
import { bankStore, loadBanks, bankExists } from '@/stores/bank.js'
import { toast, confirmDialog, selectDialog } from '@/stores/ui.js'
import ImportFileBox from '@/components/ImportFileBox.vue'
import QuestionPreview from '@/components/QuestionPreview.vue'

const route = useRoute()
const router = useRouter()
const query = ref('')
const type = ref('')
const questions = ref([])
const showImport = ref(false)
const PAGE_SIZE = 50
const page = ref(1)
const total = ref(0)
const previewId = ref(null)
// 摘要列表不含题面详情，预览时按需拉全量并缓存
const previewCache = ref({})
const previewLoading = ref(false)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
// 本页题库上下文：只从 ?bank= 来（从题库页进入），无选择器；直访无 bank 则提示去挑库
const bankId = ref('')
const bankName = computed(() => bankStore.banks.find((x) => x.id === bankId.value)?.name || '')

async function onImportDone() {
  showImport.value = false
  await fetchList()
  await loadBanks()
}
const loading = ref(false)
const error = ref('')

const filteredCount = computed(() => total.value)

// 多选：勾选 + 批量删除/移库（翻页/筛选后清空）
const selected = ref(new Set())
const batchBusy = ref(false)
const allChecked = computed(() => questions.value.length > 0 && questions.value.every((q) => selected.value.has(q.id)))
const someChecked = computed(() => questions.value.some((q) => selected.value.has(q.id)))
function toggleOne(id, checked) {
  const s = new Set(selected.value)
  if (checked) s.add(id)
  else s.delete(id)
  selected.value = s
}
function toggleAll(checked) {
  const s = new Set(selected.value)
  for (const q of questions.value) {
    if (checked) s.add(q.id)
    else s.delete(q.id)
  }
  selected.value = s
}
function clearSelection() {
  selected.value = new Set()
}

function togglePreview(id) {
  if (previewId.value === id) {
    previewId.value = null
    return
  }
  previewId.value = id
  if (previewCache.value[id]) return
  previewLoading.value = true
  get(id).then((res) => {
    const full = res?.data ?? res
    if (full && full.id) previewCache.value = { ...previewCache.value, [id]: full }
    else previewId.value = null
  }).catch((e) => {
    console.error(e)
    toast(e?.message || '加载详情失败', 'error')
    previewId.value = null
  }).finally(() => {
    previewLoading.value = false
  })
}

// 摘要行优先用服务端派生的 children_score（材料题分值合计），兼容全量行的 children
function displayScore(q) {
  if (!q) return '-'
  if (q.score !== null && q.score !== undefined) return q.score
  if (typeof q.children_score === 'number') return q.children_score
  if (Array.isArray(q.children)) return q.children.reduce((s, c) => s + (c.score || 0), 0)
  return '-'
}

// 移动（单题/批量共用）：弹窗选目标库，确定后执行
async function moveQuestions(ids) {
  if (!ids.length || batchBusy.value) return
  const options = bankStore.banks
    .filter((b) => b.id !== bankId.value)
    .map((b) => ({ value: b.id, label: `${b.name}（${b.question_count ?? 0} 题）` }))
  if (!options.length) {
    toast('没有其他题库可移入', 'info')
    return
  }
  const target = await selectDialog({
    title: `移动 ${ids.length} 道试题`,
    message: '选择目标题库',
    options,
    okText: '移动'
  })
  if (!target) return
  const targetName = bankStore.banks.find((b) => b.id === target)?.name || target
  batchBusy.value = true
  let fail = 0
  try {
    for (const id of ids) {
      try {
        await update(id, { bank_id: target })
      } catch (e) {
        fail++
        console.error('move failed', id, e)
      }
    }
    clearSelection()
    await fetchList()
    await loadBanks()
    toast(fail ? `移动完成，${fail} 道失败` : `已将 ${ids.length} 道试题移到「${targetName}」`, fail ? 'error' : 'success')
  } finally {
    batchBusy.value = false
  }
}

function onMoveOne(id) {
  moveQuestions([id])
}

async function onBatchDelete() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  const ok = await confirmDialog({
    title: '批量删除',
    message: `确定删除选中的 ${ids.length} 道试题？此操作不可撤销。`,
    okText: '删除',
    danger: true
  })
  if (!ok) return
  batchBusy.value = true
  let fail = 0
  try {
    for (const id of ids) {
      try {
        await remove(id)
      } catch (e) {
        fail++
        console.error('batch delete failed', id, e)
      }
    }
    clearSelection()
    await fetchList()
    await loadBanks()
    toast(fail ? `删除完成，${fail} 道失败` : `已删除 ${ids.length} 道试题`, fail ? 'error' : 'success')
  } finally {
    batchBusy.value = false
  }
}

async function onBatchMove() {
  await moveQuestions([...selected.value])
}

function typeLabel(t) {
  const map = {
    single: '单选',
    multi: '多选',
    judge: '判断',
    fill: '填空',
    short: '问答',
    material: '材料'
  }
  return map[t] || t || '-'
}

function truncate(s, n) {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n) + '…' : s
}

function extractFromDoc(doc) {
  if (!doc || !doc.content) return ''
  const parts = []
  for (const node of doc.content) {
    if (node.type === 'paragraph') {
      const inline = (node.content || []).map((n) => {
        if (n.type === 'text') return n.text || ''
        if (n.type === 'inlineMath') return n.attrs?.latex ? ` $${n.attrs.latex}$ ` : ''
        if (n.type === 'blank') return ' ___ '
        if (n.type === 'inlineImage') return ' [图] '
        return ''
      }).join('')
      parts.push(inline)
    } else if (node.type === 'imageBlock') {
      parts.push(' [图] ')
    } else if (node.type === 'mathBlock') {
      parts.push(n.attrs?.latex ? ` $${node.attrs.latex}$ ` : '')
    } else if (node.type === 'blockquote') {
      // nested doc inside blockquote: content is array of paragraphs
      const inner = extractFromDoc(node)
      if (inner) parts.push(inner)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function getPlainText(q) {
  if (!q) return ''
  if (typeof q.plain_text === 'string' && q.plain_text.trim()) return q.plain_text.trim()
  if (typeof q.plainText === 'string' && q.plainText.trim()) return q.plainText.trim()
  // try stem
  if (q.stem) {
    const t = extractFromDoc(q.stem)
    if (t) {
      // for material, also show children count
      if (q.type === 'material' && Array.isArray(q.children) && q.children.length) {
        return t + ` （含 ${q.children.length} 子题）`
      }
      return t
    }
  }
  // fallback: material children first stem
  if (q.type === 'material' && Array.isArray(q.children) && q.children[0]?.stem) {
    return extractFromDoc(q.children[0].stem) + ` （含 ${q.children.length} 子题）`
  }
  return '-'
}

async function fetchList() {
  if (!bankId.value) return
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (query.value.trim()) params.query = query.value.trim()
    if (type.value) params.type = type.value
    params.bankId = bankId.value
    params.limit = PAGE_SIZE
    params.offset = (page.value - 1) * PAGE_SIZE
    params.summary = true
    const res = await list(params)
    // 信封 {success, data:{total, items}}；兼容旧数组形状兜底
    const envelope = res?.data ?? res
    if (envelope && typeof envelope === 'object' && Array.isArray(envelope.items)) {
      total.value = Number(envelope.total) || 0
      questions.value = envelope.items
    } else if (Array.isArray(envelope)) {
      total.value = envelope.length
      questions.value = envelope
    } else {
      let data = envelope
      if (envelope && Array.isArray(envelope.data)) data = envelope.data
      else if (envelope && Array.isArray(envelope.questions)) data = envelope.questions
      if (!Array.isArray(data)) {
        const arrVal = envelope && typeof envelope === 'object' ? Object.values(envelope).find(v => Array.isArray(v)) : null
        data = arrVal || []
      }
      total.value = data.length
      questions.value = data
    }
  } catch (e) {
    console.error(e)
    error.value = e?.response?.data?.error || e?.response?.data?.message || e.message || '加载失败'
  } finally {
    loading.value = false
    clearSelection()
    previewId.value = null
    previewCache.value = {}
    previewLoading.value = false
  }
}

function gotoPage(p) {
  const next = Math.min(Math.max(1, p), pageCount.value)
  if (next === page.value && questions.value.length) return
  page.value = next
  fetchList().then(() => window.scrollTo(0, 0))
}

function search() {
  page.value = 1
  fetchList()
}

function onAdd() {
  if (!bankId.value) return
  router.push(`/create?bank=${bankId.value}`)
}

function reset() {
  query.value = ''
  type.value = ''
  page.value = 1
  fetchList()
}

async function onDelete(q) {
  const stem = truncate(getPlainText(q), 30)
  const ok = await confirmDialog({
    title: '删除试题',
    message: `确定删除「${stem}」？此操作不可撤销。`,
    okText: '删除',
    danger: true
  })
  if (!ok) return
  try {
    await remove(q.id)
    await fetchList()
    toast('试题已删除', 'success')
  } catch (e) {
    toast(e?.response?.data?.error || e.message || '删除失败', 'error')
  }
}

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  // 题库上下文只认 ?bank=（须仍存在），直访无 bank 则提示去题库页挑库
  const qb = route.query.bank
  bankId.value = typeof qb === 'string' && bankExists(qb) ? qb : ''
  await fetchList()
})

// optional: auto search debounce could be added, but keep explicit search for now
watch(type, () => {
  // already triggered by @change, keep for programmatic changes
})
</script>

