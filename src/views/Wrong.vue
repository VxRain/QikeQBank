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
        <select v-model="bankId" class="select min-w-[130px]" @change="onBankChange">
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

      <template v-else>
      <div v-if="selected.size" class="flex flex-wrap items-center gap-2 px-3.5 py-2.5 mb-3 bg-primary-bg border border-primary-border rounded-[10px] text-[13px]">
        <span class="font-600 text-primary">已选 {{ selected.size }} 题</span>
        <button type="button" class="btn btn-small" :disabled="dismissing" @click="onBatchDismiss"><i class="i-lucide-x" />批量移除</button>
        <button type="button" class="btn btn-small btn-ghost" @click="selected = new Set()">取消选择</button>
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
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 90px">题库</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">错次数</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 150px">最近错</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 170px">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="q in questions" :key="q.id">
            <tr class="transition-[background-color] duration-100 hover:bg-card-hover" :class="selected.has(q.id) && 'bg-primary-bg'">
              <td class="px-3 py-3 border-b border-line text-center">
                <input type="checkbox" class="accent-[#1f4d3a] w-4 h-4 cursor-pointer align-middle" :checked="selected.has(q.id)" @change="toggleOne(q.id, $event.target.checked)" />
              </td>
              <td class="px-3.5 py-3 border-b border-line"><span class="badge badge-type">{{ typeLabel(q.type) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line max-w-[360px] truncate text-text-secondary font-500" :title="getPlainText(q)">{{ truncate(getPlainText(q), 80) }}</td>
              <td class="px-3.5 py-3 border-b border-line text-muted text-[13px]">{{ bankNameOf(q.bank_id) }}</td>
              <td class="px-3.5 py-3 border-b border-line"><span class="font-700 text-danger">{{ q.wrong_count ?? 1 }}</span></td>
              <td class="px-3.5 py-3 border-b border-line text-muted text-[13px] whitespace-nowrap">{{ fmtTime(q.last_wrong_at) }}</td>
              <td class="px-3.5 py-3 border-b border-line">
                <div class="flex gap-1.5 flex-wrap">
                  <button class="btn btn-small" @click="viewId = viewId === q.id ? null : q.id" :title="viewId === q.id ? '收起' : '查看上次答错记录'"><i :class="viewId === q.id ? 'i-lucide-eye-off' : 'i-lucide-eye'" />查看</button>
                  <button class="btn btn-small" @click="retryOne(q.id)"><i class="i-lucide-rotate-ccw" />重练</button>
                  <button class="btn btn-small" title="从错题本移除（不删除试题）" @click="onDismissOne(q.id)"><i class="i-lucide-x" />移除</button>
                  <router-link :to="`/edit/${q.id}`" class="btn btn-small"><i class="i-lucide-pencil" />编辑</router-link>
                </div>
              </td>
            </tr>
            <tr v-if="viewId === q.id" :key="q.id + '_view'">
              <td colspan="7" class="px-3.5 py-3 border-b border-line bg-bg-accent">
                <div class="flex flex-col gap-2.5">
                  <div class="bg-card border border-line rounded-[8px] p-3 text-[13px] leading-[1.7]">
                    <div class="font-600 text-text mb-1.5 flex items-center gap-1.5">
                      <i class="i-lucide-history text-primary" />上次答错 · {{ fmtTime(q.last_wrong_at)}}
                    </div>
                    <template v-if="vt && (vt.d.selected || vt.d.blanks || vt.d.my_answer || vt.d.self_grade)">
                      <div v-if="['single', 'judge', 'multi'].includes(vt.q.type)" class="flex flex-col gap-1 text-text-secondary">
                        <div>{{ vt.childLabel }}你的选择：<b class="text-danger">{{ lettersOf(vt.q, vt.d.selected) }}</b></div>
                        <div>正确答案：<b class="text-success">{{ lettersOf(vt.q, vt.q.answer?.ids) }}</b></div>
                        <div v-if="selfOverrideText(vt.d)" class="text-[12px] text-muted">{{ selfOverrideText(vt.d) }}</div>
                      </div>
                      <div v-else-if="vt.q.type === 'fill'" class="flex flex-col gap-1 text-text-secondary">
                        <div v-for="b in (vt.d.blanks || [])" :key="b.id">
                          {{ vt.childLabel }}空 <b>{{ b.id }}</b>：你的答案 <b class="text-danger">{{ b.value || '（未填）' }}</b>
                          <span v-if="!b.correct"> · 正确答案 <b class="text-success">{{ blankAnswersOf(vt.q, b.id) }}</b></span>
                          <span v-else class="text-success font-700"> ✓</span>
                        </div>
                      </div>
                      <div v-else-if="vt.q.type === 'short'" class="flex flex-col gap-1.5 text-text-secondary">
                        <div v-if="vt.d.my_answer">{{ vt.childLabel }}你的作答：<span class="whitespace-pre-wrap">{{ vt.d.my_answer }}</span></div>
                        <div v-else-if="vt.d.self_grade">自评：{{ vt.d.self_grade === '会' ? '会' : '不会' }}</div>
                        <div v-if="vt.q.answer?.reference">
                          <span class="text-success font-600">参考答案：</span>
                          <span v-html="renderDoc(vt.q.answer.reference)"></span>
                        </div>
                      </div>
                      <div v-else class="text-muted">该题型暂无结构化作答记录</div>
                    </template>
                    <div v-else class="text-muted">暂无作答记录（老数据）</div>
                  </div>
                  <QuestionPreview :question="q" />
                </div>
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
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { wrongList, wrongDismiss } from '@/api/practice.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { settings } from '@/stores/settings.js'
import { renderDoc } from '@/utils/render.js'
import QuestionPreview from '@/components/QuestionPreview.vue'
import { toast, confirmDialog } from '@/stores/ui.js'

const router = useRouter()
const type = ref('')
const bankId = ref('')
const questions = ref([])
const loading = ref(false)
const retrying = ref(false)
const error = ref('')
const PAGE_SIZE = 50
const page = ref(1)
const total = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const RETRY_KEY = 'qbank.retryIds'
const viewId = ref(null)
// 当前展开查看的题及其作答目标（材料子题定位到 child）
const viewing = computed(() => questions.value.find((x) => x.id === viewId.value) || null)
const vt = computed(() => (viewing.value ? viewTarget(viewing.value) : null))
function viewTarget(q) {
  const d = q.last_wrong_detail && typeof q.last_wrong_detail === 'object' ? q.last_wrong_detail : {}
  if (d.child_id && Array.isArray(q.children)) {
    const child = q.children.find((c) => c.id === d.child_id)
    if (child) return { q: child, d, childLabel: `第 ${d.child_index || '?'} 问 · ` }
  }
  return { q, d, childLabel: '' }
}
function keyOf(i) {
  return String.fromCharCode(65 + (i || 0))
}
function lettersOf(tq, ids) {
  if (!Array.isArray(ids) || !ids.length) return '—'
  const opts = tq?.options || []
  return ids.map((id) => {
    const i = opts.findIndex((o) => o.id === id)
    return i >= 0 ? keyOf(i) : '?'
  }).join('、')
}
function blankAnswersOf(tq, id) {
  const b = (tq?.answer?.blanks || []).find((x) => x.id === id)
  return Array.isArray(b?.answers) && b.answers.length ? b.answers.join(' / ') : '—'
}
// 复习记录带 grade/auto_correct，刷题记录没有——以此区分入库口径
function isReviewDetail(d) {
  return !!d && typeof d === 'object' && 'grade' in d
}
// 判分正确但自评忘记/困难：以自评为准入的错题本
function selfOverrideText(d) {
  if (d && d.auto_correct === true && (d.grade === 'again' || d.grade === 'hard')) {
    return `当时判分正确，但自评「${d.grade === 'again' ? '忘记' : '困难'}」——以自评为准收录`
  }
  return ''
}

// 多选 + 移除（仿 List：翻页/重查后清空；移除不删题，只是不再收录）
const selected = ref(new Set())
const dismissing = ref(false)
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

async function dismissIds(ids) {
  if (!ids.length || dismissing.value) return
  const ok = await confirmDialog({
    title: '从错题本移除',
    message: `确定移除选中的 ${ids.length} 道？试题本身保留，之后再答错会重新收录。`,
    okText: '移除'
  })
  if (!ok) return
  dismissing.value = true
  let fail = 0
  try {
    for (const id of ids) {
      try {
        await wrongDismiss(id)
      } catch (e) {
        fail++
        console.error('dismiss failed', id, e)
      }
    }
    selected.value = new Set()
    await fetchList()
    toast(fail ? `移除完成，${fail} 道失败` : `已移除 ${ids.length} 道`, fail ? 'error' : 'success')
  } finally {
    dismissing.value = false
  }
}

function onDismissOne(id) {
  dismissIds([id])
}

function onBatchDismiss() {
  dismissIds([...selected.value])
}

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
      type: type.value || undefined,
      leaveAfterCorrect: settings.wrongLeaveAfterCorrect
    })
    total.value = Number(data?.total) || 0
    questions.value = Array.isArray(data?.items) ? data.items : []
  } catch (e) {
    console.error(e)
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
    selected.value = new Set()
    viewId.value = null
  }
}

function gotoPage(p) {
  const next = Math.min(Math.max(1, p), pageCount.value)
  if (next === page.value && questions.value.length) return
  page.value = next
  fetchList().then(() => window.scrollTo(0, 0))
}

function onBankChange() {
  persistBankFilter('wrong', bankId.value)
  search()
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
      type: type.value || undefined,
      leaveAfterCorrect: settings.wrongLeaveAfterCorrect
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

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  bankId.value = resolveBankFilter('wrong')
  await fetchList()
})
</script>
