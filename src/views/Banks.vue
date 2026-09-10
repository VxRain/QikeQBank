/**
 * 题库管理页（/banks）
 * 每个题库一张卡：题数 / 当前标记 / 进入题库（试题列表）/ 设为当前 / 重命名 / 删除
 */
<template>
  <div class="page">
    <div class="card">
      <div class="card-head">
        <h2>题库管理</h2>
        <span class="badge">{{ bankStore.banks.length }} 个题库 · 共 {{ totalCount }} 题</span>
      </div>

      <div class="bank-create">
        <input
          v-model="newBankName"
          class="input"
          type="text"
          placeholder="新题库名称，回车创建"
          :disabled="creating"
          @keyup.enter="onCreateBank"
        />
        <button type="button" class="btn" :disabled="creating || !newBankName.trim()" @click="onCreateBank">
          {{ creating ? '创建中…' : '新建题库' }}
        </button>
      </div>

      <div v-if="!bankStore.loaded" class="muted pad">正在加载题库…</div>

      <div v-else-if="bankStore.banks.length === 0" class="muted pad">暂无题库，请先在上方新建</div>

      <div v-else class="bank-list">
        <div
          v-for="b in bankStore.banks"
          :key="b.id"
          class="bank-row"
          :class="{ current: b.id === bankStore.currentBankId }"
          @click="onSelectBank(b)"
        >
          <div class="bank-info">
            <span class="bank-name">{{ b.name }}</span>
            <span class="bank-count">{{ b.question_count ?? 0 }} 题</span>
            <span v-if="b.id === bankStore.currentBankId" class="badge cur">当前</span>
          </div>
          <div class="bank-actions" @click.stop>
            <router-link :to="`/library?bank=${b.id}`" class="btn small primary-link">进入题库</router-link>
            <button
              v-if="b.id !== bankStore.currentBankId"
              type="button"
              class="btn small"
              @click="onSelectBank(b)"
            >设为当前</button>
            <button type="button" class="btn small" @click="onRenameBank(b)">重命名</button>
            <button type="button" class="btn small danger" @click="onRemoveBank(b)">删除</button>
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

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius-lg); padding: 20px;
  box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.card-head h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.badge {
  display: inline-block; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); background: var(--bg-accent); font-weight: 500;
}
.badge.cur { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }
.muted { color: var(--muted); }
.pad { padding: 8px 0; }

.bank-create { display: flex; gap: 10px; margin-bottom: 16px; }
.input {
  padding: 9px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); font-size: 14px;
  outline: none; transition: all .15s ease; box-shadow: var(--shadow-sm);
}
.input { flex: 1; min-width: 180px; }
.input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }

.bank-list { display: flex; flex-direction: column; gap: 8px; }
.bank-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--bg-accent); cursor: pointer; transition: all .15s ease;
}
.bank-row:hover { border-color: var(--line-strong); background: var(--card); }
.bank-row.current { border-color: var(--primary-border); background: var(--primary-bg); }
.bank-row.current:hover { border-color: var(--primary-border); background: var(--primary-bg); }
.bank-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
.bank-name { font-weight: 600; font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bank-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
.bank-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.btn {
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text-secondary); cursor: pointer;
  font-size: 13px; font-weight: 500;
  transition: all .15s ease; box-shadow: var(--shadow-sm);
  text-decoration: none !important; display: inline-flex; align-items: center;
}
.btn:hover { background: var(--bg-accent); border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow); }
.btn.small { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
.btn.danger { border-color: #fecaca; color: var(--danger); background: #fff; }
.btn.danger:hover { background: var(--danger-bg); border-color: #fca5a5; }
.btn.primary-link { color: var(--primary); border-color: var(--primary-border); background: #fff; }
.btn.primary-link:hover { background: var(--primary-bg); }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
</style>
