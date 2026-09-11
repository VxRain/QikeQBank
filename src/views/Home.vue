/**
 * 仪表盘（/）
 * 统计区：即使 stats 接口失败也始终渲染占位（数字 0/— + 内联错误 + 重试），绝不吞掉整页。
 * 题库区：当前题库速览 + 入口；管理在 /banks 专页。
 */
<template>
  <div class="page">
    <div class="flex items-center justify-between gap-3">
      <h1 class="page-title flex items-center gap-2">
        <i class="i-lucide-layout-dashboard text-primary text-[24px]" />仪表盘
      </h1>
      <button type="button" class="btn btn-small" @click="load">
        <i class="i-lucide-refresh-cw text-[14px]" />刷新
      </button>
    </div>

    <div v-if="error" class="error-box">
      <span class="flex items-center gap-2 min-w-0">
        <i class="i-lucide-triangle-alert shrink-0" />{{ error }}
      </span>
      <button type="button" class="btn btn-small shrink-0" @click="load">重试</button>
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3.5">
      <div class="card flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats?.total ?? '—' }}</div>
          <i class="i-lucide-library text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">题库总题数</div>
      </div>
      <div class="card flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-primary">{{ stats?.due_total ?? '—' }}</div>
          <i class="i-lucide-clock text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">待复习总数</div>
        <div class="text-[12px] text-muted-light">今日到期 {{ stats?.due_today ?? '—' }}</div>
      </div>
      <div class="card flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats?.practiced_total ?? '—' }}</div>
          <i class="i-lucide-zap text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">累计刷题</div>
        <div class="text-[12px] text-muted-light">今日 {{ stats?.practiced_today ?? '—' }}</div>
      </div>
      <div class="card flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats ? rateText : '—' }}</div>
          <i class="i-lucide-trophy text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">总正确率</div>
        <div class="text-[12px] text-muted-light">练习 + 复习</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-sigma text-primary" />题型分布
        </h2>
      </div>
      <div class="flex flex-wrap gap-2">
        <span v-for="t in TYPE_ORDER" :key="t" class="badge badge-type">
          {{ TYPE_LABELS[t] }} {{ stats?.by_type?.[t] ?? 0 }}
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-bar-chart-3 text-primary" />近 7 天练习趋势
        </h2>
      </div>
      <div v-if="bars.length" class="flex items-end gap-2.5 pt-1.5">
        <div
          v-for="b in bars"
          :key="b.date"
          class="flex-1 flex flex-col items-center justify-end gap-1 min-w-0"
          :title="`${b.date} 刷题 ${b.count}，正确 ${b.correct}`"
        >
          <div class="w-full max-w-[46px] h-[120px] flex items-end bg-bg-accent border border-line rounded-[8px] p-[3px] shadow-sm">
            <div class="relative w-full bg-primary-bg rounded-[6px] min-h-[2px] overflow-hidden" :style="{ height: b.pct + '%' }">
              <div class="absolute left-0 right-0 bottom-0 bg-primary rounded-[6px]" :style="{ height: b.correctPct + '%' }"></div>
            </div>
          </div>
          <div class="text-[12px] font-700 text-text-secondary">{{ b.count }}</div>
          <div class="text-[11px] text-muted-light whitespace-nowrap">{{ b.dateLabel }}</div>
        </div>
      </div>
      <div v-else class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-bar-chart-3" />近 7 天暂无练习记录
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-book-open text-primary" />当前题库
        </h2>
        <router-link to="/banks" class="btn btn-small">管理题库</router-link>
      </div>
      <div v-if="currentBank" class="flex items-center gap-2.5 min-w-0">
        <span class="font-600 text-[14px] text-text truncate">{{ currentBank.name }}</span>
        <span class="text-[12px] text-muted whitespace-nowrap">{{ currentBank.question_count ?? 0 }} 题</span>
        <span class="badge badge-cur">当前</span>
      </div>
      <div v-else class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-folder" />
        {{ bankStore.loaded ? '暂无题库' : '正在加载题库…' }}
        <router-link to="/banks" class="ml-2">去创建</router-link>
      </div>
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
      <router-link to="/practice" class="card card-interactive flex flex-col gap-1.5 no-underline text-text">
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-zap text-primary" />开始刷题
        </div>
        <div class="text-[12px] text-muted">随机抽题 · 逐题判分</div>
      </router-link>
      <router-link to="/review" class="card card-interactive flex flex-col gap-1.5 no-underline text-text">
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-repeat text-primary" />开始复习
        </div>
        <div class="text-[12px] text-muted">待复习 {{ stats?.due_total ?? 0 }} 题 · 今日 {{ stats?.due_today ?? 0 }} 题</div>
      </router-link>
      <router-link to="/banks" class="card card-interactive flex flex-col gap-1.5 no-underline text-text">
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-folder text-primary" />题库管理
        </div>
        <div class="text-[12px] text-muted">新建 / 重命名 / 删除题库</div>
      </router-link>
      <router-link to="/library" class="card card-interactive flex flex-col gap-1.5 no-underline text-text">
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-file-text text-primary" />浏览试题
        </div>
        <div class="text-[12px] text-muted">按题库查看 / 编辑 / 删除试题</div>
      </router-link>
      <router-link
        v-if="currentBank"
        :to="`/create?bank=${currentBank.id}`"
        class="card card-interactive flex flex-col gap-1.5 no-underline text-text"
      >
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-plus text-primary" />在「{{ currentBank.name }}」新增
        </div>
        <div class="text-[12px] text-muted">创建并保存到当前题库</div>
      </router-link>
      <router-link v-else to="/banks" class="card card-interactive flex flex-col gap-1.5 no-underline text-text">
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-plus text-primary" />新增试题
        </div>
        <div class="text-[12px] text-muted">请先创建题库</div>
      </router-link>
      <button
        type="button"
        class="card card-interactive flex flex-col gap-1.5 cursor-pointer text-left w-full text-text"
        @click="onImport"
      >
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-upload text-primary" />导入数据
        </div>
        <div class="text-[12px] text-muted">导入 DB JSON 备份 / 历史题库</div>
      </button>
      <button
        type="button"
        class="card card-interactive border-dashed flex flex-col gap-1.5 cursor-pointer text-left w-full text-text"
        @click="onExport"
      >
        <div class="flex items-center gap-2 text-[16px] font-700 text-text">
          <i class="i-lucide-download text-primary" />导出数据
        </div>
        <div class="text-[12px] text-muted">导出 DB JSON 备份文件</div>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { stats as fetchStats, exportData, importData } from '@/api/practice.js'
import { bankStore, loadBanks } from '@/stores/bank.js'
import { toast, promptDialog } from '@/stores/ui.js'

const TYPE_ORDER = ['single', 'multi', 'judge', 'fill', 'short', 'material']
const TYPE_LABELS = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '简答', material: '材料' }

const stats = ref(null)
const error = ref('')

const currentBank = computed(() =>
  bankStore.banks.find((b) => b.id === bankStore.currentBankId) || bankStore.banks[0] || null
)

const rateText = computed(() => {
  const r = stats.value?.correct_rate
  return r == null ? '—' : `${r}%`
})

const bars = computed(() => {
  const list = Array.isArray(stats.value?.records_7d) ? stats.value.records_7d : []
  const rows = list.map((d) => ({
    date: d.date || '',
    count: Number(d.count) || 0,
    correct: Number(d.correct) || 0
  }))
  const max = Math.max(1, ...rows.map((r) => r.count))
  return rows.map((r) => ({
    date: r.date,
    count: r.count,
    correct: r.correct,
    pct: Math.max(2, Math.round((r.count / max) * 100)),
    correctPct: r.count > 0 ? Math.round((r.correct / r.count) * 100) : 0,
    dateLabel: String(r.date || '').slice(5).replace('-', '/') || '-'
  }))
})

async function load() {
  error.value = ''
  try {
    stats.value = await fetchStats()
  } catch (e) {
    console.error(e)
    stats.value = null
    error.value = '加载统计失败：' + (e?.message || e)
  }
}

async function onExport() {
  try {
    const res = await exportData()
    toast('已导出：' + (res?.path || '未知路径'), 'success', 6000)
  } catch (e) {
    console.error(e)
    toast('导出失败：' + (e?.message || e), 'error')
  }
}

async function onImport() {
  const p = await promptDialog({
    title: '导入数据',
    message: '请输入 DB JSON 文件路径（v2/v3 或历史 DB.json）：',
    placeholder: 'C:/path/to/DB.json'
  })
  if (p == null) return
  try {
    const res = await importData(p)
    toast(`导入成功：${res?.imported ?? 0} 道题，${res?.banks_imported ?? 0} 个题库`, 'success')
    await Promise.allSettled([loadBanks(), load()])
  } catch (e) {
    console.error(e)
    toast('导入失败：' + (e?.message || e), 'error', 5000)
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
  load()
})
</script>

