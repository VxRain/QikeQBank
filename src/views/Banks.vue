/**
 * 题库管理页（/banks）
 * 卡片网格：点击卡片进入题库；右键菜单承载进入/重命名/删除；
 * 每张卡片自带录题/导入按钮，归属零歧义。
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

      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
        <div
          v-for="b in bankStore.banks"
          :key="b.id"
          role="button"
          tabindex="0"
          class="card card-interactive flex flex-col gap-2 cursor-pointer !p-4"
          :title="`进入「${b.name}」`"
          @click="onEnter(b)"
          @keyup.enter="onEnter(b)"
          @contextmenu.prevent="onCtxMenu($event, b)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <i class="i-lucide-folder text-[18px] shrink-0 text-muted-light" />
              <span class="font-700 text-[14px] text-text truncate">{{ b.name }}</span>
            </div>
          </div>
          <div v-if="b.description" class="text-[12px] text-muted leading-[1.6] line-clamp-2 min-h-[19px]">
            {{ b.description }}
          </div>
          <div class="flex items-center justify-between gap-2 mt-auto pt-1">
            <span class="text-[12px] text-muted-light">{{ b.question_count ?? 0 }} 题</span>
            <span class="inline-flex items-center gap-1.5">
              <button type="button" class="btn btn-tiny" title="录题到这个库" @click.stop="goCreate(b)"><i class="i-lucide-plus" />录题</button>
              <button type="button" class="btn btn-tiny" title="导入试题到这个库" @click.stop="openImport(b)"><i class="i-lucide-file-up" />导入</button>
              <span class="inline-flex items-center gap-1 text-[12px] font-500 text-primary">
                进入<i class="i-lucide-arrow-right text-[13px]" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单：应用内悬浮，非原生 -->
    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="ctx"
          class="fixed z-[900] w-[180px] bg-card border border-line rounded-[8px] shadow-lg p-1.5 flex flex-col gap-0.5"
          :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
          role="menu"
        >
          <button type="button" class="ctx-item" @click="onCtxEnter">
            <i class="i-lucide-arrow-right" />进入题库
          </button>
          <button type="button" class="ctx-item" @click="onCtxRename">
            <i class="i-lucide-pen-line" />重命名
          </button>
          <div class="h-px bg-[var(--line)] my-1" />
          <button type="button" class="ctx-item ctx-danger" @click="onCtxRemove">
            <i class="i-lucide-trash-2" />删除
          </button>
        </div>
      </Transition>
    </Teleport>

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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { bankStore, loadBanks } from '@/stores/bank.js'
import { createBank, updateBank, removeBank } from '@/api/banks.js'
import { toast, confirmDialog } from '@/stores/ui.js'
import ImportFileBox from '@/components/ImportFileBox.vue'

const router = useRouter()

// 导入弹窗：直接在此页打开，目标即所选库
const showImport = ref(false)
const importBank = ref({ id: '', name: '' })

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

// ── 右键菜单 ──
const ctx = ref(null) // { x, y, bank }

function onCtxMenu(e, b) {
  ctx.value = {
    x: Math.min(e.clientX, window.innerWidth - 196),
    y: Math.min(e.clientY, window.innerHeight - 190),
    bank: b
  }
  // 注意：关闭监听用冒泡（不能 capture），否则 window 先于菜单项按钮收到 click，
  // closeCtx 会抢先清空 ctx，导致菜单动作读不到 bank。scroll 不冒泡，保留 capture。
  window.addEventListener('click', closeCtx)
  window.addEventListener('keydown', onCtxKey)
  window.addEventListener('scroll', closeCtx, { capture: true })
}

function closeCtx() {
  if (!ctx.value) return
  ctx.value = null
  window.removeEventListener('click', closeCtx)
  window.removeEventListener('keydown', onCtxKey)
  window.removeEventListener('scroll', closeCtx, { capture: true })
}

function onCtxKey(e) {
  if (e.key === 'Escape') closeCtx()
}

function onCtxEnter() {
  const b = ctx.value?.bank
  closeCtx()
  if (b) onEnter(b)
}

function onCtxRename() {
  const b = ctx.value?.bank
  closeCtx()
  if (b) openRename(b)
}

function onCtxRemove() {
  const b = ctx.value?.bank
  closeCtx()
  if (b) onRemoveBank(b)
}

onUnmounted(closeCtx)

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
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
      toast('加载题库失败：' + (e?.message || e), 'error')
    }
  }
})
</script>

<style scoped>
/* 右键菜单项 */
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background-color .12s ease, color .12s ease;
}
.ctx-item:hover { background: var(--bg-accent); color: var(--text); }
.ctx-item.ctx-danger { color: var(--danger); }
.ctx-item.ctx-danger:hover { background: var(--danger-bg); color: var(--danger); }
/* 右键菜单入场 */
.ctx-enter-active, .ctx-leave-active { transition: opacity .12s ease, transform .12s ease; }
.ctx-enter-from, .ctx-leave-to { opacity: 0; transform: scale(.96) translateY(-2px); }
/* 弹窗入场（与 DialogHost 同语言） */
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
