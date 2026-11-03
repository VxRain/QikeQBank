#!/usr/bin/env node
/**
 * 前端渲染性能实测（FE-P1-12）
 *
 * 为什么要有这个脚本：FE-P1-12 的验收是「大列表滚动不卡」与「多图题目首次渲染
 * 不卡住输入」。这两条若只写「手测通过」，既不可复现也不能证伪。这里用与 e2e
 * 同一套 mock IPC + Playwright 真实 Chromium 跑出**数字**，并把「虚拟滚动做不做」
 * 这个结论建立在数字上，而不是根据「感觉还行」。
 *
 * 用法：
 *   node tools/perf-render.mjs           # 打印指标表
 *   node tools/perf-render.mjs --json    # 输出 JSON（便于贴进文档 / 前后对比）
 *
 * 指标口径：
 * - 列表：单页 100 行（页大小上限）滚动 20 屏的长任务数与总时长
 * - 预览：20 图题目 renderDoc 的同步耗时（首帧成本）
 * - 余量：合成 500 行单页的布局耗时 —— 这是「要不要上虚拟滚动」的判据
 * - 公式：10 个 mathBlock 的 KaTeX 排版耗时（渲染里最贵的一块）
 *
 * 判据：长任务（>50ms）越少越好；单次滚动若出现 >100ms 长任务即视为掉帧。
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
  if (await httpOk(BASE)) {
    console.log(`复用已在运行的 dev server：${BASE}`)
    return { stop() {} }
  }
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

/**
 * 直接复用 tools/e2e/mock.js 的 mockScript —— 同一套数据形状，避免两处漂移。
 *
 * 为什么不用读源码文本拼字符串（旧版做法）：mockScript 现在是一个真正的模块导出，
 * 直接 import 比「截取函数源码再 eval」稳得多，文件位置变了也不会悄悄失效。
 */
async function loadMockScript() {
  const mod = await import('file://' + path.join(ROOT, 'tools/e2e/mock.js').replace(/\\/g, '/'))
  return mod.mockScript
}

async function main() {
  const { chromium } = await loadPlaywright()
  const mockScript = await loadMockScript()
  const server = await ensureServer()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const result = {}

  try {
    await page.addInitScript(mockScript)

    // ── 1) 列表：100 行/页的滚动长任务 ──
    await page.goto(`${BASE}/#/banks`)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__setCount(500))
    await page.evaluate(() => { location.hash = '#/library?bank=bank_default' })
    await page.waitForFunction(() => /第 1 \/ \d+ 页/.test(document.body.innerText), null, { timeout: 15000 })

    // 页大小切到上限 100
    await page.locator('select').filter({ hasText: /条\/页/ }).first().selectOption('100')
    await page.waitForTimeout(500)

    result.list = await page.evaluate(async () => {
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

    // ── 2) 预览：20 图题目的 renderDoc 同步耗时 ──
    result.preview = await page.evaluate(async () => {
      const { renderDoc } = await import('/src/utils/render.js')
      const imageBlock = (i) => ({
        type: 'imageBlock',
        attrs: { src: `https://example.invalid/img${i}.png`, caption: `图 ${i}`, width: 600 }
      })
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

    // ── 3) 余量：合成 500 行单页的布局成本（虚拟滚动的判据）──
    // 目的不是「测 500 题列表」（当前分页上限就是 500/页 但 UI 只到 100），
    // 而是给「要不要上虚拟滚动」一个有数字的判据：500 行仍无长任务 → 不值得加。
    result.headroom = await page.evaluate(async () => {
      const sampleRow = document.querySelector('tbody tr')
      if (!sampleRow) return { skipped: 'no rows' }
      const host = document.createElement('div')
      const table = document.createElement('table')
      const tbody = document.createElement('tbody')
      tbody.innerHTML = sampleRow.outerHTML.repeat(500)
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
      // 强制布局：读最后一行的几何信息，这一步才是真正要量的成本
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

    // ── 4) KaTeX：公式题面（渲染里最贵的一块）──
    result.math = await page.evaluate(async () => {
      const { renderDoc } = await import('/src/utils/render.js')
      const content = []
      for (let i = 0; i < 10; i++) {
        content.push({
          type: 'mathBlock',
          attrs: { latex: '\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' }
        })
      }
      const t0 = performance.now()
      renderDoc({ type: 'doc', content })
      return { formulas: 10, ms: Math.round((performance.now() - t0) * 10) / 10 }
    })
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

  // 硬门槛：出现掉帧就以非 0 退出，让 CI / 门禁能拦住性能回归
  const fatal = []
  if (result.list.longTaskMaxMs > 100) fatal.push(`列表滚动出现 ${result.list.longTaskMaxMs}ms 长任务（>100ms 视为掉帧）`)
  if (result.headroom && !result.headroom.skipped && result.headroom.frameMs > 200)
    fatal.push(`500 行合成首帧 ${result.headroom.frameMs}ms（>200ms 说明该考虑虚拟滚动了）`)
  if (fatal.length) {
    console.error('✗ 性能门槛未通过：')
    for (const f of fatal) console.error(`  · ${f}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
