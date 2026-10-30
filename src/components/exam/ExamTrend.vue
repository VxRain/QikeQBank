<template>
  <!-- 模考成绩趋势（FE-P0-07b）：纯 SVG 自绘，不引入图表库 -->
  <div class="flex flex-col gap-2">
    <div class="flex items-baseline justify-between gap-3">
      <div class="text-[13px] font-600 text-muted">最近 {{ sessions.length }} 次得分率</div>
      <div
        v-if="summary"
        class="text-[12px] font-500 flex items-center gap-1"
        :class="{
          'text-success': summary.direction === 'up',
          'text-danger': summary.direction === 'down',
          'text-muted': summary.direction === 'flat'
        }"
      >
        <i :class="summary.direction === 'up' ? 'i-lucide-trending-up' : summary.direction === 'down' ? 'i-lucide-trending-down' : 'i-lucide-minus'" />
        {{ summary.label }}
      </div>
    </div>

    <svg
      v-if="trend"
      :viewBox="`0 0 ${trend.width} ${trend.height}`"
      class="w-full h-auto block"
      role="img"
      :aria-label="`最近 ${trend.points.length} 次模考得分率折线`"
    >
      <!-- 网格与刻度 -->
      <g>
        <line
          v-for="g in trend.gridLines"
          :key="g.rate"
          :x1="PAD.padL"
          :x2="trend.width - PAD.padR"
          :y1="g.y"
          :y2="g.y"
          stroke="var(--line)"
          stroke-width="1"
          :stroke-dasharray="g.rate === 0 ? '0' : '3 3'"
        />
        <text
          v-for="g in trend.gridLines"
          :key="'t' + g.rate"
          :x="PAD.padL - 6"
          :y="g.y + 3.5"
          text-anchor="end"
          font-size="9"
          fill="var(--muted-light)"
        >{{ g.rate }}%</text>
      </g>

      <!-- 面积 + 折线 -->
      <path :d="trend.areaPath" fill="var(--primary-bg)" opacity="0.7" />
      <path :d="trend.path" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

      <!-- 数据点 -->
      <g v-for="p in trend.points" :key="p.examId">
        <circle :cx="p.x" :cy="p.y" r="3.2" fill="var(--card)" stroke="var(--primary)" stroke-width="2" />
      </g>

      <!-- 首尾标注 -->
      <text
        :x="trend.points[0].x"
        :y="trend.height - 6"
        text-anchor="start"
        font-size="9"
        fill="var(--muted-light)"
      >{{ shortDate(trend.points[0].startedAt) }}</text>
      <text
        v-if="trend.points.length > 1"
        :x="trend.points[trend.points.length - 1].x"
        :y="trend.height - 6"
        text-anchor="end"
        font-size="9"
        fill="var(--muted-light)"
      >{{ shortDate(trend.points[trend.points.length - 1].startedAt) }}</text>
    </svg>

    <div v-else class="text-[12px] text-muted-light py-3 text-center">
      还没有模考记录，考完一轮就能看到趋势
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { buildTrend, trendSummary, CHART } from '@/utils/examTrend.js'

const props = defineProps({
  /** exam_sessions 的 items（任意顺序，内部按时间升序画） */
  sessions: { type: Array, default: () => [] }
})

const PAD = CHART
const trend = computed(() => buildTrend(props.sessions))
const summary = computed(() => (props.sessions.length >= 2 ? trendSummary(props.sessions) : null))

function shortDate(iso) {
  if (!iso) return ''
  return String(iso).slice(5, 10) // MM-DD
}
</script>
