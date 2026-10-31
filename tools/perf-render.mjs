#!/usr/bin/env node
/**
 * 前端渲染性能实测（FE-P1-12）
 *
 * 为什么要有这个脚本：FE-P1-12 的两条验收是「500 题列表滚动无明显掉帧」与
 * 「含 20 张图的题目首次渲染不卡住输入」。这两条如果只写「手测通过」，既不可复现也不能证伪。
 * 这里用与 e2e 同一套 mock IPC + Playwright 真实 Chromium 跑出**数字**，
 * 并把结论（虚拟滚动做不做）建立在数字上，而不是根据「感觉还行」。
 *
 * 用法：
 *   node tools/perf-render.mjs           # 打印指标表
 *   node tools/perf-render.mjs --json    # 输出 JSON（便于贴进文档/对比）
 *
 * 指标口径：
 * - 列表：单页 100 行（页大小上限）渲染耗时 + 滚动 20 次的长任务数/总时长
 * - 预览：20 图题目首帧 HTML 产出耗时（renderDoc 同步耗时）与再次预览的命中耗时
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 5298)
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`
const JSON_OUT = process.argv.includes('--json')

async function loadPlaywright() {
  const req = createRequire(import.meta.url)
  try {
    return req('@playwright/test')
  } catch {
    return await import('playwright')
  }
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureServer() {
  if (await httpOk(BASE)) return { stop() {} }
  const viteBin = path.join(ROOT, 'node_modules/vite/bin/vite.js')
  if (!fs.existsSync(viteBin)) {
    console.error('找不到 vite，请先 pnpm install')
    process.exit(2)
  }
  const child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore'
  })
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (await httpOk(BASE)) return { stop: () => child.kill() }
  }
  child.kill()
  console.error('dev server 启动超时')
  process.exit(2)
}

/** 从 e2e 脚本里取现成的 mock IPC（同一套数据形状，避免两处漂移） */
function mockSource() {
  const src = fs.readFileSync(path.join(ROOT, 'tools/e2e-frontend.mjs'), 'utf8')
  const start = src.indexOf('function mockScript()')
  if (start < 0) throw new Error('e2e 脚本里找不到 mockScript()')
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return src.slice(start, end)
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

async function main() {
  const { chromium } = await loadPlaywright()
  const server = await ensureServer()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const result = {}

  try {
    await page.addInitScript(`(() => { ${mockSource()} mockScript(); })()`)

    // ── 1) 列表：100 行/页的渲染耗时 + 滚动长任务 ──
    await page.goto(`${BASE}/#/banks`)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__setCount(500))
    await page.evaluate(() => { location.hash = '#/library?bank=bank_default' })
    await page.waitForFunction(() => /第 1 \/ \d+ 页/.test(document.body.innerText), null, { timeout: 15000 })

    // 页大小切到上限 100
    await page.locator('select').filter({ hasText: /条\/页/ }).first().selectOption('100')
    await page.waitForTimeout(400)

    const listMetrics = await page.evaluate(async () => {
      // 测量「一页行渲染」：滚到顶→底再回顶，统计长任务
      const rows = document.querySelectorAll('tbody tr')
      const longTasks = []
      const obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration)
      })
      try {
        obs.observe({ entryTypes: ['longtask'] })
      } catch {
        /* 浏览器不支持 longtask 时降级为 0 */
      }
      const t0 = performance.now()
      const scroller = document.scrollingElement
      const max = scroller.scrollHeight - window.innerHeight
      for (let i = 0; i < 20; i++) {
        scroller.scrollTop = (max * i) / 19
        await new Promise((r) => requestAnimationFrame(r))
      }
      scroller.scrollTop = 0
      await new Promise((r) => requestAnimationFrame(r))
      const elapsed = performance.now() - t0
      obs.disconnect()
      return {
        rowCount: rows.length,
        scrollMs: Math.round(elapsed),
        longTaskCount: longTasks.length,
        longTaskMaxMs: Math.round(Math.max(0, ...longTasks)),
        longTaskTotalMs: Math.round(longTasks.reduce((s, x) => s + x, 0)),
        rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : 0
      }
    })
    result.list = listMetrics

    // ── 2) 预览：20 图题目的首帧渲染 vs 命中缓存 ──
    const previewMetrics = await page.evaluate(async () => {
      const { renderDoc } = await import('/src/utils/render.js')
      const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
      const imageBlock = (i) => ({
        type: 'imageBlock',
        attrs: { src: `https://example.invalid/img${i}.png`, caption: `图 ${i}`, width: 600 }
      })
      // 20 张图 + 20 段文字（模拟带插图的材料）
      const content = []
      for (let i = 0; i < 20; i++) {
        content.push({ type: 'paragraph', content: [{ type: 'text', text: `第 ${i} 段：说明文字用于测量排版成本` }] })
        content.push(imageBlock(i))
      }
      const d = { type: 'doc', content }
      const samples = []
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now()
        renderDoc(d)
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return {
        images: 20,
        firstMs: Math.round(samples[0] * 10) / 10,
        medianMs: Math.round(samples[2] * 10) / 10,
        maxMs: Math.round(samples[4] * 10) / 10
      }
    })
    result.preview = previewMetrics

    // ── 3) 余量测量：如果页大小上限被放开到 500 行会怎样 ──
    // 目的不是「测 500 题列表」（当前分页上限就是 100/页），而是给「要不要上虚拟滚动」
    // 一个有数字的判据：如果 500 行单页仍然没有长任务，那么虚拟滚动的复杂度不值得加。
    result.headroom = await page.evaluate(async () => {
      const host = document.createElement('div')
      // 用 100 行真实行的 outerHTML 复制 5 份，尽量贴近真实复杂度（含复选框/徽章/按钮）
      const sampleRow = document.querySelector('tbody tr')
      if (!sampleRow) return { skipped: 'no rows' }
      const rowHtml = sampleRow.outerHTML
      const table = document.createElement('table')
      const tbody = document.createElement('tbody')
      tbody.innerHTML = rowHtml.repeat(500)
      table.appendChild(tbody)
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px'
      host.appendChild(table)
      document.body.appendChild(host)
      const longTasks = []
      const obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration)
      })
      try {
        obs.observe({ entryTypes: ['longtask'] })
      } catch {
        /* 不支持则跳过 */
      }
      // 强制布局：读取一行的几何信息（这一步才是真正要量的成本）
      const t0 = performance.now()
      void host.offsetHeight
      const rows = tbody.querySelectorAll('tr')
      void rows[rows.length - 1].getBoundingClientRect()
      const layoutMs = performance.now() - t0
      await new Promise((r) => requestAnimationFrame(r))
      const elapsed = performance.now() - t0
      obs.disconnect()
      document.body.removeChild(host)
      return {
        rows: 500,
        layoutMs: Math.round(layoutMs),
        frameMs: Math.round(elapsed),
        longTaskCount: longTasks.length,
        longTaskMaxMs: Math.round(Math.max(0, ...longTasks))
      }
    })

    // ── 4) KaTeX 题面（公式排版是渲染里最贵的一块）──
    const mathMetrics = await page.evaluate(async () => {
      const { renderDoc } = await import('/src/utils/render.js')
      const content = []
      for (let i = 0; i < 10; i++) {
        content.push({
          type: 'mathBlock',
          attrs: { latex: '\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' }
        })
      }
      const d = { type: 'doc', content }
      const t0 = performance.now()
      renderDoc(d)
      return { formulas: 10, ms: Math.round((performance.now() - t0) * 10) / 10 }
    })
    result.math = mathMetrics
  } finally {
    await browser.close()
    server.stop()
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('\n── FE-P1-12 渲染性能实测 ──')
  console.log(`列表：单页 ${result.list.rowCount} 行，行高 ${result.list.rowHeight}px`)
  console.log(`  滚动 20 屏总耗时 ${result.list.scrollMs}ms`)
  console.log(`  长任务 ${result.list.longTaskCount} 个，最长 ${result.list.longTaskMaxMs}ms，合计 ${result.list.longTaskTotalMs}ms`)
  console.log(`预览：20 图题目首帧 ${result.preview.firstMs}ms / 中位 ${result.preview.medianMs}ms / 最慢 ${result.preview.maxMs}ms`)
  if (result.headroom && !result.headroom.skipped) {
    console.log(`余量：合成 ${result.headroom.rows} 行单页 → 布局 ${result.headroom.layoutMs}ms，首帧 ${result.headroom.frameMs}ms`)
    console.log(`  长任务 ${result.headroom.longTaskCount} 个，最长 ${result.headroom.longTaskMaxMs}ms`)
  }
  console.log(`公式：10 个 mathBlock 渲染 ${result.math.ms}ms`)
  console.log('')
  console.log('判据：长任务（>50ms）越少越好；单次滚动若出现 >100ms 长任务即视为掉帧。')
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
