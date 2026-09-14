<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-list text-primary" />题库列表
        </h2>
        <div class="flex gap-2 items-center">
          <span v-if="currentBankName" class="badge badge-cur">当前：{{ currentBankName }}</span>
          <span class="badge">{{ filteredCount }} 题</span>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 items-center p-3 mb-4 bg-bg-accent border border-line rounded-[12px]">
        <div class="relative flex-1 min-w-[180px]">
          <i class="i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-light pointer-events-none" />
          <input
            v-model="query"
            class="input w-full pl-9"
            placeholder="搜索题干..."
            @keyup.enter="fetchList"
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
        <select
          v-model="bankStore.currentBankId"
          class="select min-w-[130px]"
          :disabled="!bankStore.loaded"
          @change="search"
        >
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
        <button class="btn btn-primary" @click="search">
          <i class="i-lucide-search" />搜索
        </button>
        <button class="btn" @click="reset">
          <i class="i-lucide-rotate-ccw" />重置
        </button>
        <button
          class="btn"
          :disabled="!bankStore.loaded || !bankStore.currentBankId"
          :title="bankStore.currentBankId ? '从模板文件导入到当前题库' : '请先选择一个题库'"
          @click="showImport = true"
        ><i class="i-lucide-file-up" />导入文件</button>
        <button
          class="btn btn-primary ml-auto"
          :disabled="!bankStore.loaded || !bankStore.currentBankId"
          :title="bankStore.currentBankId ? '新增到当前题库' : '请先选择一个题库'"
          @click="onAdd"
        ><i class="i-lucide-plus" />新增试题</button>
      </div>
      <ImportFileBox
        :open="showImport"
        :bank-id="bankStore.currentBankId"
        :bank-name="currentBankName"
        @done="onImportDone"
        @close="showImport = false"
      />

      <div v-if="loading" class="text-muted py-4 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />加载中...
      </div>
      <div v-else-if="error" class="error-box mb-3">{{ error }}</div>

      <div v-else class="overflow-x-auto border border-line rounded-[12px]">
        <table class="w-full border-collapse text-[14px]">
          <thead>
            <tr>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 80px">类型</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent">题干</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">分值</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 240px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="questions.length === 0">
              <td colspan="4" class="text-center py-6 text-muted">暂无数据</td>
            </tr>
            <tr v-for="q in questions" :key="q.id" class="transition-[background-color] duration-100 hover:bg-card-hover">
              <td class="px-3.5 py-3 border-b border-line"><span class="badge badge-type">{{ typeLabel(q.type) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line max-w-[420px] truncate text-text-secondary font-500" :title="getPlainText(q)">{{ truncate(getPlainText(q), 80) }}</td>
              <td class="px-3.5 py-3 border-b border-line">{{ q.score ?? (q.children ? q.children.reduce((s,c)=>s+(c.score||0),0) : '-') }}</td>
              <td class="px-3.5 py-3 border-b border-line">
                <div class="flex gap-1.5 flex-wrap">
                  <router-link :to="`/edit/${q.id}`" class="btn btn-small"><i class="i-lucide-pencil" />编辑</router-link>
                  <select class="select px-1.5 py-1 text-[11px] w-[104px] min-w-0" :value="''" title="移动题库" @change="onMove(q.id, $event.target.value)">
                    <option value="" disabled>移动题库…</option>
                    <option v-for="b in otherBanks(q.bank_id)" :key="b.id" :value="b.id">{{ b.name }}</option>
                  </select>
                  <button class="btn btn-small btn-danger" @click="onDelete(q)"><i class="i-lucide-trash-2" />删除</button>
                </div>
              </td>
            </tr>
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
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { list, remove, update } from '@/api/questions.js'
import { bankStore, setCurrentBank, loadBanks } from '@/stores/bank.js'
import { toast, confirmDialog } from '@/stores/ui.js'
import ImportFileBox from '@/components/ImportFileBox.vue'

const route = useRoute()
const router = useRouter()
const query = ref('')
const type = ref('')
const questions = ref([])
const showImport = ref(false)
const PAGE_SIZE = 50
const page = ref(1)
const total = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function onImportDone() {
  showImport.value = false
  await fetchList()
  await loadBanks()
}
const loading = ref(false)
const error = ref('')

const filteredCount = computed(() => total.value)

const currentBankName = computed(() => {
  const b = bankStore.banks.find((x) => x.id === bankStore.currentBankId)
  return b ? b.name : ''
})

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
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (query.value.trim()) params.query = query.value.trim()
    if (type.value) params.type = type.value
    params.bankId = bankStore.currentBankId  // 空串 = 全部题库，由 api 层不传 bank_id
    params.limit = PAGE_SIZE
    params.offset = (page.value - 1) * PAGE_SIZE
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
  const bid = bankStore.currentBankId
  if (!bid) {
    toast('新增试题需要先选择一个题库', 'info')
    return
  }
  router.push(`/create?bank=${bid}`)
}

function otherBanks(bankId) {
  return bankStore.banks.filter((b) => b.id !== bankId)
}

async function onMove(id, bankId) {
  if (!bankId) return
  try {
    await update(id, { bank_id: bankId })
    await fetchList()
    await loadBanks()
  } catch (e) {
    toast('移动失败：' + (e?.response?.data?.error || e?.message || e), 'error')
  }
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
  // 从题库页进入：/library?bank=<id> → 设为当前库再加载
  const qb = route.query.bank
  if (typeof qb === 'string' && qb) setCurrentBank(qb)
  await fetchList()
})

// optional: auto search debounce could be added, but keep explicit search for now
watch(type, () => {
  // already triggered by @change, keep for programmatic changes
})
</script>

