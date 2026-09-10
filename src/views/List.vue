<template>
  <div class="list-page">
    <div class="card">
      <div class="card-head">
        <h2>题库列表</h2>
        <div class="head-badges">
          <span v-if="currentBankName" class="badge cur-bank">当前：{{ currentBankName }}</span>
          <span class="badge">{{ filteredCount }} 题</span>
        </div>
      </div>

      <div class="toolbar">
        <input
          v-model="query"
          class="input"
          placeholder="搜索题干、ID..."
          @keyup.enter="fetchList"
        />
        <select v-model="type" class="select" @change="fetchList">
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
          class="select"
          :disabled="!bankStore.loaded"
          @change="fetchList"
        >
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
        <button class="btn primary" @click="fetchList">搜索</button>
        <button class="btn" @click="reset">重置</button>
        <button
          class="btn primary add-btn"
          :disabled="!bankStore.loaded || !bankStore.currentBankId"
          :title="bankStore.currentBankId ? '新增到当前题库' : '请先选择一个题库'"
          @click="onAdd"
        >＋ 新增试题</button>
      </div>

      <div v-if="loading" class="muted" style="padding: 16px 0">加载中...</div>
      <div v-else-if="error" class="error">{{ error }}</div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 160px">ID</th>
              <th style="width: 80px">类型</th>
              <th>题干</th>
              <th style="width: 70px">分值</th>
              <th style="width: 240px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="questions.length === 0">
              <td colspan="5" class="muted" style="text-align: center; padding: 24px">暂无数据</td>
            </tr>
            <tr v-for="q in questions" :key="q.id">
              <td class="mono">{{ q.id }}</td>
              <td><span class="badge type">{{ typeLabel(q.type) }}</span></td>
              <td class="stem-cell" :title="getPlainText(q)">{{ truncate(getPlainText(q), 80) }}</td>
              <td>{{ q.score ?? (q.children ? q.children.reduce((s,c)=>s+(c.score||0),0) : '-') }}</td>
              <td>
                <div class="actions">
                  <router-link :to="`/edit/${q.id}`" class="btn small">编辑</router-link>
                  <select class="select mini" :value="''" title="移动题库" @change="onMove(q.id, $event.target.value)">
                    <option value="" disabled>移动题库…</option>
                    <option v-for="b in otherBanks(q.bank_id)" :key="b.id" :value="b.id">{{ b.name }}</option>
                  </select>
                  <button class="btn small danger" @click="onDelete(q.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { list, remove, update } from '@/api/questions.js'
import { bankStore, setCurrentBank, loadBanks } from '@/stores/bank.js'

const route = useRoute()
const router = useRouter()
const query = ref('')
const type = ref('')
const questions = ref([])
const loading = ref(false)
const error = ref('')

const filteredCount = computed(() => questions.value.length)

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
  return q.id || '-'
}

async function fetchList() {
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (query.value.trim()) params.query = query.value.trim()
    if (type.value) params.type = type.value
    params.bankId = bankStore.currentBankId  // 空串 = 全部题库，由 api 层不传 bank_id
    const res = await list(params)
    // handle various response shapes: array, { data: [] }, { questions: [] }, { items: [] }
    let data = res
    if (res && Array.isArray(res.data)) data = res.data
    else if (res && Array.isArray(res.questions)) data = res.questions
    else if (res && Array.isArray(res.items)) data = res.items
    else if (res && res.data && Array.isArray(res.data.data)) data = res.data.data
    if (!Array.isArray(data)) {
      // if res is object with question array inside unknown key, try first array value
      const arrVal = res && typeof res === 'object' ? Object.values(res).find(v => Array.isArray(v)) : null
      if (arrVal) data = arrVal
      else data = []
    }
    questions.value = data
  } catch (e) {
    console.error(e)
    error.value = e?.response?.data?.error || e?.response?.data?.message || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function onAdd() {
  const bid = bankStore.currentBankId
  if (!bid) {
    alert('新增试题需要先选择一个题库')
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
    alert('移动失败：' + (e?.response?.data?.error || e?.message || e))
  }
}

function reset() {
  query.value = ''
  type.value = ''
  fetchList()
}

async function onDelete(id) {
  if (!confirm(`确定删除 ${id} ?`)) return
  try {
    await remove(id)
    await fetchList()
  } catch (e) {
    alert(e?.response?.data?.error || e.message || '删除失败')
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

<style scoped>
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.card-head h2 { margin: 0; font-size: 20px; font-weight:700; letter-spacing:-0.01em }
.head-badges { display: flex; gap: 8px; align-items: center; }
.badge.cur-bank { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }
.badge {
  display: inline-block;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  background: var(--bg-accent);
  font-weight:500;
}
.badge.type { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-accent);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.input, .select {
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: all .15s ease;
  box-shadow: var(--shadow-sm);
}
.input { flex: 1; min-width: 180px; }
.select { min-width: 130px; }
.input:focus, .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }
.btn {
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight:500;
  transition: all .15s ease;
  box-shadow: var(--shadow-sm);
}
.btn:hover { background: var(--bg-accent); border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow); }
.btn.primary { background: var(--text); color: #fff; border-color: var(--text); }
.btn.primary:hover { background: #1e293b; box-shadow: var(--shadow); }
.btn.small { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
.btn.danger { border-color: #fecaca; color: var(--danger); background: #fff; }
.btn.danger:hover { background: var(--danger-bg); border-color: #fca5a5; }
.select.mini { padding: 5px 6px; font-size: 11px; width: 104px; min-width: 0; }
.add-btn { margin-left: auto; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.table th, .table td {
  text-align: left;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.table th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; background: var(--bg-accent); }
.table tbody tr:hover{ background: #f8fafc }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); background: var(--bg-accent); padding:2px 6px; border-radius:4px }
.stem-cell { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); font-weight:500 }
.muted { color: var(--muted); }
.error { color: #b91c1c; background: var(--danger-bg); border: 1px solid #fecaca; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
