/**
 * 错题本（/wrong）
 * 最近一次作答仍为 wrong 的题（答对后自动移出；删题经 FK 级联自动消失）。
 * 重练走 /practice?retry=1，id 经 sessionStorage 传递。
 */
<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-circle-x text-primary" />错题本
        </h2>
        <div class="flex gap-2 items-center">
          <span class="badge">{{ total }} 题</span>
          <button
            type="button"
            class="btn btn-primary btn-small"
            :disabled="!total || retrying"
            @click="retryAll"
          >
            <i class="i-lucide-rotate-ccw" />{{ retrying ? '准备中…' : `重练全部（${total} 题）` }}
          </button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 items-center p-3 mb-4 bg-bg-accent border border-line rounded-[12px]">
        <select v-model="bankId" class="select min-w-[130px]" @change="search">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
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
      </div>

      <div v-if="error" class="error-box mb-3">{{ error }}</div>
      <div v-if="loading" class="text-muted py-4 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />加载中...
      </div>

      <div v-else-if="questions.length === 0" class="text-center py-8 text-muted flex flex-col items-center gap-3">
        <i class="i-lucide-circle-check text-[28px] text-success" />
        <div class="text-[14px]">暂无错题，答错的题会自动收录到这里</div>
        <router-link to="/practice" class="btn btn-primary btn-small"><i class="i-lucide-zap" />去刷题</router-link>
      </div>

      <div v-else class="overflow-x-auto border border-line rounded-[12px]">
        <table class="w-full border-collapse text-[14px]">
          <thead>
            <tr>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 80px">类型</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent">题干</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 90px">题库</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">错次数</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 150px">最近错</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 170px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in questions" :key="q.id" class="transition-[background-color] duration-100 hover:bg-card-hover">
              <td class="px-3.5 py-3 border-b border-line"><span class="badge badge-type">{{ typeLabel(q.type) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line max-w-[360px] truncate text-text-secondary font-500" :title="getPlainText(q)">{{ truncate(getPlainText(q), 80) }}</td>
              <td class="px-3.5 py-3 border-b border-line text-muted text-[13px]">{{ bankNameOf(q.bank_id) }}</td>
              <td class="px-3.5 py-3 border-b border-line"><span class="font-700 text-danger">{{ q.wrong_count ?? 1 }}</span></td>
              <td class="px-3.5 py-3 border-b border-line text-muted text-[13px] whitespace-nowrap">{{ fmtTime(q.last_wrong_at) }}</td>
              <td class="px-3.5 py-3 border-b border-line">
                <div class="flex gap-1.5 flex-wrap">
                  <button class="btn btn-small" @click="retryOne(q.id)"><i class="i-lucide-rotate-ccw" />重练</button>
                  <router-link :to="`/edit/${q.id}`" class="btn btn-small"><i class="i-lucide-pencil" />编辑</router-link>
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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { wrongList } from '@/api/practice.js'
import { bankStore } from '@/stores/bank.js'
import { toast } from '@/stores/ui.js'

const router = useRouter()
const type = ref('')
const bankId = ref(bankStore.currentBankId || '')
const questions = ref([])
const loading = ref(false)
const retrying = ref(false)
const error = ref('')
const PAGE_SIZE = 50
const page = ref(1)
const total = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const RETRY_KEY = 'qbank.retryIds'

function typeLabel(t) {
  const map = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '问答', material: '材料' }
  return map[t] || t || '-'
}

function bankNameOf(bid) {
  return bankStore.banks.find((b) => b.id === bid)?.name || '-'
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
      parts.push(node.attrs?.latex ? ` $${node.attrs.latex}$ ` : '')
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function getPlainText(q) {
  if (!q) return ''
  if (typeof q.plain_text === 'string' && q.plain_text.trim()) return q.plain_text.trim()
  if (q.stem) {
    const t = extractFromDoc(q.stem)
    if (t) return q.type === 'material' && Array.isArray(q.children) && q.children.length
      ? t + ` （含 ${q.children.length} 子题）`
      : t
  }
  return '-'
}

function fmtTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ')
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function fetchList() {
  loading.value = true
  error.value = ''
  try {
    const data = await wrongList({
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
      bankId: bankId.value || undefined,
      type: type.value || undefined
    })
    total.value = Number(data?.total) || 0
    questions.value = Array.isArray(data?.items) ? data.items : []
  } catch (e) {
    console.error(e)
    error.value = e?.message || '加载失败'
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

function reset() {
  type.value = ''
  bankId.value = ''
  page.value = 1
  fetchList()
}

function startRetry(ids) {
  if (!ids.length) return
  try {
    sessionStorage.setItem(RETRY_KEY, JSON.stringify(ids))
  } catch {
    toast('浏览器存储不可用，无法发起重练', 'error')
    return
  }
  router.push('/practice?retry=1')
}

function retryOne(id) {
  startRetry([id])
}

async function retryAll() {
  if (!total.value || retrying.value) return
  retrying.value = true
  try {
    // 重练全部：按当前筛选取最多 500 个 id（后端上限）
    const data = await wrongList({
      limit: Math.min(total.value, 500),
      offset: 0,
      bankId: bankId.value || undefined,
      type: type.value || undefined
    })
    const ids = (data?.items || []).map((q) => q.id).filter(Boolean)
    if (!ids.length) {
      toast('没有可重练的题目', 'info')
      return
    }
    startRetry(ids)
  } catch (e) {
    console.error(e)
    toast('准备重练失败：' + (e?.message || e), 'error')
  } finally {
    retrying.value = false
  }
}

onMounted(fetchList)
</script>
