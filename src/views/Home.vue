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
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入试题列表" @click="go('/library')" @keyup.enter="go('/library')">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats?.total ?? '—' }}</div>
          <i class="i-lucide-library text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">题库总题数</div>
      </div>
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入间隔复习" @click="go('/review')" @keyup.enter="go('/review')">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-primary">{{ stats?.due_total ?? '—' }}</div>
          <i class="i-lucide-clock text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">待复习总数</div>
        <div class="text-[12px] text-muted-light">今日到期 {{ stats?.due_today ?? '—' }}</div>
      </div>
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入刷题" @click="go('/practice')" @keyup.enter="go('/practice')">
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

    <div v-if="(stats?.due_total ?? 0) > 0" class="card flex flex-wrap items-center gap-3 !border-primary-border !bg-primary-bg">
      <i class="i-lucide-repeat text-primary text-[20px]" />
      <span class="text-[14px] text-text font-500">有 <b class="text-primary text-[17px]">{{ stats.due_total }}</b> 题待复习，别让遗忘曲线得逞</span>
      <span class="flex gap-2 ml-auto">
        <button type="button" class="btn btn-primary" @click="go('/review')"><i class="i-lucide-play" />开始复习</button>
        <button type="button" class="btn" @click="go('/practice')"><i class="i-lucide-zap" />去刷题</button>
      </span>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { stats as fetchStats } from '@/api/practice.js'
import { toast } from '@/stores/ui.js'

const router = useRouter()
function go(path) {
  router.push(path)
}

const TYPE_ORDER = ['single', 'multi', 'judge', 'fill', 'short', 'material']
const TYPE_LABELS = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '简答', material: '材料' }

const stats = ref(null)
const error = ref('')

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

onMounted(() => {
  load()
})
</script>

