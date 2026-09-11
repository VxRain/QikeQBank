/**
 * 题库管理页（/banks）
 * 每个题库一张卡：题数 / 当前标记 / 进入题库（试题列表）/ 设为当前 / 重命名 / 删除
 */
<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-library text-primary" />题库管理
        </h2>
        <span class="badge">{{ bankStore.banks.length }} 个题库 · 共 {{ totalCount }} 题</span>
      </div>

      <div class="flex gap-2.5 mb-4">
        <input
          v-model="newBankName"
          class="input flex-1 min-w-[180px]"
          type="text"
          placeholder="新题库名称，回车创建"
          :disabled="creating"
          @keyup.enter="onCreateBank"
        />
        <button type="button" class="btn btn-primary" :disabled="creating || !newBankName.trim()" @click="onCreateBank">
          <i class="i-lucide-plus" />{{ creating ? '创建中…' : '新建题库' }}
        </button>
      </div>

      <div v-if="!bankStore.loaded" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-loader-circle animate-spin" />正在加载题库…
      </div>

      <div v-else-if="bankStore.banks.length === 0" class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-folder-open" />暂无题库，请先在上方新建
      </div>

      <div v-else class="flex flex-col gap-2">
        <div
          v-for="b in bankStore.banks"
          :key="b.id"
          class="flex items-center justify-between gap-3 px-3.5 py-3 border border-line rounded-[12px] bg-bg-accent cursor-pointer transition-[background-color,border-color] duration-150 hover:bg-card hover:border-line-strong"
          :class="b.id === bankStore.currentBankId && 'border-primary-border bg-primary-bg hover:border-primary-border hover:bg-primary-bg'"
          @click="onSelectBank(b)"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <i class="i-lucide-folder text-[18px] shrink-0" :class="b.id === bankStore.currentBankId ? 'text-primary' : 'text-muted-light'" />
            <span class="font-600 text-[14px] text-text truncate">{{ b.name }}</span>
            <span class="text-[12px] text-muted whitespace-nowrap">{{ b.question_count ?? 0 }} 题</span>
            <span v-if="b.id === bankStore.currentBankId" class="badge badge-cur">当前</span>
          </div>
          <div class="flex gap-1.5 flex-wrap" @click.stop>
            <router-link :to="`/library?bank=${b.id}`" class="btn btn-small btn-primary-link">
              <i class="i-lucide-arrow-right" />进入题库
            </router-link>
            <button
              v-if="b.id !== bankStore.currentBankId"
              type="button"
              class="btn btn-small"
              @click="onSelectBank(b)"
            ><i class="i-lucide-check" />设为当前</button>
            <button type="button" class="btn btn-small" @click="onRenameBank(b)">
              <i class="i-lucide-pen-line" />重命名
            </button>
            <button type="button" class="btn btn-small btn-danger" @click="onRemoveBank(b)">
              <i class="i-lucide-trash-2" />删除
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { bankStore, loadBanks, setCurrentBank } from '@/stores/bank.js'
import { createBank, updateBank, removeBank } from '@/api/banks.js'
import { toast, confirmDialog, promptDialog } from '@/stores/ui.js'

const newBankName = ref('')
const creating = ref(false)

const totalCount = computed(() =>
  bankStore.banks.reduce((s, b) => s + (b.question_count ?? 0), 0)
)

function onSelectBank(b) {
  if (b.id === bankStore.currentBankId) return
  setCurrentBank(b.id)
}

async function onCreateBank() {
  const name = newBankName.value.trim()
  if (!name) return
  creating.value = true
  try {
    const created = await createBank(name)
    newBankName.value = ''
    await loadBanks()
    if (created?.id) setCurrentBank(created.id)
  } catch (e) {
    console.error(e)
    toast('新建题库失败：' + (e?.message || e), 'error')
  } finally {
    creating.value = false
  }
}

async function onRenameBank(b) {
  const name = await promptDialog({
    title: '重命名题库',
    message: `请输入「${b.name}」的新名称：`,
    initial: b.name,
    placeholder: '题库名称'
  })
  if (name == null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed === b.name) return
  try {
    await updateBank(b.id, { name: trimmed })
    await loadBanks()
    toast('题库已重命名', 'success')
  } catch (e) {
    console.error(e)
    toast('重命名失败：' + (e?.message || e), 'error')
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

