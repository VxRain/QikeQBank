/**
 * 快捷键帮助表 ↔ 实际按键绑定 一致性守卫（FE-P0-08）
 *
 * 风险：`components/ui/ShortcutsDialog.vue` 的键位表是**手写镜像**，不是从各页面
 * 自动生成的。有人改了 Practice 的「1/2 自评」或者删掉 Esc 取消自动下一题，
 * 弹层里的说明会继续骗用户 —— 而这种漂移不会有任何运行时错误。
 *
 * 因此这里做两件事：
 *   ① 表里声明的键位，必须在对应源文件里找到真实分支（防止「写了没实现」）
 *   ② 反过来的关键绑定，必须在表里出现（防止「实现了没写」，用户永远不知道）
 *
 * 与仓库既有 `*-wiring.test.js` / e2e-ready-signal.test.js 同一套路：
 * 只读源码文本、逐字比对，不执行 Vue 组件、不起浏览器。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/**
 * 跨平台容错：本仓库 .gitattributes 未归一化行尾，core.autocrlf=true 的 Windows
 * 检出会把几乎所有文件变成 CRLF，而下方守卫的正则全部按 LF（`\n`）书写。
 * 不归一化时，任何带 `\n` 的多行正则在 Windows 上**静默失配**（断言拿到 [] 而不是报错），
 * 是"本地绿 / CI 红"或反过来的经典来源。故读取即归一化，让守卫与行尾无关。
 */
const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n')

const dialogSrc = read('src/components/ui/ShortcutsDialog.vue')
const appSrc = read('src/App.vue')
const practiceSrc = read('src/views/Practice.vue')
const reviewSrc = read('src/views/Review.vue')
const examSrc = read('src/views/Exam.vue')
const runnerSrc = read('src/components/question/QuestionRunner.vue')
const formSrc = read('src/views/Form.vue')
const paletteSrc = read('src/components/search/SearchPalette.vue')

/** 从 ShortcutsDialog 的 GROUPS 表里抽出所有 { keys, desc } 声明 */
function declaredKeys() {
  const at = dialogSrc.indexOf('const GROUPS')
  assert.ok(at >= 0, '找不到 ShortcutsDialog.vue 的 GROUPS 表（结构变了？守卫须同步）')
  const body = dialogSrc.slice(at, dialogSrc.indexOf('\n]', at))
  const out = []
  for (const m of body.matchAll(/\{\s*keys:\s*'([^']+)',\s*desc:\s*'([^']+)'\s*\}/g)) {
    out.push({ keys: m[1], desc: m[2] })
  }
  return out
}

/** 一个键位串是否出现在表里（按 token 精确匹配，避免 'M' 命中 'Cmd'） */
function hasDeclared(keys) {
  return declaredKeys().some((d) => d.keys === keys)
}

describe('快捷键帮助（FE-P0-08）', () => {
  test('键位表非空且分组覆盖全局/搜索/练习/复习/模考/录题', () => {
    const ids = [...dialogSrc.matchAll(/id:\s*'([a-z]+)',\n\s*title:/g)].map((m) => m[1])
    assert.deepEqual(ids, ['global', 'search', 'practice', 'review', 'exam', 'form'])
  })

  test('表里声明的每条键位都有非空说明', () => {
    const rows = declaredKeys()
    assert.ok(rows.length >= 20, `键位条目过少：${rows.length}`)
    for (const r of rows) {
      assert.ok(r.keys.trim().length > 0, `存在空的键位声明：${JSON.stringify(r)}`)
      assert.ok(r.desc.trim().length > 2, `键位 ${r.keys} 的说明过短：${r.desc}`)
    }
  })

  describe('全局', () => {
    test('Ctrl+K 在 App.vue 有真实分支，且表里已声明', () => {
      assert.match(appSrc, /ctrlKey \|\| e\.metaKey/, 'App.vue 不再判断 Ctrl/Cmd 修饰键')
      assert.match(appSrc, /\(e\.key \|\| ''\)\.toLowerCase\(\) === 'k'/, 'App.vue 没有 Ctrl+K 分支')
      assert.ok(hasDeclared('Ctrl K'), 'Ctrl K 已实现但没写进快捷键表')
    })

    test('`?` 打开帮助，且输入框内不触发（表里标注一致）', () => {
      assert.match(appSrc, /e\.key !== '\?'/, 'App.vue 没有 `?` 分支')
      assert.match(appSrc, /isTypingTarget\(e\.target\)/, '`?` 没有排除输入框，会吞掉用户打的问号')
      assert.ok(hasDeclared('?'), '`?` 已实现但没写进快捷键表')
      // 说明文案必须点明「输入框内不触发」，否则用户会以为坏了
      const q = declaredKeys().find((d) => d.keys === '?')
      assert.match(q.desc, /输入框/, '`?` 的说明没提到「输入框内不触发」')
    })

    test('Esc 关闭弹层（面板内先清空关键词）', () => {
      assert.match(paletteSrc, /escStep\(query\.value\)/, '搜索面板的 Esc 没走 escStep 两级逻辑')
      assert.match(dialogSrc, /e\.key !== 'Escape'/, '快捷键弹层自身没有 Esc 分支')
      assert.ok(hasDeclared('Esc'))
    })
  })

  describe('搜索面板', () => {
    test('↑/↓ 移动、Enter 打开、→ 展开、Esc 逐级 —— 与表一致', () => {
      for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'ArrowRight', 'Escape']) {
        assert.match(paletteSrc, new RegExp(`e\\.key === '${key}'`), `搜索面板缺少 ${key} 分支`)
      }
      assert.match(paletteSrc, /toggleExpand\(row\)/, '→ 没有接到「展开题面」')
      assert.deepEqual(
        ['↑ ↓', 'Enter', '→', 'Esc'].filter((k) => !hasDeclared(k)),
        [],
        '搜索面板的键位没写全到快捷键表'
      )
    })
  })

  describe('刷题', () => {
    test('Enter 提交 / 判分后下一题', () => {
      assert.match(practiceSrc, /if \(graded\.value\) \{\s*\n\s*e\.preventDefault\(\)\s*\n\s*next\(\)/, 'Enter 判分后没有 next()')
      assert.match(practiceSrc, /submit\(\)/, 'Enter 没有接线 submit()')
      assert.ok(hasDeclared('Enter'))
    })

    test('A–F 选项与 M 切材料在 QuestionRunner 里', () => {
      assert.match(runnerSrc, /\^\[A-F\]\$/, 'QuestionRunner 没有 A–F 选题分支')
      assert.match(runnerSrc, /k === 'M'/, 'QuestionRunner 没有 M 切材料分支')
      assert.ok(hasDeclared('A B C D'), 'A–F 选题没写进快捷键表')
      assert.ok(hasDeclared('M'), 'M 切材料没写进快捷键表')
    })

    test('1/2 简答自评', () => {
      assert.match(practiceSrc, /\(k === '1' \|\| k === '2'\) && isShort\.value/, 'Practice 没有 1/2 简答自评')
      assert.ok(hasDeclared('1 2'))
    })

    test('背题模式 ←/→ 翻题', () => {
      assert.match(practiceSrc, /e\.key === 'ArrowRight'\)\s*\{\s*\n\s*e\.preventDefault\(\)\s*\n\s*next\(\)/, '背题 ←/→ 翻题分支变了')
      assert.ok(hasDeclared('← →'), '背题模式翻题键没写进快捷键表')
    })

    test('Esc 取消自动下一题', () => {
      assert.match(practiceSrc, /cancelAutoNext\(\)/, 'Practice 的 Esc 没接 cancelAutoNext')
      assert.ok(hasDeclared('Esc'))
    })

    test('表里声明「输入框内不劫持」——源码确实有该判断', () => {
      const note = dialogSrc.includes('输入框内与弹窗打开时不劫持按键')
      assert.ok(note, 'Practice 组的 note 丢了')
      assert.match(practiceSrc, /closest\('textarea, select, input, \[contenteditable\]/, 'Practice 不再排除输入框，会吞掉用户的输入')
      assert.match(practiceSrc, /if \(ui\.dialog\) return/, 'Practice 不再排除弹层，会在确认框上误触发')
    })
  })

  describe('复习', () => {
    test('判分后 1–4 自评，且 Enter 不替你选', () => {
      assert.match(reviewSrc, /\^\[1-4\]\$/, 'Review 没有 1–4 自评分支')
      assert.match(reviewSrc, /if \(graded\.value\) return/, 'Review 判分后 Enter 又有了动作，与表里说明不符')
      assert.ok(hasDeclared('1 2 3 4'), '1–4 自评没写进快捷键表')
    })

    test('A–F / M 与刷题共用 QuestionRunner', () => {
      assert.match(reviewSrc, /onCardKeydown/, 'Review 没有卡片级键盘流')
      assert.ok(hasDeclared('A B C D'))
      assert.ok(hasDeclared('M'))
    })
  })

  describe('模考', () => {
    test('Enter 下一题、1/2 简答自评', () => {
      assert.match(examSrc, /go\(curIdx\.value \+ 1\)/, 'Exam 的 Enter 没有接到下一题')
      assert.match(examSrc, /\(k === '1' \|\| k === '2'\) && cur\.value\?\.q\.type === 'short'/, 'Exam 没有 1/2 简答自评')
      assert.ok(hasDeclared('1 2'))
    })
  })

  describe('录题', () => {
    test('Ctrl+S 保存', () => {
      assert.match(formSrc, /key !== 's'/, 'Form 没有 Ctrl+S 分支')
      assert.ok(hasDeclared('Ctrl S'), 'Ctrl S 没写进快捷键表')
    })
  })

  test('弹层只列真实存在的键位：不得出现未实现的组合键', () => {
    // 反例守卫：表里若出现 Ctrl+/ Cmd+Enter 之类，源码里必须真有分支。
    const exotic = declaredKeys()
      .map((d) => d.keys)
      .filter((k) => /Ctrl|Cmd/.test(k))
      .filter((k) => k !== 'Ctrl K' && k !== 'Ctrl S')
    assert.deepEqual(exotic, [], `快捷键表里出现了未实现的组合键：${exotic.join(', ')}`)
  })
})
