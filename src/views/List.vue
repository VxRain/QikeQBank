<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-list text-primary" />试题列表
        </h2>
        <div class="flex gap-2 items-center">
          <span v-if="bankName" class="badge badge-cur">{{ bankName }}</span>
          <span v-else-if="isCross" class="badge badge-cur">全部题库</span>
          <span class="badge">{{ filteredCount }} 题</span>
          <router-link to="/banks" class="btn btn-small"><i class="i-lucide-arrow-left" />题库管理</router-link>
        </div>
      </div>

      <div v-if="!bankId && !isCross" class="text-center py-8 text-muted flex flex-col items-center gap-3">
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
        <select v-model="type" class="select min-w-[130px]" @change="onFilterChange">
          <option value="">全部类型</option>
          <option v-for="t in QUESTION_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
        </select>
        <select v-model="difficulty" class="select min-w-[110px]" @change="onFilterChange">
          <option value="">全部难度</option>
          <option v-for="d in DIFFICULTY_CHOICES" :key="d" :value="String(d)">难度 {{ d }}</option>
        </select>
        <select v-model="status" class="select min-w-[110px]" @change="onFilterChange">
          <option value="">全部状态</option>
          <option v-for="s in STATUS_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
        <select v-model="sort" class="select min-w-[120px]" @change="onFilterChange">
          <option v-for="s in SORT_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
        <button class="btn btn-primary" @click="search">
          <i class="i-lucide-search" />搜索
        </button>
        <button class="btn" @click="reset">
          <i class="i-lucide-rotate-ccw" />重置
        </button>
        <!-- 跨库模式（/library?q=，来自全局搜索「查看全部」）：导入/新增都需要题库归属，不在这里提供 -->
        <template v-if="bankId">
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
        </template>
        <span v-else class="ml-auto text-[12.5px] text-muted flex items-center gap-1.5">
          <i class="i-lucide-search" />跨题库搜索结果 · 要编辑或新增请先进入具体题库
        </span>
      </div>
      <ImportFileBox
        v-if="bankId"
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
      <div v-if="selected.size" class="batch-bar flex flex-wrap items-center gap-2 px-3.5 py-2.5 mb-3 bg-primary-bg border border-primary-border rounded-[10px] text-[13px]">
        <span class="font-600 text-primary">已选 {{ selected.size }} 题</span>
        <button type="button" class="btn btn-small" :disabled="batchBusy" @click="onBatchMove"><i class="i-lucide-folder-input" />移动</button>
        <button type="button" class="btn btn-small" :disabled="batchBusy" @click="onBatchDifficulty"><i class="i-lucide-signal" />难度</button>
        <button type="button" class="btn btn-small" :disabled="batchBusy" @click="onBatchStatus"><i class="i-lucide-circle-check-big" />状态</button>
        <button type="button" class="btn btn-small btn-danger" :disabled="batchBusy" @click="onBatchDelete"><i class="i-lucide-trash-2" />删除</button>
        <button type="button" class="btn btn-small btn-ghost" @click="clearSelection">取消选择</button>
        <span v-if="batchBusy" class="flex items-center gap-1.5 text-muted"><i class="i-lucide-loader-circle animate-spin" />处理中…</span>
      </div>

      <!-- 逐项失败汇总：失败项可重试（FE-P0-10 验收要求） -->
      <div v-if="batchFailed.length" class="mb-3 px-3.5 py-2.5 bg-danger-bg border border-danger rounded-[10px] text-[13px]">
        <div class="flex items-center gap-2 font-600 text-danger mb-1.5">
          <i class="i-lucide-triangle-alert" />{{ batchFailed.length }} 项未成功
        </div>
        <ul class="m-0 pl-5 text-text-secondary">
          <li v-for="f in batchFailed.slice(0, 5)" :key="f.id" class="truncate">{{ f.id }}：{{ f.reason }}</li>
          <li v-if="batchFailed.length > 5" class="text-muted">…… 共 {{ batchFailed.length }} 项</li>
        </ul>
        <div class="flex gap-2 mt-2">
          <button type="button" class="btn btn-small" :disabled="batchBusy" @click="retryBatchFailed"><i class="i-lucide-rotate-ccw" />重试失败项</button>
          <button type="button" class="btn btn-small btn-ghost" @click="batchFailed = []">知道了</button>
        </div>
      </div>

      <div class="overflow-x-auto border border-line rounded-[12px]">
        <table class="w-full border-collapse text-[14px]">
          <thead>
            <tr>
              <th class="px-3 py-3 border-b border-line bg-bg-accent" style="width: 40px">
                <input type="checkbox" class="accent-[#1f4d3a] w-4 h-4 cursor-pointer align-middle" title="全选本页" :checked="allChecked" :indeterminate="someChecked && !allChecked" @change="toggleAll($event.target.checked)" />
              </th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 80px">类型</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 76px" title="草稿 / 停用的题不会出现在刷题、复习、模考里">状态</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent">题干</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">难度</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 70px">分值</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 92px" title="最后修改时间">最近编辑</th>
              <th class="text-right px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 104px" title="作答次数 · 正确率（仅统计练习/复习）">作答 / 正确率</th>
              <th class="text-left px-3.5 py-3 border-b border-line text-[12px] uppercase tracking-wide text-muted font-600 bg-bg-accent" style="width: 240px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="questions.length === 0">
              <td colspan="9" class="text-center py-6 text-muted">
                <div v-if="isFiltered" class="flex flex-col items-center gap-3 py-2">
                  <i class="i-lucide-search-x text-[24px]" />
                  <div>没有符合当前筛选条件的试题</div>
                  <button type="button" class="btn btn-small" @click="reset"><i class="i-lucide-rotate-ccw" />清除筛选</button>
                </div>
                <div v-else-if="isCross" class="flex flex-col items-center gap-3 py-2">
                  <i class="i-lucide-search-x text-[24px]" />
                  <div>全部题库里没有匹配「{{ crossQuery }}」的试题</div>
                  <div class="flex gap-2">
                    <button type="button" class="btn btn-small" @click="router.push('/banks')"><i class="i-lucide-library" />去题库管理</button>
                  </div>
                </div>
                <div v-else class="flex flex-col items-center gap-3 py-2">
                  <i class="i-lucide-folder-open text-[24px]" />
                  <div>这个题库还没有试题</div>
                  <div class="flex gap-2">
                    <button type="button" class="btn btn-primary btn-small" @click="onAdd"><i class="i-lucide-plus" />新增试题</button>
                    <button type="button" class="btn btn-small" @click="showImport = true"><i class="i-lucide-file-up" />导入试题</button>
                  </div>
                </div>
              </td>
            </tr>
            <template v-for="q in questions" :key="q.id">
            <tr class="transition-[background-color] duration-100 hover:bg-card-hover" :class="selected.has(q.id) && 'row-on'">
              <td class="px-3 py-3 border-b border-line text-center">
                <input type="checkbox" class="accent-[#1f4d3a] w-4 h-4 cursor-pointer align-middle" :checked="selected.has(q.id)" @change="toggleOne(q.id, $event.target.checked)" />
              </td>
              <td class="px-3.5 py-3 border-b border-line"><span class="badge badge-type">{{ typeLabel(q.type) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line"><span class="badge" :class="statusBadgeClass(q.status)" :title="statusHint(q.status)">{{ statusLabel(q.status) }}</span></td>
              <td class="px-3.5 py-3 border-b border-line max-w-[420px] truncate text-text-secondary font-500" :title="getPlainText(q)">
                {{ truncate(getPlainText(q), 80) }}
                <!-- 跨库模式必须标来源题库，否则同一批结果无从分辨归属 -->
                <span v-if="isCross" class="text-[11.5px] text-muted-light ml-1.5">· {{ bankLabel(q.bank_id) }}</span>
              </td>
              <td class="px-3.5 py-3 border-b border-line"><span class="difficulty-dots" :title="'难度 ' + (q.difficulty ?? 2) + ' / 5'"><i v-for="n in 5" :key="n" :class="['dot', n <= (q.difficulty ?? 2) && 'on']" /></span></td>
              <td class="px-3.5 py-3 border-b border-line">{{ displayScore(q) }}</td>
              <td class="px-3.5 py-3 border-b border-line text-[12px] text-muted whitespace-nowrap" :title="q.updated_at || ''">{{ fmtDate(q.updated_at) }}</td>
              <td class="px-3.5 py-3 border-b border-line text-right text-[12px] whitespace-nowrap">
                <template v-if="qStats(q)">
                  <span class="text-text-secondary tabular-nums">{{ qStats(q).attempt_count }}</span>
                  <span class="text-muted-light"> · </span>
                  <span :class="qStats(q).rate == null ? 'text-muted-light' : qStats(q).rate >= 0.6 ? 'text-success font-600' : 'text-danger font-700'">
                    {{ qStats(q).rate == null ? '—' : Math.round(qStats(q).rate * 100) + '%' }}
                  </span>
                </template>
                <span v-else class="text-muted-light" title="统计加载中">—</span>
              </td>
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
              <td colspan="9" class="px-3.5 py-3 border-b border-line bg-bg-accent">
                <div v-if="previewLoading && !previewCache[q.id]" class="text-muted py-4 flex items-center gap-2">
                  <i class="i-lucide-loader-circle animate-spin" />加载中...
                </div>
                <QuestionPreview v-else-if="previewCache[q.id]" :question="previewCache[q.id]" />
                <!-- FE-P1-04 单题统计：展开行里给完整四项，列表行只放「次数 · 正确率」压缩版 -->
                <div v-if="qStats(q)" class="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px]">
                  <span class="text-muted font-600 flex items-center gap-1.5"><i class="i-lucide-sigma text-primary" />本题作答</span>
                  <span class="text-text-secondary">作答 <b class="text-text tabular-nums">{{ qStats(q).attempt_count }}</b> 次</span>
                  <span class="text-text-secondary">答对 <b class="tabular-nums" :class="qStats(q).correct > 0 ? 'text-success' : 'text-text'">{{ qStats(q).correct }}</b> 次</span>
                  <span class="text-text-secondary">
                    正确率
                    <b :class="qStats(q).rate == null ? 'text-muted-light' : qStats(q).rate >= 0.6 ? 'text-success' : 'text-danger'">
                      {{ qStats(q).rate == null ? '尚未作答' : Math.round(qStats(q).rate * 100) + '%' }}
                    </b>
                  </span>
                  <span class="text-text-secondary">平均用时 <b class="text-text tabular-nums">{{ fmtDuration(qStats(q).avgMs) }}</b></span>
                  <span class="text-text-secondary">最近作答 <b class="text-text">{{ qStats(q).last ? fmtDate(qStats(q).last) : '—' }}</b></span>
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="!loading && !error && total > 0" class="flex items-center justify-center gap-3 py-4 flex-wrap">
        <button type="button" class="btn btn-small" :disabled="page <= 1" @click="gotoPage(page - 1)">
          <i class="i-lucide-chevron-left" />上一页
        </button>
        <span class="text-[13px] text-muted font-500">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 题</span>
        <button type="button" class="btn btn-small" :disabled="page >= pageCount" @click="gotoPage(page + 1)">
          下一页<i class="i-lucide-chevron-right" />
        </button>
        <select v-model.number="pageSize" class="select w-[110px] text-[13px]" title="每页条数" @change="onPageSizeChange">
          <option v-for="n in PAGE_SIZE_CHOICES" :key="n" :value="n">{{ n }} 条/页</option>
        </select>
      </div>
      </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { list, get, remove, batchUpdate, batchRemove } from '@/api/questions.js'
import { bankStore, loadBanks, bankExists } from '@/stores/bank.js'
import { toast, confirmDialog, selectDialog } from '@/stores/ui.js'
import ImportFileBox from '@/components/ImportFileBox.vue'
import QuestionPreview from '@/components/QuestionPreview.vue'
import { QUESTION_TYPES, typeLabel } from '@/constants/questions.js'
import {
  SORT_OPTIONS,
  DIFFICULTY_CHOICES,
  STATUS_OPTIONS,
  STATUS_HINTS,
  statusLabel,
  PAGE_SIZE_CHOICES,
  DEFAULT_PAGE_SIZE,
  emptyFilter,
  normalizeFilter,
  loadFilter,
  saveFilter,
  clampPage
} from '@/stores/listFilter.js'

const route = useRoute()
const router = useRouter()
const query = ref('')
const type = ref('')
const difficulty = ref('')
const status = ref('')
const sort = ref(emptyFilter().sort)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const questions = ref([])
const showImport = ref(false)
const page = ref(1)
const total = ref(0)
const previewId = ref(null)
// 摘要列表不含题面详情，预览时按需拉全量并缓存
const previewCache = ref({})
const previewLoading = ref(false)
// pageSize 可改，所以页数必须跟它联动（旧实现写死 PAGE_SIZE）
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / (pageSize.value || DEFAULT_PAGE_SIZE))))
// 当前是否有筛选（用于区分「库里没题」与「筛没了」两种空态）
const isFiltered = computed(
  () => !!(query.value.trim() || type.value || difficulty.value || status.value)
)
// 本页题库上下文：只从 ?bank= 来（从题库页进入），无选择器；直访无 bank 则提示去挑库
const bankId = ref('')
const bankName = computed(() => bankStore.banks.find((x) => x.id === bankId.value)?.name || '')

/**
 * 跨库模式（/library?q=xxx）—— 全局搜索面板「查看全部」的落地页。
 *
 * 为什么不新增 /search 路由：跨库搜题所需的一切（排序白名单、难度/状态筛选、
 * 每页条数、页码收敛）List.vue 都已经实现；再建一个结果页就是把同一套逻辑抄第二份。
 * 这里只做「无 bank + 有关键词」一个分支：
 * - 请求不带 bankId → 后端本来就把 bankId 当可选参数（跨库查询），零后端改动
 * - 筛选条件不落 localStorage（loadFilter/saveFilter 无 bankId 时直接返回默认）
 * - 导入/新增入口隐藏（两者都需要题库归属）
 */
const crossQuery = ref('')
const isCross = computed(() => !bankId.value && crossQuery.value.trim() !== '')

/** 跨库结果行上的题库名（题库列表还没加载完时给个中性占位，不显示裸 id） */
function bankLabel(id) {
  return bankStore.banks.find((b) => b.id === id)?.name || '未知题库'
}

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
// 逐项失败汇总（FE-P0-10）：失败项可重试，不再只报一个总数
const batchFailed = ref([])
// 记住上一次批量动作，供「重试失败项」使用
let lastBatchAction = null
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
  get(id).then((full) => {
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
// FE-P0-10：批量走一次 questions_batch_update，不再逐条 IPC
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
  await runBatch({ kind: 'update', ids, patch: { bank_id: target } }, `已将 ${ids.length} 道试题移到「${targetName}」`)
}

/**
 * 批量动作统一入口：一次 IPC + 逐项失败汇总。
 * @param {{kind:'update'|'remove', ids:string[], patch?:object}} action
 * @param {string} okText 全部成功的提示文案
 */
async function runBatch(action, okText) {
  if (!action.ids.length || batchBusy.value) return
  batchBusy.value = true
  batchFailed.value = []
  lastBatchAction = action
  try {
    const data = action.kind === 'remove'
      ? await batchRemove(action.ids)
      : await batchUpdate(action.ids, action.patch)
    const failed = Array.isArray(data?.failed) ? data.failed : []
    const done = action.kind === 'remove' ? Number(data?.removed) || 0 : Number(data?.updated) || 0
    batchFailed.value = failed
    clearSelection()
    await fetchList()
    await loadBanks()
    if (failed.length) {
      toast(`${done} 项成功，${failed.length} 项失败（详见下方列表）`, 'error')
    } else {
      toast(okText, 'success')
    }
  } catch (e) {
    // 整批拒结（patch 非法 / 目标库不存在 / 空 ids）：错误必须让用户看到，不能吞
    console.error(e)
    toast(e?.message || '批量操作失败', 'error')
  } finally {
    batchBusy.value = false
  }
}

async function retryBatchFailed() {
  if (!lastBatchAction || !batchFailed.value.length) return
  const ids = batchFailed.value.map((f) => f.id)
  await runBatch({ ...lastBatchAction, ids }, '重试项已全部成功')
}

function onMoveOne(id) {
  moveQuestions([id])
}

/** 批量改难度：选 1–5，走 questions_batch_update */
async function onBatchDifficulty() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  const target = await selectDialog({
    title: `修改 ${ids.length} 道试题的难度`,
    message: '选择难度',
    options: DIFFICULTY_CHOICES.map((d) => ({ value: String(d), label: `难度 ${d}` })),
    okText: '应用'
  })
  if (!target) return
  await runBatch({ kind: 'update', ids, patch: { difficulty: Number(target) } }, `已将 ${ids.length} 道试题难度改为 ${target}`)
}

/** 批量改状态 */
async function onBatchStatus() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  const target = await selectDialog({
    title: `修改 ${ids.length} 道试题的状态`,
    message: '选择状态',
    options: STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label })),
    okText: '应用'
  })
  if (!target) return
  const label = STATUS_OPTIONS.find((s) => s.value === target)?.label || target
  await runBatch({ kind: 'update', ids, patch: { status: target } }, `已将 ${ids.length} 道试题标为「${label}」`)
}

async function onBatchDelete() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  const ok = await confirmDialog({
    title: '批量删除',
    message: `确定删除选中的 ${ids.length} 道试题？此操作不可撤销（回收站待 FE-P0-02）。`,
    okText: '删除',
    danger: true
  })
  if (!ok) return
  await runBatch({ kind: 'remove', ids }, `已删除 ${ids.length} 道试题`)
}

async function onBatchMove() {
  await moveQuestions([...selected.value])
}

/** 毫秒 → 人读时长（统计里 avg_ms 只用于「做题快慢」感知，不参与判分） */
function fmtDuration(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return '—'
  const s = n / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
}

/** 状态徽章配色：草稿/停用要一眼看出「不参与抽题」，但不用危险色（不是错误） */
function statusBadgeClass(v) {
  if (v === 'draft') return 'badge-warn'
  if (v === 'archived') return 'badge-muted'
  return 'badge-ok'
}

/** 状态说明：与录题页共用同一份措辞（STATUS_HINTS），避免两处口径漂移 */
function statusHint(v) {
  return STATUS_HINTS[v] || ''
}

/** ISO → 本地 YYYY-MM-DD HH:mm；无效值给占位，不显示 Invalid Date */
function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 行内统计（FE-P1-04）：后端 stats 字段 → 展示用对象。
 * rate 为 null 表示没做过（不是 0%），列表要与「做过但全错」区分开。
 */
function qStats(q) {
  const st = q?.stats
  if (!st) return null
  const attempts = Number(st.attempt_count) || 0
  const correct = Number(st.correct_count) || 0
  return { attempts, correct, attempt_count: attempts, rate: attempts > 0 ? correct / attempts : null, last: st.last_answered_at || null, avgMs: Number(st.avg_ms) || 0 }
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
  // 既没有题库上下文、也不是跨库搜索 → 页面此时显示「先选题库」，不发请求
  if (!bankId.value && !isCross.value) return
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (query.value.trim()) params.query = query.value.trim()
    if (type.value) params.type = type.value
    if (difficulty.value) params.difficulty = difficulty.value
    if (status.value) params.status = status.value
    // 跨库模式刻意不下发 bankId：后端把它当可选参数，缺省即全库查询
    if (bankId.value) params.bankId = bankId.value
    params.limit = pageSize.value
    params.offset = (page.value - 1) * pageSize.value
    params.summary = true
    params.sort = sort.value
    // FE-P1-04：当前页的单题统计（只查这 50 个 id，后端不做全库扫描）
    params.stats = true
    // 契约：questions_list 经 bridge.unwrap 拆包后固定为 {total, items}
    const data = await list(params)
    total.value = Number(data?.total) || 0

    // 页码收敛：删掉末页最后一题 / 换窄筛选后，page 可能已越界（「第 3 / 2 页」）
    const safe = clampPage(page.value, total.value, pageSize.value)
    if (safe !== page.value) {
      page.value = safe
      loading.value = false
      // 递归重查一次真实数据；若再次越界说明总数据在变，clampPage 会一路收敛到 1
      return fetchList()
    }

    questions.value = Array.isArray(data?.items) ? data.items : []
    persistFilter()
  } catch (e) {
    console.error(e)
    error.value = e?.message || '加载失败'
    // 排序参数被后端拒绝时不隐藏问题：提示出来，避免用户以为排序生效了
    if (/invalid sort/i.test(error.value)) toast(error.value, 'error')
  } finally {
    loading.value = false
    clearSelection()
    previewId.value = null
    previewCache.value = {}
    previewLoading.value = false
  }
}

/** 把当前筛选条件写进 localStorage（按 页:题库 分键）；跨库模式不落盘，避免与具体题库互相污染 */
function persistFilter() {
  if (!bankId.value) return
  saveFilter('list', bankId.value, {
    query: query.value,
    type: type.value,
    difficulty: difficulty.value,
    status: status.value,
    sort: sort.value,
    pageSize: pageSize.value
  })
}

/** 筛选条件变更：一律回到第 1 页（否则会停在无效页） */
function onFilterChange() {
  page.value = 1
  fetchList()
}

function onPageSizeChange() {
  page.value = 1
  fetchList()
}

function gotoPage(p) {
  const next = clampPage(p, total.value, pageSize.value)
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
  const def = emptyFilter()
  // 跨库模式的关键词来自 URL（搜索面板「查看全部」），重置筛选不该把它清掉
  query.value = isCross.value ? crossQuery.value : def.query
  type.value = def.type
  difficulty.value = def.difficulty
  status.value = def.status
  sort.value = def.sort
  pageSize.value = def.pageSize
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
    toast(e?.message || '删除失败', 'error')
  }
}

/**
 * 从 URL 同步页面上下文（?bank= 题库归属 / ?q= 跨库关键词）。
 *
 * 为什么是一个函数而不是「onMounted 里读一次」：
 * 全局搜索面板会把用户从 /library?q=a 直接带到 /library?q=b，甚至 /library?q= → /library?bank=x，
 * 这些跳转**命中的是同一条路由**，组件不会重新挂载 —— 只在 onMounted 里读 query 会得到一个
 * 永远不更新的页面（表现为换了关键词列表不变、或切回带 bank 的地址却仍提示「先选题库」）。
 *
 * @returns {{bankChanged:boolean, qChanged:boolean, nextBank:string, nextQ:string}|null}
 *   无变化返回 null，调用方据此跳过重复请求。
 */
function readRouteContext() {
  const qb = route.query.bank
  const nextBank = typeof qb === 'string' && bankExists(qb) ? qb : ''
  const nextQ = typeof route.query.q === 'string' ? route.query.q : ''
  if (nextBank === bankId.value && nextQ === crossQuery.value) return null
  const bankChanged = nextBank !== bankId.value
  const qChanged = nextQ !== crossQuery.value
  bankId.value = nextBank
  crossQuery.value = nextQ
  return { bankChanged, qChanged, nextBank, nextQ }
}

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  // 题库上下文只认 ?bank=（须仍存在），跨库关键词只认 ?q=
  readRouteContext()
  // 刷新/返回后恢复上次筛选（按 页:题库 分键，不同题库互不影响）；跨库模式用 URL 关键词
  const saved = normalizeFilter(loadFilter('list', bankId.value))
  query.value = isCross.value ? crossQuery.value : saved.query
  type.value = saved.type
  difficulty.value = saved.difficulty
  status.value = saved.status
  sort.value = saved.sort
  pageSize.value = saved.pageSize
  await fetchList()
  // FE-P1-01 首页「导入试题」深链：/library?bank=x&import=1 直接弹出导入弹层
  if (route.query.import === '1' && bankId.value) {
    showImport.value = true
    // 消费掉参数：否则刷新或页内导航会反复弹层
    const { import: _drop, ...rest } = route.query
    router.replace({ query: rest })
  }
})

/**
 * 同一路由内的上下文变化（?bank= / ?q=）：
 * - 换题库 → 恢复该题库自己的筛选记忆（与首次进入行为一致）
 * - 换关键词（跨库模式）→ 直接用新关键词重查，不继承上一批筛选条件
 */
watch(
  () => [route.query.bank, route.query.q],
  ([, q]) => {
    const next = readRouteContext()
    if (!next) return
    if (next.bankChanged) {
      const saved = normalizeFilter(loadFilter('list', bankId.value))
      query.value = saved.query
      type.value = saved.type
      difficulty.value = saved.difficulty
      status.value = saved.status
      sort.value = saved.sort
      pageSize.value = saved.pageSize
    } else if (next.qChanged) {
      query.value = next.nextQ
      type.value = ''
      difficulty.value = ''
      status.value = ''
    }
    page.value = 1
    if (!bankId.value && !crossQuery.value.trim()) {
      // 两个上下文都没了 → 回到「先选题库」空态，不发请求
      questions.value = []
      total.value = 0
      clearSelection()
      return
    }
    fetchList()
  }
)
</script>

<style scoped>
/* 难度点阵：5 个点，亮起数 = difficulty（复用全局 CSS 变量，不另起色板） */
.difficulty-dots {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}
.difficulty-dots .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line);
}
.difficulty-dots .dot.on {
  background: var(--primary);
}
</style>

