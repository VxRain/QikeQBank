/**
 * E2E mock IPC（window.__TAURI_INTERNALS__.invoke）
 *
 * 注入的是「后端形状」的假实现：命令名、参数、返回信封都与 src-tauri 一致，
 * 且 questions_list 真的把筛选/排序/分页算一遍 —— 否则「参数下发了但后端没生效」
 * 这类缺陷在 e2e 里永远走不到（只能看请求发出去，看不到结果对不对）。
 *
 * 契约：mock 覆盖的命令集必须与 src-tauri 的 #[tauri::command] 对齐，由
 * tools/e2e/mock-coverage.mjs 在跑 e2e 前校验（缺失/多余/重叠都报错），
 * 单测见 tests/unit/e2e-mock-coverage.test.js。
 *
 * 就绪信号：window.__inflight 由本文件维护（try/finally 保证异常也归零），
 * 是 helpers.js 里 flush() / requireRoute() 判定「首屏数据到齐」的唯一依据。
 */
export function mockScript() {
  const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
  const bank = { id: 'bank_default', name: '默认题库', description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  // 第二个题库：错题本统计条要按库分组，需要一个真实可解析的库名
  const bank2 = { id: 'bank_b', name: '第二题库', description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  const mk = (i, t) => ({
    id: 'q' + i, bank_id: 'bank_default', type: t || 'single', version: 2,
    // 难度/状态各不同，供 FE-P0-09 的筛选与排序验证（q1..q3 难度 1..3，q4.. 循环）
    difficulty: ((i - 1) % 5) + 1,
    score: 5,
    status: i % 3 === 0 ? 'draft' : 'published', stem: doc('第' + i + '题'),
    options: [{ id: 'o1', content: doc('A') }, { id: 'o2', content: doc('B') }],
    answer: { ids: ['o1'] }, analysis: doc('解析' + i), plain_text: '第' + i + '题',
    created_at: '2026-01-01T00:00:00.000Z',
    // created_at 递增，让 created_asc/desc 排序结果确定可断言
    updated_at: '2026-01-0' + (1 + (i % 9)) + 'T00:00:00.000Z',
    fsrs: { due_at: '2026-01-01T00:00:00.000Z', stability: 2.5, difficulty: 5, reps: 2, lapses: 0, state: 2, learning_steps: 0, scheduled_days: 3, last_reviewed_at: '2026-01-01T00:00:00.000Z', last_result: 'good' }
  })
  const freshQs = (n = 10) => Array.from({ length: n }, (_, k) => {
    const q = mk(k + 1)
    q.created_at = `2026-01-${String(k + 1).padStart(2, '0')}T00:00:00.000Z`
    return q
  })
  const qs = freshQs()
  // 批量删除会真的从 qs 里 splice 掉行；后续用例还要用满 10 题，故留一个复位口
  window.__restoreQs = () => { qs.length = 0; qs.push(...freshQs()) }
  // 可调题量：验「删掉末页最后一题后页码收敛」需要真的造出第 2 页
  window.__setCount = (n) => { qs.length = 0; qs.push(...freshQs(n)) }
  const sessions = [
    { exam_id: 'e1', started_at: '2026-09-01T10:00:00.000Z', ended_at: '2026-09-01T10:20:00.000Z', item_count: 3, correct_count: 1, score: 5, full_score: 15 },
    { exam_id: 'e2', started_at: '2026-09-05T10:00:00.000Z', ended_at: '2026-09-05T10:20:00.000Z', item_count: 3, correct_count: 2, score: 10, full_score: 15 }
  ]
  const detail = {
    exam_id: 'e2', item_count: 2, score: 5, full_score: 10, items: [
      {
        record_id: 'r1', question_id: 'q1', grade: 'good', correct: 1,
        answered_at: '2026-09-05T10:01:00.000Z', elapsed_ms: 4200,
        detail: { selected: ['o2'], score_earned: 5, full_score: 5, exam_seq: 1 },
        question: { id: 'q1', type: 'single', stem: doc('第一题题面'), answer: { ids: ['o1'] }, analysis: doc('第一题解析'), score: 5, options: [{ id: 'o1' }, { id: 'o2' }] }
      },
      {
        // 材料子题：流水挂在母题 id 上，题面/选项/答案在 children 里
        record_id: 'r3', question_id: 'qm', grade: 'good', correct: 1,
        answered_at: '2026-09-05T10:03:00.000Z', elapsed_ms: 5000,
        detail: { selected: ['o2'], score_earned: 4, full_score: 4, exam_seq: 3, child_id: 'c2', child_index: 2, parent_id: 'qm' },
        question: {
          id: 'qm', type: 'material', stem: doc('材料母题题面'), answer: {}, analysis: null, score: 8, options: null,
          children: [
            { id: 'c1', type: 'single', stem: doc('子题一题面'), answer: { ids: ['o1'] }, analysis: doc('子题一解析'), score: 4, options: [{ id: 'o1' }, { id: 'o2' }] },
            { id: 'c2', type: 'single', stem: doc('子题二题面'), answer: { ids: ['o1'] }, analysis: doc('子题二解析'), score: 4, options: [{ id: 'o1' }, { id: 'o2' }] }
          ]
        }
      },
      {
        // 简答题：正确答案在 answer.reference（富文本），不在 ids/blanks
        record_id: 'r4', question_id: 'qs', grade: 'again', correct: 0,
        answered_at: '2026-09-05T10:04:00.000Z', elapsed_ms: 9000,
        detail: { my_answer: '我写的答案ABC', self_grade: '不会', score_earned: 0, full_score: 10, exam_seq: 4 },
        question: { id: 'qs', type: 'short', stem: doc('简答题题干'), answer: { reference: doc('标准参考答案XYZ') }, analysis: null, score: 10, options: null }
      },
      {
        // 答错行：必须展示「正确答案：A」，且作答仍显示字母
        record_id: 'r2', question_id: 'q2', grade: 'again', correct: 0,
        answered_at: '2026-09-05T10:02:00.000Z', elapsed_ms: 3000,
        detail: { selected: ['o2'], score_earned: 0, full_score: 5, exam_seq: 2 },
        question: { id: 'q2', type: 'judge', stem: doc('第二题题面'), answer: { ids: ['o1'] }, analysis: null, score: 5, options: [{ id: 'o1' }, { id: 'o2' }] }
      }
    ]
  }
  window.__calls = []
  // P2 就绪信号：在飞的 IPC 数量。7 个视图的 onMounted 都经 bridge.js 发 IPC，
  // 因此「归零」等价于「首屏数据到齐」。零 src/ 改动。
  window.__inflight = 0
  window.__recorded = []
  window.__reverted = []
  window.__creates = 0
  window.__stats = { total: 10, by_type: { single: 10, multi: 0, judge: 0, fill: 0, short: 0, material: 0 }, due_total: 5, due_today: 5, learning_due: 1, practiced_total: 0, practiced_today: 0, correct_rate: null, records_7d: [] }
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__inflight++
      try {
      window.__calls.push(cmd)
      switch (cmd) {
        case 'banks_list': return { success: true, data: window.__forceSingleBank ? [bank] : [bank, bank2] }
        case 'questions_list': {
          // 真实实现一遍筛选/排序/分页，E2E 才能验「参数真的生效」而不是只看请求发出去了
          window.__listArgs = args
          // summary: true 的返回口径：后端只挑摘要字段，不含 options/analysis 富文本。
          // 这里如实模拟 —— 否则「用摘要渲染题面」这类真实缺陷在 e2e 里永远走不到。
          if (args?.summary) {
            window.__summaryAsked = (window.__summaryAsked || 0) + 1
          }
          let items = qs.slice()
          if (args?.query) items = items.filter((q) => String(q.plain_text).includes(args.query))
          if (args?.typeFilter) items = items.filter((q) => q.type === args.typeFilter)
          if (args?.difficulty != null) items = items.filter((q) => q.difficulty === args.difficulty)
          if (args?.status) items = items.filter((q) => q.status === args.status)
          const by = {
            created_desc: (a, b) => (a.created_at < b.created_at ? 1 : -1),
            created_asc: (a, b) => (a.created_at > b.created_at ? 1 : -1),
            updated_desc: (a, b) => (a.updated_at < b.updated_at ? 1 : -1),
            difficulty_desc: (a, b) => b.difficulty - a.difficulty,
            difficulty_asc: (a, b) => a.difficulty - b.difficulty,
            score_desc: (a, b) => (b.score || 0) - (a.score || 0)
          }
          items.sort(by[args?.sort] || by.created_desc)
          const total = items.length
          const limit = args?.limit ?? 50
          const offset = args?.offset ?? 0
          const slice = items.slice(offset, offset + limit)
          if (args?.summary) {
            const SUMMARY_FIELDS = ['id', 'bank_id', 'type', 'difficulty', 'score', 'status', 'plain_text', 'created_at', 'updated_at', 'fsrs', 'wrong_count']
            // FE-P1-04：stats:true 时每行附统计，形状照 src-tauri 的 attach_question_stats ——
            // 没做过的题也给零值（不是缺字段），否则前端两种空态分不开。
            // q1/q3 有作答记录、其余没做过，让 e2e 能同时验「有数据」与「零值」两种展示。
            window.__statsAsked = args?.stats ? (window.__statsAsked || 0) + 1 : window.__statsAsked
            window.__statsIds = args?.stats ? slice.map((q) => q.id) : window.__statsIds
            const STATS = {
              q1: { attempt_count: 3, correct_count: 2, last_answered_at: '2026-01-05T10:00:00.000Z', avg_ms: 4200 },
              q3: { attempt_count: 1, correct_count: 0, last_answered_at: '2026-01-06T10:00:00.000Z', avg_ms: 9000 }
            }
            return {
              success: true,
              data: {
                total,
                items: slice.map((q) => {
                  const out = {}
                  for (const k of SUMMARY_FIELDS) if (q[k] !== undefined) out[k] = q[k]
                  if (args?.stats) {
                    out.stats = STATS[q.id] || { attempt_count: 0, correct_count: 0, last_answered_at: null, avg_ms: 0 }
                  }
                  return out
                })
              }
            }
          }
          return { success: true, data: { total, items: slice } }
        }
        case 'questions_remove': window.__removes = (window.__removes || 0) + 1; return { success: true, data: { id: args?.id } }
        case 'questions_batch_update': {
          // 计数调用次数：E2E 用它证明「50 题只 1 次 IPC」
          window.__batchUpdateCalls = (window.__batchUpdateCalls || 0) + 1
          window.__lastBatchUpdate = args
          const patch = args?.patch || {}
          if (patch.stem !== undefined) throw '不支持批量修改字段：stem'
          const failed = []
          let updated = 0
          for (const id of args?.ids || []) {
            if (window.__batchFailIds?.includes(id)) { failed.push({ id, reason: '题目不存在' }); continue }
            const q = qs.find((x) => x.id === id)
            if (!q) { failed.push({ id, reason: '题目不存在' }); continue }
            if (patch.bank_id !== undefined) q.bank_id = patch.bank_id
            if (patch.difficulty !== undefined) q.difficulty = patch.difficulty
            if (patch.status !== undefined) q.status = patch.status
            updated++
          }
          return { success: true, data: { updated, failed } }
        }
        case 'questions_batch_remove': {
          window.__batchRemoveCalls = (window.__batchRemoveCalls || 0) + 1
          window.__lastBatchRemove = args
          const failed = []
          let removed = 0
          for (const id of args?.ids || []) {
            if (window.__batchFailIds?.includes(id)) { failed.push({ id, reason: '题目不存在' }); continue }
            const i = qs.findIndex((x) => x.id === id)
            if (i < 0) { failed.push({ id, reason: '题目不存在' }); continue }
            qs.splice(i, 1)
            removed++
          }
          return { success: true, data: { removed, failed } }
        }
        case 'questions_get': {
          // 按 id 返回全量 —— 搜索面板「展开」依赖它取回 summary 里没有的 stem/options
          window.__getCalls = (window.__getCalls || []).concat(args?.id)
          const full = qs.find((q) => q.id === args?.id) || qs[0]
          return { success: true, data: full }
        }
        case 'questions_create': window.__creates++; window.__lastCreate = args; return { success: true, data: { id: 'qNew' } }
        case 'questions_update': window.__lastUpdate = args; return { success: true, data: {} }
        case 'practice_pool': return { success: true, data: args && args.ids ? args.ids.map((id) => qs.find((q) => q.id === id)).filter(Boolean) : qs }
        case 'review_due': return { success: true, data: qs.slice(0, window.__reviewOnly ? 1 : 5) }
        case 'record_answer': window.__recorded.push(args); return { success: true, data: { inserted: 1, skipped: 0 } }
        case 'review_revert': window.__reverted.push(args); return { success: true, data: { reverted: 1, skipped: 0 } }
        case 'exam_sessions': return { success: true, data: { items: sessions } }
        case 'exam_detail': window.__detailArg = args; return { success: true, data: detail }
        case 'assets_resolve': return { success: true, data: {} }
        case 'wrong_list': {
          window.__wrongArgs = args
          // 构造错题集：q1..q6，错次数 1,4,3,2,5,1；不同类型/题库
          const wrong = [
            { id: 'q1', n: 1, at: '2026-09-01T10:00:00.000Z', type: 'single', bank: 'bank_default' },
            { id: 'q2', n: 4, at: '2026-09-02T10:00:00.000Z', type: 'multi', bank: 'bank_default' },
            { id: 'q3', n: 3, at: '2026-09-03T10:00:00.000Z', type: 'single', bank: 'bank_b' },
            { id: 'q4', n: 2, at: '2026-09-04T10:00:00.000Z', type: 'judge', bank: 'bank_b' },
            { id: 'q5', n: 5, at: '2026-09-05T10:00:00.000Z', type: 'single', bank: 'bank_default' },
            { id: 'q6', n: 1, at: '2026-09-06T10:00:00.000Z', type: 'material', bank: 'bank_default' }
          ]
          let items = wrong.map((w) => {
            const base = qs.find((q) => q.id === w.id) || mk(Number(w.id.slice(1)))
            return {
              ...base, id: w.id, type: w.type, bank_id: w.bank, wrong_count: w.n,
              last_wrong_at: w.at, plain_text: w.id + '题干关键词',
              // 材料题带子题，验「重练整题（含 N 问）」文案
              children: w.type === 'material'
                ? [{ id: 'c1', type: 'single', score: 2, stem: doc('子一') }, { id: 'c2', type: 'single', score: 2, stem: doc('子二') }]
                : undefined
            }
          })
          if (args?.query) items = items.filter((q) => q.plain_text.includes(args.query))
          if (args?.typeFilter) items = items.filter((q) => q.type === args.typeFilter)
          if (args?.bankId) items = items.filter((q) => q.bank_id === args.bankId)
          if (args?.minWrongCount > 1) items = items.filter((q) => q.wrong_count >= args.minWrongCount)
          const cmp = {
            last_wrong_desc: (a, b) => (a.last_wrong_at < b.last_wrong_at ? 1 : -1),
            last_wrong_asc: (a, b) => (a.last_wrong_at > b.last_wrong_at ? 1 : -1),
            wrong_count_desc: (a, b) => b.wrong_count - a.wrong_count,
            wrong_count_asc: (a, b) => a.wrong_count - b.wrong_count
          }
          items.sort(cmp[args?.sort] || cmp.last_wrong_desc)
          return { success: true, data: { total: items.length, items } }
        }
        case 'wrong_stats': {
          window.__wrongStatsCalls = (window.__wrongStatsCalls || 0) + 1
          if (window.__wrongStatsFail) throw 'stats down'
          // 全库口径：固定值，不随筛选变化
          return {
            success: true,
            data: { total: 6, stubborn: 3, by_bank: { bank_default: 4, bank_b: 2 }, by_type: { single: 3, multi: 1, judge: 1, material: 1 } }
          }
        }
        case 'wrong_dismiss': return { success: true, data: { id: args?.questionId } }
        case 'records_overview': return { success: true, data: { total_practiced: 0, today_practiced: 0, correct_rate: null } }
        case 'is_portable_mode': return { success: true, data: false }
        case 'banks_create': window.__lastBankCreate = args; return { success: true, data: { id: 'bank_new', name: args?.name } }
        case 'banks_update': return { success: true, data: { id: args?.id } }
        case 'banks_remove': return { success: true, data: { id: args?.id } }
        case 'settings_set': return { success: true, data: {} }
        case 'settings_get': return { success: true, data: [] }

        // ── 文件类（C2）─────────────────────────────────────────
        // 形状照 src-tauri/src/db/backup.rs 真实返回写，不是随手编的：
        //   open_*_dir → { path }
        // （export_dbjson / import_dbjson / save_text_file 已随 FE-P0-01 移除）
        case 'open_templates_dir': return { success: true, data: { path: '/mock/export' } }
        case 'open_data_dir': return { success: true, data: { path: '/mock/data' } }

        // ── 资产（C2）──────────────────────────────────────────────────
        // putAsset 要求必须返回 sha，否则前端自己 throw（见 src/api/assets.js:22），
        // 所以这里给一个合法的 64 位 sha，别用占位符。
        case 'assets_put': return { success: true, data: { sha: 'a'.repeat(64), path: '/mock/assets/aa/' + 'a'.repeat(64) } }
        case 'assets_gc': return { success: true, data: { removed: 0, freed_bytes: 0, total: 0, scanned: 0, dangling: 0 } }

        // ── 云同步（C2）────────────────────────────────────────────────
        // e2e 里 autoSyncEnabled 默认 false（settings_get 返回 [] → settings.settings.autoSyncEnabled
        // 默认 false，见 src/stores/settings.js:101），且 STARTUP_DELAY_MS=60s，
        // 所以 7 个模块（均 < 4s）不会自动触发同步。
        // 这些 mock 是为「将来加同步用例」准备的，形状照 src-tauri/src/db/sync.rs。
        case 'sync_pull': return { success: true, data: { full_resync_required: false, tombstone_floor: null, server_time: '2026-01-01T00:00:00.000Z', bundle: { questions: [], banks: [], records: [], review_states: [], settings: [], delete_log: [], assets: [] } } }
        case 'sync_push': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_apply_snapshot': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_replace_snapshot': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_assets_missing': return { success: true, data: { total: 0, items: [] } }
        case 'sync_assets_pull': return { success: true, data: { items: [], skipped: [], total_bytes: 0 } }
        case 'sync_assets_push': return { success: true, data: { items: [], skipped: [], total_bytes: 0 } }
        case 'review_stats':
          if (window.__statsFail) throw 'stats backend down'
          return { success: true, data: window.__stats }

        // ── S3 云同步（C2）──────────────────────────────────────────
        // 形状照 src-tauri/src/db/s3/mod.rs + s3/sync.rs 真实返回写。
        // 注意：S3 面板在设置弹窗里，当前 7 个模块不打开它；
        // 这些 mock 是为「将来加设置/同步用例」准备的，不赚覆盖率。
        case 'sync_s3_config_get': return { success: true, data: { configured: false } }
        case 'sync_s3_config_set': return { success: true, data: { configured: true } }
        case 'sync_s3_test': return {
          success: true,
          data: { ok: true, writable: true, readable: true, listable: true, deletable: true, endpoint: 'mock-s3', checked_at: '2026-01-01T00:00:00.000Z' }
        }
        case 'sync_s3_status': return {
          success: true,
          data: { device_id: 'dev_mock', push_seq: 0, push_watermark: '', cursors: {}, bootstrapped: false, last_push_at: '', last_pull_at: '' }
        }
        case 'sync_s3_push': return { success: true, data: { pushed: 0, assets: 0 } }
        case 'sync_s3_pull': return { success: true, data: { applied: 0, skipped: 0, assets: 0 } }
        case 'sync_s3_compact': return { success: true, data: { compacted: 0 } }
        case 'sync_s3_repair_assets': return { success: true, data: { repaired: 0, missing: 0 } }

        // ── 导入（C2）────────────────────────────────────────────────
        // import_questions 是导入链路真正落库的命令（questions.rs:871），
        // 返回 { batch_id, items }。
        case 'import_questions': return { success: true, data: { batch_id: 'batch_mock', items: [] } }
        // ── 未 mock 的命令必须炸，不能「假装成功」（C3）──────────────
        // 旧写法 `default: return { success: true, data: null }` 让「忘了 mock」
        // 变成静默通过：前端调用拿到 null 也不报错，页面看起来正常，
        // 于是 e2e 绿了但那条链路一次都没验过。
        // 现在：default 直接抛，并附上「已知但故意不 mock」的清单提示。
        default:
          throw new Error(
            `e2e mock 未覆盖的命令：${cmd}。` +
            `若它确实不该在 e2e 里被调用（如纯后端/纯外壳命令），请加到 tools/e2e/guard.mjs 的 UNMOCKED_ALLOWLIST；` +
            `否则在 mockScript 里补 case。`
          )
      }
      } finally {
        window.__inflight--
      }
    },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window['_cb' + id] = cb; return id },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p
  }
}
