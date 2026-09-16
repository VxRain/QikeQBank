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
        <span v-if="isPortable" class="badge" title="数据存放在程序目录 data/ 下，随身携带">便携版</span>
        <span v-if="streak >= 2" class="badge" :title="`最近 ${streak} 天每天都有刷题`">
          <i class="i-lucide-flame text-[14px] text-danger" />连续学习 {{ streak }} 天
        </span>
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
        <button type="button" class="btn btn-small" @click="openOverview">
          <i class="i-lucide-table" />查看详情
        </button>
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

    <!-- 全部练习统计弹窗 -->
    <Teleport to="body">
      <Transition name="dg">
        <div v-if="showOverview" class="dg-mask fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="showOverview = false">
          <div class="dg-card w-[min(640px,calc(100vw-48px))] max-h-[calc(100vh-96px)] flex flex-col bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5 pb-4" role="dialog" aria-label="全部练习统计">
            <h3 class="m-0 mb-3.5 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)] flex items-center gap-2">
              <i class="i-lucide-table text-primary" />全部练习统计
            </h3>
            <div v-if="ovLoading" class="text-muted py-4 flex items-center gap-2">
              <i class="i-lucide-loader-circle animate-spin" />加载中…
            </div>
            <div v-else-if="ovError" class="error-box mb-3">{{ ovError }}</div>
            <div v-else class="overflow-y-auto flex flex-col gap-4 min-h-0 pr-0.5">
              <div v-if="!ovDays.length && !ovTypes.length" class="text-muted py-2">暂无练习记录</div>
              <div v-if="ovTypes.length">
                <div class="field-label">按题型</div>
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th class="text-left px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">题型</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">数量</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">正确率</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">平均用时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="t in ovTypes" :key="t.type" class="hover:bg-card-hover">
                      <td class="px-2.5 py-2 border-b border-line"><span class="badge badge-type">{{ typeLabel(t.type) }}</span></td>
                      <td class="px-2.5 py-2 border-b border-line text-right">{{ t.count }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right" :class="t.count && (t.correct / t.count) < 0.6 ? 'text-danger font-700' : 'text-success font-600'">{{ t.count ? Math.round((t.correct / t.count) * 100) + '%' : '—' }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-muted">{{ fmtSec(t.avg_ms) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="ovDays.length">
                <div class="field-label">按天（近 {{ ovDays.length }} 天有记录）</div>
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th class="text-left px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">日期</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">数量</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">答对</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">平均用时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in ovDays" :key="d.date" class="hover:bg-card-hover">
                      <td class="px-2.5 py-2 border-b border-line font-500">{{ d.date }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right">{{ d.count }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-success font-600">{{ d.correct }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-muted">{{ fmtSec(d.avg_ms) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="flex justify-end gap-2.5 mt-4">
              <button type="button" class="btn btn-primary" @click="showOverview = false">关闭</button>
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
import { stats as fetchStats, recordsOverview } from '@/api/practice.js'
import { cmd } from '@/api/bridge.js'

const router = useRouter()
function go(path) {
  router.push(path)
}

const TYPE_ORDER = ['single', 'multi', 'judge', 'fill', 'short', 'material']
const TYPE_LABELS = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '简答', material: '材料' }

const stats = ref(null)
const error = ref('')
const isPortable = ref(false)
const streak = ref(0)
const showOverview = ref(false)
const ovLoading = ref(false)
const ovError = ref('')
const ovDays = ref([])
const ovTypes = ref([])

function typeLabel(t) {
  return TYPE_LABELS[t] || t || '-'
}
function fmtSec(ms) {
  const s = Number(ms) / 1000
  if (!Number.isFinite(s) || s <= 0) return '—'
  return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's'
}
async function openOverview() {
  showOverview.value = true
  await ensureOverview()
}

// 概览只拉一次：详情按钮与 streak 共用
async function ensureOverview() {
  if (ovDays.value.length || ovTypes.value.length || ovLoading.value) return
  ovLoading.value = true
  ovError.value = ''
  try {
    const data = await recordsOverview()
    ovDays.value = Array.isArray(data?.days) ? data.days : []
    ovTypes.value = Array.isArray(data?.by_type) ? data.by_type : []
    streak.value = calcStreak(ovDays.value)
  } catch (e) {
    console.error(e)
    ovError.value = '加载失败：' + (e?.message || e)
  } finally {
    ovLoading.value = false
  }
}

// 连续学习天数：有刷题记录的连续本地日期串；今天还没学则从昨天起算
// （后端按 UTC 日期聚合，跨零点附近可能差 1 天，v1 接受该误差）
function calcStreak(days) {
  const active = new Set((days || []).filter((d) => Number(d.count) > 0).map((d) => d.date))
  if (!active.size) return 0
  const fmt = (dt) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  const cur = new Date()
  if (!active.has(fmt(cur))) cur.setDate(cur.getDate() - 1)
  let n = 0
  while (active.has(fmt(cur))) {
    n++
    cur.setDate(cur.getDate() - 1)
  }
  return n
}

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
  // 便携标记静默探测：失败就当非便携，不污染错误区
  try {
    const r = await cmd('is_portable_mode')
    isPortable.value = !!r?.data?.portable
  } catch { /* ignore */ }
  try {
    stats.value = await fetchStats()
  } catch (e) {
    console.error(e)
    stats.value = null
    error.value = '加载统计失败：' + (e?.message || e)
  }
  // streak 静默计算：失败就当 0 天，不污染错误区
  try {
    await ensureOverview()
  } catch { /* ignore */ }
}

onMounted(() => {
  load()
})
</script>

