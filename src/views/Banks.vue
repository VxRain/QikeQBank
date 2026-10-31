/**
 * 题库管理页（/banks）
 * 双视图：卡片网格 / 紧凑列表（右上切换，localStorage 记忆）；
 * 点击进入题库；操作全左键（录题/导入/编辑/删除，统一纯图标钮）。
 * 新建/重命名共用应用内弹窗（名字 + 描述）。
 */
<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-library text-primary" />题库管理
        </h2>
        <div class="flex items-center gap-2.5">
          <span class="badge">{{ bankStore.banks.length }} 个题库 · 共 {{ totalCount }} 题</span>
          <!-- 视图切换：图标钮组，与操作钮同语言 -->
          <span class="inline-flex items-center border border-line rounded-[8px] overflow-hidden">
            <button type="button" class="seg-icon" :class="view === 'grid' ? 'seg-icon-on' : ''" title="卡片视图" @click="setView('grid')"><i class="i-lucide-layout-grid text-[15px]" /></button>
            <button type="button" class="seg-icon" :class="view === 'list' ? 'seg-icon-on' : ''" title="列表视图" @click="setView('list')"><i class="i-lucide-list text-[15px]" /></button>
          </span>
          <button type="button" class="btn btn-primary btn-small" @click="openCreate">
            <i class="i-lucide-plus" />新建题库
          </button>
        </div>
      </div>

      <div v-if="!bankStore.loaded" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />正在加载题库…
      </div>

      <div v-else-if="bankStore.banks.length === 0" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-folder-open" />暂无题库，点击右上新建
      </div>

      <div v-else class="flex flex-col gap-2.5">
        <!-- 搜索 + 排序：题库多了才出现（少于 4 个时这些控件只是噪声） -->
        <div v-if="bankStore.banks.length > 3 || query || sort !== DEFAULT_BANK_SORT" class="flex flex-wrap items-center gap-2">
          <div class="relative">
            <i class="i-lucide-search absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-light text-[14px]" />
            <input
              v-model="query"
              class="input w-[220px] !pl-8"
              type="text"
              placeholder="搜索题库名称或描述"
              aria-label="搜索题库"
            />
          </div>
          <select v-model="sort" class="select min-w-[150px]" aria-label="题库排序">
            <option v-for="o in BANK_SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span v-if="visibleBanks.length !== bankStore.banks.length" class="badge">{{ visibleBanks.length }} / {{ bankStore.banks.length }}</span>
          <span v-if="sort === 'custom' && dragEnabled" class="text-[12px] text-muted-light flex items-center gap-1.5">
            <i class="i-lucide-grip-vertical" />拖动卡片可调整顺序
          </span>
          <span v-else-if="dragDisabledReason" class="text-[12px] text-muted-light flex items-center gap-1.5">
            <i class="i-lucide-info" />{{ dragDisabledReason }}
          </span>
        </div>

        <div v-if="!visibleBanks.length" class="text-muted py-3 flex items-center gap-2">
          <i class="i-lucide-search-x" />没有匹配「{{ query }}」的题库
          <button type="button" class="btn btn-small ml-2" @click="query = ''">清除搜索</button>
        </div>

        <!-- 列表视图：每行一库，信息与操作横向铺开，密度高于卡片 -->
        <div v-if="view === 'list'" class="flex flex-col gap-2">
          <div
            v-for="(b, i) in visibleBanks"
            :key="b.id"
            role="button"
            tabindex="0"
            :draggable="dragEnabled"
            class="bank-row card card-interactive flex items-center gap-4 cursor-pointer !px-4 !py-3"
            :class="dragEnabled && 'bank-draggable'"
            :title="`进入「${b.name}」`"
            @click="onEnter(b)"
            @keyup.enter="onEnter(b)"
            @dragstart="onDragStart(i, $event)"
            @dragover.prevent="onDragOver(i)"
            @drop.prevent="onDrop(i)"
            @dragend="onDragEnd"
          >
            <i v-if="dragEnabled" class="i-lucide-grip-vertical text-[15px] shrink-0 text-muted-light cursor-grab" />
            <i class="i-lucide-folder text-[19px] shrink-0 text-muted-light" />
            <div class="flex items-center gap-2.5 min-w-0 w-[220px] shrink-0">
              <span class="font-700 text-[14px] text-text truncate">{{ b.name }}</span>
            </div>
            <p class="m-0 flex-1 min-w-0 text-[12px] text-muted leading-[1.6] truncate">
              {{ b.description || ' ' }}
            </p>
            <span class="text-[12px] text-muted-light shrink-0 tabular-nums">{{ b.question_count ?? 0 }} 题</span>
            <span class="text-[12px] text-muted-light shrink-0 tabular-nums" :title="`最近更新 ${fmtDate(b.updated_at)}`">{{ fmtDate(b.updated_at) }}</span>
            <span class="bank-actions flex items-center gap-1 shrink-0">
              <button
                v-for="s in BANK_SHORTCUTS"
                :key="s.key"
                type="button"
                class="btn btn-tiny !px-2"
                :title="`${s.label}（限本库）`"
                @click.stop="goShortcut(b, s)"
              ><i :class="s.icon" /></button>
              <span class="w-px h-4 bg-line mx-0.5" />
              <button type="button" class="btn btn-tiny !px-2" title="录入试题到这个库" @click.stop="goCreate(b)"><i class="i-lucide-plus" /></button>
              <button type="button" class="btn btn-tiny !px-2" title="从文件导入到这个库" @click.stop="openImport(b)"><i class="i-lucide-file-up" /></button>
              <button type="button" class="btn btn-tiny !px-2" title="复制题库（题目一并复制）" @click.stop="onDuplicate(b)"><i class="i-lucide-copy" /></button>
              <button type="button" class="btn btn-tiny !px-2" title="导出为 Markdown（可再导入）" @click.stop="onExport(b)"><i class="i-lucide-download" /></button>
              <button type="button" class="btn btn-tiny !px-2" title="重命名 / 修改描述" @click.stop="openRename(b)"><i class="i-lucide-pen-line" /></button>
              <button type="button" class="btn btn-tiny btn-danger !px-2" title="删除题库" @click.stop="onRemoveBank(b)"><i class="i-lucide-trash-2" /></button>
            </span>
          </div>
        </div>

        <!-- 卡片视图：自适应栅格（窄窗口自动减列，不挤压） -->
        <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
          <div
            v-for="(b, i) in visibleBanks"
            :key="b.id"
            role="button"
            tabindex="0"
            :draggable="dragEnabled"
            class="bank-card card card-interactive flex flex-col cursor-pointer !p-4 !pt-4.5"
            :class="dragEnabled && 'bank-draggable'"
            :title="`进入「${b.name}」`"
            @click="onEnter(b)"
            @keyup.enter="onEnter(b)"
            @dragstart="onDragStart(i, $event)"
            @dragover.prevent="onDragOver(i)"
            @drop.prevent="onDrop(i)"
            @dragend="onDragEnd"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <i v-if="dragEnabled" class="i-lucide-grip-vertical text-[14px] shrink-0 text-muted-light cursor-grab" />
                <i class="i-lucide-folder text-[18px] shrink-0 text-muted-light" />
                <span class="font-700 text-[14px] text-text truncate">{{ b.name }}</span>
              </div>
              <span class="text-[12px] text-muted-light shrink-0 pt-0.5">{{ b.question_count ?? 0 }} 题</span>
            </div>
            <p class="m-0 text-[12px] text-muted leading-[1.7] line-clamp-2 min-h-[44px] py-1">
              {{ b.description }}
            </p>
            <!-- 快捷入口：刷题 / 复习 / 错题 / 统计（均带 ?bank=） -->
            <div class="grid grid-cols-4 gap-1.5">
              <button
                v-for="s in BANK_SHORTCUTS"
                :key="s.key"
                type="button"
                class="btn btn-tiny justify-center min-w-0"
                :title="`${s.label}（限本库）`"
                @click.stop="goShortcut(b, s)"
              ><i :class="s.icon + ' shrink-0'" /><span class="truncate">{{ s.label }}</span></button>
            </div>
            <!-- 操作行：与卡片主体用分隔线隔开 -->
            <div class="bank-actions grid grid-cols-6 gap-1.5 mt-auto pt-3 border-t border-line">
              <button type="button" class="btn btn-tiny justify-center min-w-0" title="录入试题到这个库" @click.stop="goCreate(b)"><i class="i-lucide-plus shrink-0" /></button>
              <button type="button" class="btn btn-tiny justify-center min-w-0" title="从文件导入到这个库" @click.stop="openImport(b)"><i class="i-lucide-file-up shrink-0" /></button>
              <button type="button" class="btn btn-tiny justify-center min-w-0" title="复制题库（题目一并复制）" @click.stop="onDuplicate(b)"><i class="i-lucide-copy shrink-0" /></button>
              <button type="button" class="btn btn-tiny justify-center min-w-0" title="导出为 Markdown（可再导入）" @click.stop="onExport(b)"><i class="i-lucide-download shrink-0" /></button>
              <button type="button" class="btn btn-tiny justify-center min-w-0" title="重命名 / 修改描述" @click.stop="openRename(b)"><i class="i-lucide-pen-line shrink-0" /></button>
              <button type="button" class="btn btn-tiny btn-danger justify-center min-w-0" title="删除题库" @click.stop="onRemoveBank(b)"><i class="i-lucide-trash-2 shrink-0" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 导入试题：直接在此页弹窗，目标即所选库 -->
    <ImportFileBox
      :open="showImport"
      :bank-id="importBank.id"
      :bank-name="importBank.name"
      @done="onImportDone"
      @close="showImport = false"
    />

    <!-- 新建 / 重命名弹窗：名字 + 描述，复用 DialogHost 视觉语言 -->
    <Teleport to="body">
      <Transition name="dg">
        <div v-if="dlg" class="dg-mask fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="dlg = null">
          <div
            ref="dlgCardEl"
            class="dg-card w-[min(420px,calc(100vw-48px))] bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5"
            role="dialog"
            aria-modal="true"
            :aria-label="dlg.mode === 'create' ? '新建题库' : '重命名题库'"
            tabindex="-1"
          >
            <h3 class="m-0 mb-3.5 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)]">
              {{ dlg.mode === 'create' ? '新建题库' : '重命名题库' }}
            </h3>
            <label class="field-label" for="bank-dlg-name">名称</label>
            <input
              id="bank-dlg-name"
              v-model="dlg.name"
              class="input w-full mb-3.5"
              type="text"
              placeholder="题库名称"
              maxlength="60"
              @keyup.enter="onDlgOk"
              @keyup.esc="dlg = null"
            />
            <label class="field-label" for="bank-dlg-desc">描述（可选）</label>
            <textarea
              id="bank-dlg-desc"
              v-model="dlg.description"
              class="input w-full mb-4 resize-y min-h-[72px] leading-[1.6]"
              rows="3"
              placeholder="一句话说明这个题库的用途…"
              maxlength="300"
              @keyup.esc="dlg = null"
            />
            <div class="flex justify-end gap-2.5">
              <button type="button" class="btn" @click="dlg = null">取消</button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="dlg.saving || !dlg.name.trim()"
                @click="onDlgOk"
              >{{ dlg.saving ? '保存中…' : '确定' }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { bankStore, loadBanks } from '@/stores/bank.js'
import { createBank, updateBank, removeBank, duplicateBank, exportBankMarkdown } from '@/api/banks.js'
import { list } from '@/api/questions.js'
import { toast, confirmDialog, promptDialog } from '@/stores/ui.js'
import { useDialogA11y } from '@/composables/useDialogA11y.js'
import {
  BANK_SORT_OPTIONS,
  DEFAULT_BANK_SORT,
  normalizeBankSort,
  sortAndFilterBanks,
  canDragBanks,
  moveId,
  BANK_SHORTCUTS,
  shortcutHref
} from '@/stores/banksView.js'
import { bankToMarkdown, exportFileName } from '@/utils/exportBank.js'
import ImportFileBox from '@/components/ImportFileBox.vue'

const router = useRouter()

// 导入弹窗：直接在此页打开，目标即所选库
const showImport = ref(false)
const importBank = ref({ id: '', name: '' })

// ── 视图切换（卡片/列表），localStorage 记忆 ──
const VIEW_KEY = 'qbank.banksView'
const view = ref(localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid')
function setView(v) {
  view.value = v
  try {
    if (v === 'grid') localStorage.removeItem(VIEW_KEY)
    else localStorage.setItem(VIEW_KEY, 'list')
  } catch { /* 忽略持久化失败 */ }
}

// ── 搜索 / 排序 / 自定义顺序（FE-P1-02）──
const SORT_KEY = 'qbank.banksSort'
const ORDER_KEY = 'qbank.banksOrder'
const query = ref('')
const sort = ref(normalizeBankSort(localStorage.getItem(SORT_KEY)))
const customOrder = ref(readOrder())

function readOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function persistOrder(ids) {
  customOrder.value = ids
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch { /* 忽略持久化失败 */ }
}

watch(sort, (v) => {
  try {
    localStorage.setItem(SORT_KEY, v)
  } catch { /* 忽略 */ }
})

const visibleBanks = computed(() =>
  sortAndFilterBanks(bankStore.banks, {
    sort: sort.value,
    query: query.value,
    customOrder: customOrder.value
  })
)

// 拖拽只在「自定义顺序 + 无搜索」时开放：搜索结果里拖拽无法确定落位语义
const dragEnabled = computed(() => canDragBanks({ sort: sort.value, query: query.value }))
const dragDisabledReason = computed(() => {
  if (sort.value !== 'custom') return '拖拽排序仅在「自定义顺序」下可用'
  if (query.value.trim()) return '搜索结果中不支持拖拽排序'
  return ''
})

const dragFrom = ref(-1)
function onDragStart(i, e) {
  if (!dragEnabled.value) return
  dragFrom.value = i
  // Firefox 必须 setData 才会启动拖拽；值本身不用（落位靠 dragFrom）
  try { e.dataTransfer?.setData('text/plain', String(i)) } catch { /* 忽略 */ }
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(i) {
  if (dragEnabled.value) dragFrom.value >= 0 && i >= 0
}

function onDrop(to) {
  if (!dragEnabled.value || dragFrom.value < 0) return
  // 以当前可见顺序为基础换位，再把完整 id 序列落回（含未显示的库，防丢库）
  const visibleIds = visibleBanks.value.map((b) => b.id)
  const reordered = moveId(visibleIds, dragFrom.value, to)
  dragFrom.value = -1
  if (!reordered) return
  // 合并：按新可见顺序重排全部题库（未显示的追加到末尾，由 applyIdOrder 保证）
  persistOrder(reordered.concat(bankStore.banks.map((b) => b.id).filter((id) => !reordered.includes(id))))
}

function onDragEnd() {
  dragFrom.value = -1
}

const totalCount = computed(() =>
  bankStore.banks.reduce((s, b) => s + (b.question_count ?? 0), 0)
)

function fmtDate(iso) {
  const s = String(iso || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : '—'
}

// ── 进入与快捷入口 ──
function onEnter(b) {
  router.push(`/library?bank=${b.id}`)
}

function goCreate(b) {
  router.push(`/create?bank=${b.id}`)
}

function goShortcut(b, s) {
  router.push(shortcutHref(s, b.id))
}

function openImport(b) {
  importBank.value = { id: b.id, name: b.name }
  showImport.value = true
}

async function onImportDone() {
  showImport.value = false
  await loadBanks()
}

// ── 复制题库（FE-P1-02）：新库 + 题目副本，不继承流水/复习态 ──
async function onDuplicate(b) {
  const name = await promptDialog({
    title: '复制题库',
    message: `将「${b.name}」连同全部题目复制为一个新题库（不复制作答记录与复习进度）。`,
    placeholder: '新题库名称',
    initial: `${b.name} 副本`
  })
  if (name == null) return
  try {
    const r = await duplicateBank(b.id, name)
    await loadBanks()
    const copied = r?.copied ?? 0
    toast(`已创建「${r?.bank?.name || name}」，共复制 ${copied} 题`, 'success')
  } catch (e) {
    console.error(e)
    toast('复制题库失败：' + (e?.message || e), 'error')
  }
}

// ── 导出单个题库为 Markdown（FE-P1-02）──
// 口径：导出的是「可再导入的题目文本（同导入模板格式）」，不是备份。
// 本地快照/备份能力待数据保全方案定案（PLAN §4/§9），这里不提供、也不叫备份。
const exporting = ref('')
async function onExport(b) {
  if (exporting.value) return
  exporting.value = b.id
  try {
    // 分页拉全库题（全量字段：导出需要题干/选项/答案/解析）
    const all = []
    let offset = 0
    for (;;) {
      const r = await list({ bankId: b.id, limit: 100, offset })
      const items = Array.isArray(r?.items) ? r.items : []
      all.push(...items)
      offset += items.length
      if (!items.length || offset >= Number(r?.total || 0)) break
    }
    const { text, count, skipped } = bankToMarkdown(b, all)
    const { path } = await exportBankMarkdown(exportFileName(b), text)
    const note = skipped ? `，${skipped} 题内容为空已跳过` : ''
    toast(`已导出「${b.name}」${count} 题${note}\n文件：${path}`, 'success', 6000)
  } catch (e) {
    console.error(e)
    toast('导出失败：' + (e?.message || e), 'error')
  } finally {
    exporting.value = ''
  }
}

// ── 新建 / 重命名弹窗 ──
const dlg = ref(null) // { mode: 'create'|'rename', id, name, description, saving }

// FE-P1-11：新建/重命名弹层共用一套弹层可访问性（Esc / Tab 圈 / 初始焦点 / 归位）
const dlgCardEl = ref(null)
useDialogA11y({
  isOpen: computed(() => !!dlg.value),
  containerRef: dlgCardEl,
  // 初始焦点落到名称输入框：这是用户打开这个弹层的唯一目的
  initialFocusRef: computed(() => dlgCardEl.value?.querySelector('#bank-dlg-name') || null),
  onClose: () => {
    // 保存中不允许 Esc 关掉（否则用户以为取消了但请求已发出）
    if (dlg.value?.saving) return
    dlg.value = null
  },
  escDisabled: () => !!dlg.value?.saving
})

function openCreate() {
  dlg.value = { mode: 'create', id: '', name: '', description: '', saving: false }
}

function openRename(b) {
  dlg.value = { mode: 'rename', id: b.id, name: b.name, description: b.description || '', saving: false, _origName: b.name, _origDesc: b.description || '' }
}

async function onDlgOk() {
  const d = dlg.value
  if (!d || d.saving) return
  const name = d.name.trim()
  if (!name) return
  const description = d.description.trim()
  d.saving = true
  try {
    if (d.mode === 'create') {
      await createBank(name, description)
      await loadBanks()
      toast(`题库「${name}」已创建，去卡片点录题开始加题`, 'success')
    } else {
      if (name === d._origName && description === (d._origDesc || '')) {
        dlg.value = null
        return
      }
      await updateBank(d.id, { name, description })
      await loadBanks()
      toast('题库已更新', 'success')
    }
    dlg.value = null
  } catch (e) {
    console.error(e)
    toast((d.mode === 'create' ? '新建题库失败：' : '更新失败：') + (e?.message || e), 'error')
    d.saving = false
  }
}

async function onRemoveBank(b) {
  if (bankStore.banks.length <= 1) {
    toast('至少保留一个题库', 'info')
    return
  }
  const ok = await confirmDialog({
    title: '删除题库',
    message: `确定删除题库「${b.name}」及其全部试题？此操作不可撤销。`,
    okText: '删除',
    danger: true
  })
  if (!ok) return
  try {
    await removeBank(b.id)
    await loadBanks()
    toast(`题库「${b.name}」已删除`, 'success')
  } catch (e) {
    console.error(e)
    toast('删除失败：' + (e?.message || e), 'error')
  }
}

onMounted(async () => {
  // 每次进入都刷新：新增/导入/删除试题后返回，题数徽章才对得上
  try {
    await loadBanks()
  } catch (e) {
    console.error(e)
    toast('加载题库失败：' + (e?.message || e), 'error')
  }
})
</script>

<style scoped>
/* 操作钮：悬停所在卡片/行时从淡到亮（触屏 35% 也够点） */
.bank-actions { opacity: .35; transition: opacity .15s ease; }
.bank-card:hover .bank-actions, .bank-card:focus-visible .bank-actions,
.bank-row:hover .bank-actions, .bank-row:focus-visible .bank-actions { opacity: 1; }
/* 弹窗入场（与 DialogHost 同语言） */
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
