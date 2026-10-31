/**
 * 设置导出 / 导入 / 恢复默认守卫（FE-P1-10）
 *
 * 导入是「不可信输入」，最危险的两种错法：
 * ① 把整个文件拒绝掉（用户以为功能坏了）——所以要求逐字段归一；
 * ② 悄悄补上文件里没有的默认值（用户以为「我只改了一项」却动了全部）。
 * 这两条都用测试钉住。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const {
  SETTINGS_EXPORT_SCHEMA,
  EXPORTABLE_KEYS,
  snapshotSettings,
  exportSettings,
  parseSettingsImport,
  settingsFileName
} = await import('../../src/utils/settingsIO.js')

const FULL = {
  keepContentOnTypeChange: false,
  autoNextOnCorrect: true,
  autoNextDelayMs: 2000,
  rememberBankFilter: true,
  dailyGoal: 35,
  wrongLeaveAfterCorrect: 0,
  autoSyncEnabled: true,
  autoSyncIntervalMin: 45,
  fsrs: {
    requestRetention: 0.85,
    maximumInterval: 1000,
    learningSteps: ['2m', '20m'],
    relearningSteps: ['15m'],
    enableFuzz: true,
    practiceScope: 'wrong-only'
  }
}

describe('导出快照', () => {
  test('只取白名单键（密钥类字段不会漏进导出包）', () => {
    const snap = snapshotSettings({ ...FULL, s3Secret: 'SHOULD-NOT-EXPORT', accessKey: 'x' })
    assert.equal(snap.s3Secret, undefined)
    assert.equal(snap.accessKey, undefined)
    for (const k of Object.keys(snap)) {
      assert.ok(EXPORTABLE_KEYS.includes(k), `导出了白名单外的键：${k}`)
    }
  })

  test('fsrs 深层只取已知字段', () => {
    const snap = snapshotSettings({
      ...FULL,
      fsrs: { ...FULL.fsrs, secretKey: 'nope', junk: 1 }
    })
    assert.equal(snap.fsrs.secretKey, undefined)
    assert.equal(snap.fsrs.junk, undefined)
    assert.deepEqual(Object.keys(snap.fsrs).sort(), [
      'enableFuzz', 'learningSteps', 'maximumInterval', 'practiceScope', 'relearningSteps', 'requestRetention'
    ])
  })

  test('导出内容带 schema 与「不含题库/密钥」说明', () => {
    const { text, count } = exportSettings(FULL)
    const obj = JSON.parse(text)
    assert.equal(obj.schema, SETTINGS_EXPORT_SCHEMA)
    assert.match(obj.note, /不含题库数据与云端密钥/)
    assert.ok(count >= 8, `只导出了 ${count} 项`)
    assert.equal(obj.settings.dailyGoal, 35)
  })

  test('导出是深拷贝：改快照不影响源对象', () => {
    const src = { ...FULL, fsrs: { ...FULL.fsrs, learningSteps: ['1m'] } }
    const snap = snapshotSettings(src)
    snap.fsrs.learningSteps.push('99m')
    assert.deepEqual(src.fsrs.learningSteps, ['1m'])
  })

  test('文件名带日期与 .json', () => {
    assert.match(settingsFileName('json'), /^奇客题库_设置_\d{4}-\d{2}-\d{2}\.json$/)
  })
})

describe('导入解析', () => {
  test('标准导出文件可读回（round-trip）', () => {
    const { text } = exportSettings(FULL)
    const r = parseSettingsImport(text)
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.patch, snapshotSettings(FULL))
  })

  test('接受裸设置对象（手写的 JSON 也能用）', () => {
    const r = parseSettingsImport(JSON.stringify({ dailyGoal: 30 }))
    assert.equal(r.ok, true)
    assert.deepEqual(r.patch, { dailyGoal: 30 })
  })

  test('**只产出文件里出现过的键**（不悄悄补默认值）', () => {
    const r = parseSettingsImport({ dailyGoal: 50 })
    assert.deepEqual(Object.keys(r.patch), ['dailyGoal'])
  })

  test('非法 JSON / 空内容 / 非对象 都给出可读错误', () => {
    assert.match(parseSettingsImport('').error, /空/)
    assert.match(parseSettingsImport('{oops').error, /JSON/)
    assert.match(parseSettingsImport('[1,2]').error, /不是一个设置对象/)
    assert.match(parseSettingsImport('null').error, /不是一个设置对象/)
  })

  test('不认识的 schema 明确拒绝（不猜版本）', () => {
    const r = parseSettingsImport({ schema: 'other.app.v9', settings: { dailyGoal: 1 } })
    assert.equal(r.ok, false)
    assert.match(r.error, /不认识的设置格式/)
  })

  test('没有可识别项时报错而不是「成功但什么都没改」', () => {
    const r = parseSettingsImport({ unknownThing: 1 })
    assert.equal(r.ok, false)
    assert.match(r.error, /没有可识别的设置项/)
  })

  test('数值越界钳制并记 warning（不整包拒绝）', () => {
    const r = parseSettingsImport({ dailyGoal: 9999, autoSyncIntervalMin: 1 })
    assert.equal(r.ok, true)
    assert.equal(r.patch.dailyGoal, 500)
    assert.equal(r.patch.autoSyncIntervalMin, 10)
    assert.equal(r.warnings.length, 2, JSON.stringify(r.warnings))
  })

  test('错题阈值 0 是合法值（永不自动移出），不能被当成非法钳到 1', () => {
    const r = parseSettingsImport({ wrongLeaveAfterCorrect: 0 })
    assert.equal(r.patch.wrongLeaveAfterCorrect, 0)
    assert.deepEqual(r.warnings, [])
  })

  test('布尔严格归一：接受 true/false 与字符串，其余回退', () => {
    assert.equal(parseSettingsImport({ autoSyncEnabled: 'true' }).patch.autoSyncEnabled, true)
    assert.equal(parseSettingsImport({ autoSyncEnabled: 0 }).patch.autoSyncEnabled, false)
    assert.equal(parseSettingsImport({ autoSyncEnabled: 'yes' }).patch.autoSyncEnabled, false)
  })

  test('步长非法项被过滤，全非法回落默认', () => {
    const ok = parseSettingsImport({ fsrs: { learningSteps: ['1m', 'bad', '4h'] } })
    assert.deepEqual(ok.patch.fsrs.learningSteps, ['1m', '4h'])
    const bad = parseSettingsImport({ fsrs: { learningSteps: ['x', 'y'] } })
    assert.deepEqual(bad.patch.fsrs.learningSteps, ['1m', '10m'])
  })

  test('practiceScope 只接受 wrong-only，其余归 all', () => {
    assert.equal(parseSettingsImport({ fsrs: { practiceScope: 'wrong-only' } }).patch.fsrs.practiceScope, 'wrong-only')
    assert.equal(parseSettingsImport({ fsrs: { practiceScope: 'whatever' } }).patch.fsrs.practiceScope, 'all')
  })

  test('单字段非法不影响其它字段生效', () => {
    const r = parseSettingsImport({ dailyGoal: 'abc', autoNextOnCorrect: true })
    assert.equal(r.ok, true)
    assert.equal(r.patch.dailyGoal, 20, '非法值回落默认')
    assert.equal(r.patch.autoNextOnCorrect, true, '合法字段仍然生效')
  })
})

describe('视图接线（静态守卫）', () => {
  const dialog = read('src/components/settings/SettingsDialog.vue')
  const settingsSrc = read('src/stores/settings.js')
  const app = read('src/App.vue')
  const panel = read('src/components/S3SyncPanel.vue')

  test('设置页有导出 / 导入 / 恢复默认三个入口', () => {
    assert.match(dialog, /导出/)
    assert.match(dialog, /导入/)
    assert.match(dialog, /恢复默认/)
  })

  test('恢复默认与导入都必须二次确认（铁律①：不用原生弹窗）', () => {
    assert.match(dialog, /const ok = await confirmDialog\(\{[\s\S]{0,200}恢复默认设置/)
    assert.match(dialog, /await confirmDialog\(\{[\s\S]{0,200}导入设置/)
    const noComment = dialog.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\bwindow\.(alert|confirm|prompt)\b/.test(noComment))
  })

  test('DEFAULTS 是默认值的唯一定义，reactive 初值引用它', () => {
    assert.match(settingsSrc, /export const DEFAULTS = Object\.freeze/)
    assert.match(settingsSrc, /saved\.keepContentOnTypeChange \?\? DEFAULTS\.keepContentOnTypeChange/)
    // 恢复默认必须逐字段写回同源 DEFAULTS，而不是另写一套字面量
    assert.match(settingsSrc, /export function resetSettingsToDefault\(\)[\s\S]{0,800}const d = DEFAULTS/)
  })

  test('快捷键按钮复用同一个 ShortcutsDialog（不新写一份清单）', () => {
    assert.match(dialog, /emit\('open-shortcuts'\)/)
    assert.match(app, /@open-shortcuts="openShortcutsFromSettings"/)
    // App 里仍然只有一个 ShortcutsDialog 实例
    const instances = (app.match(/<ShortcutsDialog/g) || []).length
    assert.equal(instances, 1, `ShortcutsDialog 出现了 ${instances} 次`)
    assert.match(app, /function openShortcutsFromSettings\(\)[\s\S]{0,200}showShortcuts\.value = true/)
  })

  test('S3 面板显示上次同步时间 / 未同步变更 / 冲突且可展开', () => {
    assert.match(panel, /上次同步/)
    assert.match(panel, /未同步变更/)
    assert.match(panel, /pendingRows/)
    assert.match(panel, /conflictCount/)
    assert.match(panel, /s3Pending/)
  })
})
