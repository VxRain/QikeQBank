/**
 * 仪表盘（/）
 * 统计区：即使 stats 接口失败也始终渲染占位（数字 0/— + 内联错误 + 重试），绝不吞掉整页。
 * 题库区：当前题库速览 + 入口；管理在 /banks 专页。
 */
<template>
  <div class="page">
    <div class="head">
      <h1>仪表盘</h1>
      <button type="button" class="btn small" @click="load">刷新</button>
    </div>

    <div v-if="error" class="error">
      {{ error }}
      <button type="button" class="btn small retry" @click="load">重试</button>
    </div>

    <div class="stat-grid">
      <div class="card stat">
        <div class="num">{{ stats?.total ?? '—' }}</div>
        <div class="lbl">题库总题数</div>
      </div>
      <div class="card stat">
        <div class="num review-num">{{ stats?.due_total ?? '—' }}</div>
        <div class="lbl">待复习总数</div>
        <div class="sub">今日到期 {{ stats?.due_today ?? '—' }}</div>
      </div>
      <div class="card stat">
        <div class="num">{{ stats?.practiced_total ?? '—' }}</div>
        <div class="lbl">累计刷题</div>
        <div class="sub">今日 {{ stats?.practiced_today ?? '—' }}</div>
      </div>
      <div class="card stat">
        <div class="num">{{ stats ? rateText : '—' }}</div>
        <div class="lbl">总正确率</div>
        <div class="sub">练习 + 复习</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>题型分布</h2></div>
      <div class="type-chips">
        <span v-for="t in TYPE_ORDER" :key="t" class="badge type">
          {{ TYPE_LABELS[t] }} {{ stats?.by_type?.[t] ?? 0 }}
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>近 7 天练习趋势</h2></div>
      <div v-if="bars.length" class="chart">
        <div v-for="b in bars" :key="b.date" class="bar-col" :title="`${b.date} 刷题 ${b.count}，正确 ${b.correct}`">
          <div class="bar-track">
            <div class="bar" :style="{ height: b.pct + '%' }">
              <div class="bar-correct" :style="{ height: b.correctPct + '%' }"></div>
            </div>
          </div>
          <div class="bar-count">{{ b.count }}</div>
          <div class="bar-date">{{ b.dateLabel }}</div>
        </div>
      </div>
      <div v-else class="muted pad">近 7 天暂无练习记录</div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>当前题库</h2>
        <router-link to="/banks" class="btn small">管理题库</router-link>
      </div>
      <div v-if="currentBank" class="cur-bank">
        <span class="bank-name">{{ currentBank.name }}</span>
        <span class="bank-count">{{ currentBank.question_count ?? 0 }} 题</span>
        <span class="badge cur">当前</span>
      </div>
      <div v-else class="muted pad">
        {{ bankStore.loaded ? '暂无题库' : '正在加载题库…' }}
        <router-link to="/banks" class="go-bank">去创建</router-link>
      </div>
    </div>

    <div class="entry-grid">
      <router-link to="/practice" class="card entry">
        <div class="entry-title">开始刷题</div>
        <div class="entry-desc">随机抽题 · 逐题判分</div>
      </router-link>
      <router-link to="/review" class="card entry">
        <div class="entry-title">开始复习</div>
        <div class="entry-desc">待复习 {{ stats?.due_total ?? 0 }} 题 · 今日 {{ stats?.due_today ?? 0 }} 题</div>
      </router-link>
      <router-link to="/banks" class="card entry">
        <div class="entry-title">题库管理</div>
        <div class="entry-desc">新建 / 重命名 / 删除题库</div>
      </router-link>
      <router-link to="/library" class="card entry">
        <div class="entry-title">浏览试题</div>
        <div class="entry-desc">按题库查看 / 编辑 / 删除试题</div>
      </router-link>
      <router-link v-if="currentBank" :to="`/create?bank=${currentBank.id}`" class="card entry">
        <div class="entry-title">在「{{ currentBank.name }}」新增</div>
        <div class="entry-desc">创建并保存到当前题库</div>
      </router-link>
      <router-link v-else to="/banks" class="card entry">
        <div class="entry-title">新增试题</div>
        <div class="entry-desc">请先创建题库</div>
      </router-link>
      <button type="button" class="card entry" @click="onImport">
        <div class="entry-title">导入数据</div>
        <div class="entry-desc">导入 DB JSON 备份 / 历史题库</div>
      </button>
      <button type="button" class="card entry export" @click="onExport">
        <div class="entry-title">导出数据</div>
        <div class="entry-desc">导出 DB JSON 备份文件</div>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { stats as fetchStats, exportData, importData } from '@/api/practice.js'
import { bankStore, loadBanks } from '@/stores/bank.js'

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
    alert('导出成功：' + (res?.path || '未知路径'))
  } catch (e) {
    console.error(e)
    alert('导出失败：' + (e?.message || e))
  }
}

async function onImport() {
  const p = prompt('请输入 DB JSON 文件路径（如 C:/path/to/DB.json）')
  if (p == null || !p.trim()) return
  try {
    const res = await importData(p.trim())
    alert(`导入成功：${res?.imported ?? 0} 道题，${res?.banks_imported ?? 0} 个题库`)
    await Promise.allSettled([loadBanks(), load()])
  } catch (e) {
    console.error(e)
    alert('导入失败：' + (e?.message || e))
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

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.error {
  color: #b91c1c; background: var(--danger-bg); border: 1px solid #fecaca;
  padding: 12px; border-radius: 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.retry { flex-shrink: 0; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius-lg); padding: 20px; box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.card-head h2 { margin: 0; font-size: 16px; font-weight: 700; }
.muted { color: var(--muted); }
.pad { padding: 8px 0; }

.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat .num { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
.stat .num.review-num { color: var(--primary); }
.stat .lbl { font-size: 13px; color: var(--muted); font-weight: 500; }
.stat .sub { font-size: 12px; color: var(--muted-light); }

.type-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.badge {
  display: inline-block; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); background: var(--bg-accent); font-weight: 500;
}
.badge.type { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }
.badge.cur { color: var(--primary); border-color: var(--primary-border); background: #fff; }

.cur-bank { display: flex; align-items: center; gap: 10px; }
.bank-name { font-weight: 600; font-size: 14px; color: var(--text); }
.bank-count { font-size: 12px; color: var(--muted); }
.go-bank { margin-left: 8px; }

.chart { display: flex; gap: 10px; align-items: flex-end; padding-top: 6px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
.bar-track { width: 100%; max-width: 46px; height: 120px; display: flex; align-items: flex-end; background: var(--bg-accent); border: 1px solid var(--line); border-radius: 8px; padding: 3px; box-shadow: var(--shadow-sm); }
.bar { position: relative; width: 100%; background: var(--primary-bg); border-radius: 6px; min-height: 2px; overflow: hidden; }
.bar-correct { position: absolute; left: 0; right: 0; bottom: 0; background: var(--primary); border-radius: 6px; }
.bar-count { font-size: 12px; font-weight: 700; color: var(--text-secondary); }
.bar-date { font-size: 11px; color: var(--muted-light); white-space: nowrap; }

.entry-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.entry {
  display: flex; flex-direction: column; gap: 6px;
  text-decoration: none !important; color: var(--text);
  transition: all .15s ease; cursor: pointer; text-align: left; font: inherit;
}
.entry:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); border-color: var(--primary-border); background: var(--card); }
.entry-title { font-size: 16px; font-weight: 700; color: var(--text); }
.entry-desc { font-size: 12px; color: var(--muted); }
.entry.export { border-style: dashed; }

.btn {
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text-secondary); cursor: pointer;
  font-size: 13px; font-weight: 500;
  transition: all .15s ease; box-shadow: var(--shadow-sm);
  text-decoration: none !important; display: inline-flex; align-items: center;
}
.btn:hover { background: var(--bg-accent); border-color: var(--line-strong); }
.btn.small { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
</style>
