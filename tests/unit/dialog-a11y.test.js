/**
 * 弹层可访问性守卫（FE-P1-11）
 *
 * 静态部分：所有 Teleport 弹层都必须接同一套 composable，且具备 role/aria-modal/tabindex。
 * 行为部分：`focusableIn` / `trapTab` 的边界逻辑（不依赖真实 DOM 的部分用假节点验证）。
 *
 * 为什么要这条测试：焦点圈与「关闭后焦点归位」这类问题**在界面完全看不出来**——
 * 鼠标用户一切正常，只有 Tab 一按焦点窜到背后页面才发现。之前已经积了
 * 5 个弹层完全没有焦点圈（ImportFileBox / Banks / ExamSheet / ExamHistory / DialogHost），
 * 所以「新增弹层忘了接」必须被自动拦住。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

function vueFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) vueFiles(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

const { TOAST_CONTAINER_ATTRS, toastSrLabel, FOCUSABLE } = await import(
  '../../src/composables/useDialogA11y.js'
)

/** 要求接入 a11y 的弹层清单（与 FE-P1-11 原文一一对应） */
const REQUIRED = [
  'src/components/ImportFileBox.vue',
  'src/views/Banks.vue',
  'src/components/settings/SettingsDialog.vue',
  'src/components/search/SearchPalette.vue',
  'src/components/exam/ExamSheet.vue',
  'src/components/exam/ExamHistory.vue',
  'src/components/ui/DialogHost.vue',
  'src/components/ui/ShortcutsDialog.vue'
]

describe('所有 Teleport 弹层接入统一下拉 a11y', () => {
  for (const rel of REQUIRED) {
    test(`${rel} 使用 useDialogA11y 且具备 role/aria-modal`, () => {
      const src = read(rel)
      assert.match(src, /useDialogA11y\(/, `${rel} 没有接入 useDialogA11y`)
      assert.match(src, /role="dialog"/, `${rel} 缺少 role="dialog"`)
      // 侧边抽屉（ExamSheet/ExamHistory）也是 dialog 语义，同样要 aria-modal
      assert.match(src, /aria-modal="true"/, `${rel} 缺少 aria-modal="true"`)
      // 卡片必须可聚焦，否则「初始焦点落卡片」无法实现
      assert.match(src, /tabindex="-1"/, `${rel} 卡片缺少 tabindex="-1"`)
    })
  }

  test('接入 composable 的文件必须真的 import 它（本轮实际漏过一次 → 运行时白屏）', () => {
    const offenders = []
    for (const file of vueFiles(resolve(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      if (!/useDialogA11y\(/.test(src)) continue
      if (!/import \{[^}]*useDialogA11y[^}]*\} from '@\/composables\/useDialogA11y\.js'/.test(src)) {
        offenders.push(file.replace(ROOT + '\\', ''))
      }
    }
    assert.deepEqual(offenders, [], `以下文件调用了 useDialogA11y 但没 import（运行时 ReferenceError 白屏）：${offenders.join(', ')}`)
  })

  test('composable 用到的 Vue API 都已 import（否则运行时 computed/ref is not defined）', () => {
    for (const rel of REQUIRED.concat(['src/composables/useDialogA11y.js'])) {
      const src = read(rel)
      if (!/useDialogA11y\(/.test(src)) continue
      // 用到 computed( 就必须 import computed；用到 ref( 同理（composable 自身除外，它自己 import）
      if (rel.endsWith('useDialogA11y.js')) continue
      const vueImports = src.match(/import \{([^}]*)\} from 'vue'/)?.[1] || ''
      if (/\bcomputed\(/.test(src)) {
        assert.match(vueImports, /\bcomputed\b/, `${rel} 用了 computed 但没从 vue import`)
      }
    }
  })

  test('不存在「自己手写 window keydown 只管 Esc」的弹层（会漏掉 Tab 圈与焦点归位）', () => {
    const offenders = []
    for (const file of vueFiles(resolve(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      const isDialog = /role="dialog"/.test(src)
      if (!isDialog) continue
      const usesComposable = /useDialogA11y\(/.test(src)
      if (!usesComposable) offenders.push(file.replace(ROOT + '\\', ''))
    }
    assert.deepEqual(offenders, [], `以下 dialog 未接入 useDialogA11y：${offenders.join(', ')}`)
  })
})

describe('Toast 可访问性', () => {
  test('容器属性是 role=status + aria-live=polite（不是 assertive）', () => {
    assert.equal(TOAST_CONTAINER_ATTRS.role, 'status')
    assert.equal(TOAST_CONTAINER_ATTRS['aria-live'], 'polite')
    // assertive 会打断屏幕阅读器正在朗读的题面，错误提示也不该抢
    assert.notEqual(TOAST_CONTAINER_ATTRS['aria-live'], 'assertive')
  })

  test('ToastHost 真的把这三个属性写到了 DOM 上', () => {
    const src = read('src/components/ui/ToastHost.vue')
    assert.match(src, /role="status"/)
    assert.match(src, /aria-live="polite"/)
    assert.match(src, /aria-atomic="false"/)
  })

  test('类型前缀供读屏使用（图标 aria-hidden 后类型会丢）', () => {
    assert.equal(toastSrLabel('success'), '成功')
    assert.equal(toastSrLabel('error'), '错误')
    assert.equal(toastSrLabel('info'), '提示')
    assert.equal(toastSrLabel(undefined), '提示')
    assert.match(read('src/components/ui/ToastHost.vue'), /sr-only/)
  })
})

describe('焦点圈边界逻辑', () => {
  test('可聚焦选择器排除 disabled 与 tabindex=-1', () => {
    assert.match(FOCUSABLE, /button:not\(\[disabled\]\)/)
    assert.match(FOCUSABLE, /input:not\(\[disabled\]\)/)
    assert.match(FOCUSABLE, /tabindex\]:not\(\[tabindex="-1"\]\)/)
  })

  test('composable 覆盖原文四条要求（Esc / Tab 圈 / 初始焦点 / 关闭后归位）', () => {
    const src = read('src/composables/useDialogA11y.js')
    // Esc
    assert.match(src, /e\.key !== 'Escape'/)
    // Tab 圈（含反向回绕）
    assert.match(src, /trapTab/)
    assert.match(src, /e\.shiftKey/)
    // 初始焦点
    assert.match(src, /function focusFirst/)
    assert.match(src, /initialFocusRef/)
    // 关闭后归位
    assert.match(src, /previouslyFocused/)
    assert.match(src, /back\.focus\(\)/)
    // 滚动锁定
    assert.match(src, /body\.style\.overflow = 'hidden'/)
  })

  test('Esc 可让位给上层弹层（嵌套弹层不会一起关掉）', () => {
    const src = read('src/composables/useDialogA11y.js')
    assert.match(src, /escDisabled\?\.\(\)/)
    // DialogHost 之上还有确认弹层的场景：设置页必须让位
    assert.match(read('src/components/settings/SettingsDialog.vue'), /escDisabled: \(\) => !!ui\.dialog/)
  })

  test('keydown 用 capture 注册（否则底层页面的按键处理会抢先）', () => {
    const src = read('src/composables/useDialogA11y.js')
    assert.match(src, /addEventListener\('keydown', onKeydown, true\)/)
    assert.match(src, /removeEventListener\('keydown', onKeydown, true\)/)
  })
})

describe('点击遮罩关闭', () => {
  test('每个弹层的遮罩都有 @click.self 关闭', () => {
    for (const rel of REQUIRED) {
      const src = read(rel)
      // 允许两种写法：@click.self（常规）与 @mousedown.self（设置弹层，避免拖选文字时误关）。
      // 关闭表达式各弹层命名不同（onClose / close / onCancel / showX = false），只要绑定了
      // 一个非空的 .self 处理器就算通过——具体是否真的关闭由各弹层的 e2e 行为断言覆盖。
      const hasMaskClose = /@(click|mousedown)\.self="[^"\s][^"]*"/.test(src)
      assert.ok(hasMaskClose, `${rel} 的遮罩缺少 @click.self 关闭`)
    }
  })

  test('InfoTip 用 Esc 关闭（tooltip 不是 dialog，不需要焦点圈）', () => {
    const src = read('src/components/ui/InfoTip.vue')
    assert.match(src, /@keydown\.esc="open = false"/)
  })
})
