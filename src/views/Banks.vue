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

      <!--
        搜索 + 排序（FE-P1-02）：题库数 >3 才出现。
        两个题库时搜索框只是噪音（一眼看全），三个已开始需要扫视，四个起才真需要找。
      -->
      <div v-if="bankStore.loaded && showSearchSort" class="flex items-center gap-2.5 flex-wrap mb-3.5">
        <div class="relative flex-1 min-w-[200px] max-w-[320px]">
          <i class="i-lucide-search absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-light text-[14px]" aria-hidden="true" />
          <input
            v-model="query"
            type="search"
            class="input w-full !pl-8 text-[13px]"
            placeholder="搜索题库名称或描述…"
            aria-label="搜索题库"
          />
        </div>
        <select v-model="sort" class="select w-[150px] text-[13px]" aria-label="排序方式" @change="onSortChange">
          <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <span v-if="query.trim()" class="text-[12px] text-muted">
          找到 {{ visibleBanks.length }} / {{ bankStore.banks.length }} 个
        </span>
        <!-- 拖拽状态说明：不可拖时给原因，而不是让用户白拖一次 -->
        <span v-if="!dragEnabled" class="text-[12px] text-muted-light flex items-center gap-1">
          <i class="i-lucide-info text-[13px]" aria-hidden="true" />{{ dragDisabledReason }}
        </span>
        <span v-else class="text-[12px] text-muted-light flex items-center gap-1">
          <i class="i-lucide-grip-vertical text-[13px]" aria-hidden="true" />拖动卡片可调整顺序
        </span>
      </div>

      <div v-if="!bankStore.loaded" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />正在加载题库…
      </div>
      <!-- 搜索无结果：与「一个题库都没有」区分开，否则用户以为数据丢了 -->
      <div v-else-if="showSearchSort && visibleBanks.length === 0" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-search-x" />没有匹配「{{ query }}」的题库
        <button type="button" class="btn btn-tiny ml-1" @click="query = ''">清除搜索</button>
      </div>

      <div v-else-if="bankStore.banks.length === 0" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-folder-open" />暂无题库，点击右上新建
      </div>

      <!-- 列表视图：每行一库，信息与操作横向铺开，密度高于卡片 -->
      <div v-else-if="view === 'list'" class="flex flex-col gap-2">
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
          <!-- 拖拽手柄：仅自定义顺序且未搜索时出现，明确「这里可以拖」 -->
          <i v-if="dragEnabled" class="i-lucide-grip-vertical text-[15px] shrink-0 text-muted-light cursor-grab" aria-hidden="true" />
          <i class="i-lucide-folder text-[19px] shrink-0 text-muted-light" />
          <div class="flex items-center gap-2.5 min-w-0 w-[240px] shrink-0">
            <span class="font-700 text-[14px] text-text truncate">{{ b.name }}</span>
          </div>
          <p class="m-0 flex-1 min-w-0 text-[12px] text-muted leading-[1.6] truncate">
            {{ b.description || ' ' }}
          </p>
          <span class="text-[12px] text-muted-light shrink-0 tabular-nums">{{ b.question_count ?? 0 }} 题</span>
          <span class="bank-actions flex items-center gap-1 shrink-0">
            <button type="button" class="btn btn-tiny !px-2" title="录入试题到这个库" @click.stop="goCreate(b)"><i class="i-lucide-plus" /></button>
            <button type="button" class="btn btn-tiny !px-2" title="从文件导入到这个库" @click.stop="openImport(b)"><i class="i-lucide-file-up" /></button>
            <button type="button" class="btn btn-tiny !px-2" title="重命名 / 修改描述" @click.stop="openRename(b)"><i class="i-lucide-pen-line" /></button>
            <button type="button" class="btn btn-tiny btn-danger !px-2" title="删除题库" @click.stop="onRemoveBank(b)"><i class="i-lucide-trash-2" /></button>
          </span>
        </div>
      </div>

      <!-- 卡片视图：固定三列，描述两行固定高保持等高 -->
      <div v-else class="grid grid-cols-3 gap-3.5">
        <div
          v-for="(b, i) in visibleBanks"
          :key="b.id"
          role="button"
          tabindex="0"
          :draggable="dragEnabled"
          class="bank-card card card-interactive flex flex-col cursor-pointer !p-4 !pt-4.5"
          :class="[dragEnabled && 'bank-draggable', dragOver === i && dragEnabled && 'bank-drag-over']"
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
              <i v-if="dragEnabled" class="i-lucide-grip-vertical text-[15px] shrink-0 text-muted-light cursor-grab" aria-hidden="true" />
              <i class="i-lucide-folder text-[18px] shrink-0 text-muted-light" />
              <span class="font-700 text-[14px] text-text truncate">{{ b.name }}</span>
            </div>
            <span class="text-[12px] text-muted-light shrink-0 pt-0.5">{{ b.question_count ?? 0 }} 题</span>
          </div>
          <p class="m-0 text-[12px] text-muted leading-[1.7] line-clamp-2 min-h-[44px] py-1">
            {{ b.description }}
          </p>
          <!-- 操作行：与卡片主体用分隔线隔开；四钮带文字均分，悬停卡片浮现 -->
          <div class="bank-actions grid grid-cols-4 gap-1.5 mt-auto pt-3 border-t border-line">
            <button type="button" class="btn btn-tiny justify-center min-w-0" title="录入试题到这个库" @click.stop="goCreate(b)"><i class="i-lucide-plus shrink-0" /><span class="truncate">录题</span></button>
            <button type="button" class="btn btn-tiny justify-center min-w-0" title="从文件导入到这个库" @click.stop="openImport(b)"><i class="i-lucide-file-up shrink-0" /><span class="truncate">导入</span></button>
            <button type="button" class="btn btn-tiny justify-center min-w-0" title="重命名 / 修改描述" @click.stop="openRename(b)"><i class="i-lucide-pen-line shrink-0" /><span class="truncate">编辑</span></button>
            <button type="button" class="btn btn-tiny btn-danger justify-center min-w-0" title="删除题库" @click.stop="onRemoveBank(b)"><i class="i-lucide-trash-2 shrink-0" /><span class="truncate">删除</span></button>
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
          <div class="dg-card w-[min(420px,calc(100vw-48px))] bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5" role="dialog" :aria-label="dlg.mode === 'create' ? '新建题库' : '重命名题库'">
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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { bankStore, loadBanks } from '@/stores/bank.js'
import { createBank, updateBank, removeBank } from '@/api/banks.ts'
import { toast, confirmDialog } from '@/stores/ui.js'
import ImportFileBox from '@/components/ImportFileBox.vue'
import {
  BANK_SORT_OPTIONS,
  DEFAULT_BANK_SORT,
  shouldShowSearchSort,
  sortAndFilterBanks,
  canDragBanks,
  reorderIds,
  loadCustomOrder,
  saveCustomOrder,
  loadBankSort,
  saveBankSort
} from '@/stores/banksView.js'

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

const totalCount = computed(() =>
  bankStore.banks.reduce((s, b) => s + (b.question_count ?? 0), 0)
)

// ── 搜索 / 排序 / 拖拽（FE-P1-02）──
// 纯逻辑全在 stores/banksView.js（35 条单测），这里只做接线与持久化。
const sortOptions = BANK_SORT_OPTIONS
const query = ref('')
const sort = ref(loadBankSort())
const customOrder = ref(loadCustomOrder())
const dragFrom = ref(-1)
const dragOver = ref(-1)

/** 题库数 >3 才显示搜索与排序控件 */
const showSearchSort = computed(() => shouldShowSearchSort(bankStore.banks.length))

/** 搜索 + 排序后的可见列表（模板里两处 v-for 都用它） */
const visibleBanks = computed(() =>
  sortAndFilterBanks(bankStore.banks, {
    sort: sort.value,
    query: query.value,
    customOrder: customOrder.value
  })
)

/** 拖拽仅在「自定义顺序 + 无搜索」时开放 */
const dragEnabled = computed(() => canDragBanks({ sort: sort.value, query: query.value }))

/** 不可拖时给出具体原因，而不是让用户白拖一次 */
const dragDisabledReason = computed(() => {
  if (query.value.trim()) return '搜索结果中不可拖动，清除搜索后可调整顺序'
  return '切换到「自定义顺序」后可拖动调整'
})

function onSortChange() {
  saveBankSort(sort.value)
  // 切走自定义顺序时清掉落位高亮，避免残留
  dragFrom.value = -1
  dragOver.value = -1
}

function onDragStart(i, e) {
  if (!dragEnabled.value) return
  dragFrom.value = i
  // Firefox 要求设置 dataTransfer 才会开始拖拽
  try {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
  } catch { /* 忽略 */ }
}

function onDragOver(i) {
  if (!dragEnabled.value) return
  dragOver.value = i
}

function onDragEnd() {
  dragFrom.value = -1
  dragOver.value = -1
}

function onDrop(i) {
  if (!dragEnabled.value) return onDragEnd()
  const ids = reorderIds(
    { banks: bankStore.banks, sort: sort.value, query: query.value, customOrder: customOrder.value },
    dragFrom.value,
    i
  )
  onDragEnd()
  if (!ids) return
  customOrder.value = ids
  saveCustomOrder(ids)
}

// ── 进入 ──
function onEnter(b) {
  router.push(`/library?bank=${b.id}`)
}

function goCreate(b) {
  router.push(`/create?bank=${b.id}`)
}

function openImport(b) {
  importBank.value = { id: b.id, name: b.name }
  showImport.value = true
}

async function onImportDone() {
  showImport.value = false
  await loadBanks()
}

// ── 新建 / 重命名弹窗 ──
const dlg = ref(null) // { mode: 'create'|'rename', id, name, description, saving }

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
/* 拖拽（FE-P1-02）：可拖时给出抓取光标，落点高亮用主色淡底 + 虚线边 */
.bank-draggable { cursor: grab; }
.bank-draggable:active { cursor: grabbing; }
.bank-drag-over { border-color: var(--primary-border) !important; background: var(--primary-bg) !important; }
/* 拖拽中的源卡片半透明，明确「它正在被移动」 */
.bank-draggable[draggable="true"]:active { opacity: .6; }

/* 弹窗入场（与 DialogHost 同语言） */
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
