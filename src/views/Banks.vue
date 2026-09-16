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
            <button type="button" class="btn !rounded-none !border-0 !shadow-none !py-1.5 !px-2.5" :class="view === 'grid' ? '!bg-primary-bg !text-primary' : ''" title="卡片视图" @click="setView('grid')"><i class="i-lucide-layout-grid text-[15px]" /></button>
            <button type="button" class="btn !rounded-none !border-0 !shadow-none !py-1.5 !px-2.5" :class="view === 'list' ? '!bg-primary-bg !text-primary' : ''" title="列表视图" @click="setView('list')"><i class="i-lucide-list text-[15px]" /></button>
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

      <!-- 列表视图：每行一库，信息与操作横向铺开，密度高于卡片 -->
      <div v-else-if="view === 'list'" class="flex flex-col gap-2">
        <div
          v-for="b in bankStore.banks"
          :key="b.id"
          role="button"
          tabindex="0"
          class="bank-row card card-interactive flex items-center gap-4 cursor-pointer !px-4 !py-3"
          :title="`进入「${b.name}」`"
          @click="onEnter(b)"
          @keyup.enter="onEnter(b)"
        >
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
          v-for="b in bankStore.banks"
          :key="b.id"
          role="button"
          tabindex="0"
          class="bank-card card card-interactive flex flex-col cursor-pointer !p-4 !pt-4.5"
          :title="`进入「${b.name}」`"
          @click="onEnter(b)"
          @keyup.enter="onEnter(b)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
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
import { createBank, updateBank, removeBank } from '@/api/banks.js'
import { toast, confirmDialog } from '@/stores/ui.js'
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

const totalCount = computed(() =>
  bankStore.banks.reduce((s, b) => s + (b.question_count ?? 0), 0)
)

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
/* 弹窗入场（与 DialogHost 同语言） */
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
