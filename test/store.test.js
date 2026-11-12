import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  workspaceKey, scopeDirs, resolveDataDir, appendRecord, loadScope, appendJudgeAudit, makeProbe, baseDirOf, readConfig, setHostBaseDir, nowIso,
} from '../lib/store.js'
import { computeStatus } from '../lib/schema.js'
import { renderRules, renderTail, estimateTokens, hitGuides } from '../lib/render.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-'))

const rule = (over = {}) => ({
  v: 1, id: 'as_' + Math.random().toString(16).slice(2, 8), ts: '2026-11-04T10:00:00Z',
  sid: 's-1', turn: 1, kind: 'rule', scope: 'workspace',
  body: '本机不用 pnpm', criteria: '出现 pnpm 即违规',
  anchor: { type: 'turn', sid: 's-1', turn: 1, quote: '别用 pnpm' },
  source: { author: 'user', quote: '别用 pnpm' }, strength: 'user_said',
  ...over,
})

test('baseDirOf：ctx.baseDir 未注入（读取即抛）时回落 ~/.dsh，不把异常抛给注入面', () => {
  const throwing = {}
  Object.defineProperty(throwing, 'baseDir', {
    get() {
      throw new Error('cannot get property "baseDir" without inject')
    },
  })
  assert.equal(baseDirOf(throwing), path.join(os.homedir(), '.dsh'))
  assert.equal(baseDirOf({ baseDir: '/tmp/x' }), '/tmp/x')
  assert.equal(baseDirOf(undefined), path.join(os.homedir(), '.dsh'))
})

test('baseDirOf：apply 经 ctx.inject 交给 store 的 baseDir 优先，卸载后回落（LEV-2）', () => {
  assert.equal(baseDirOf({ baseDir: '/tmp/x' }), '/tmp/x')
  // 注入后：宿主 baseDir 优先，即使 ctx 上读不到（未 inject 时反射读取会抛）
  setHostBaseDir('/host/base')
  assert.equal(baseDirOf({}), '/host/base')
  assert.equal(baseDirOf(undefined), '/host/base')
  // dispose 传 null：回到反射/回落
  setHostBaseDir(null)
  assert.equal(baseDirOf({}), path.join(os.homedir(), '.dsh'))
})

test('readConfig：行配置非法值报字段路径、合法值生效、活格子解包、空值不报错', () => {
  const ctx = { baseDir: tmp() }

  const bad = readConfig({ rulesMax: 9999, injectBudgetTokens: 'x', compactPoolMax: 0, compactBatch: 5, dataDir: 3 })
  assert.equal(bad.config.rulesMax, 30)
  assert.equal(bad.config.compactPoolMax, 60, '越界回落默认值')
  assert.equal(bad.config.compactBatch, 60)
  assert.match(bad.error, /config\.rulesMax/)
  assert.match(bad.error, /config\.injectBudgetTokens/)
  assert.match(bad.error, /config\.compactPoolMax/)
  assert.match(bad.error, /config\.compactBatch/)
  assert.match(bad.error, /config\.dataDir/)

  const ok = readConfig({ rulesMax: 5, injectBudgetTokens: 300, compactPoolMax: 30, compactBatch: 20, dataDir: '' })
  assert.equal(ok.error, null)
  assert.equal(ok.config.rulesMax, 5)
  assert.equal(ok.config.injectBudgetTokens, 300)
  assert.equal(ok.config.compactPoolMax, 30)
  assert.equal(ok.config.compactBatch, 20)

  const cell = readConfig({ rulesMax: { get: () => 7 } })
  assert.equal(cell.error, null)
  assert.equal(cell.config.rulesMax, 7)
})

test('workspaceKey：稳定、slug + hash8', () => {
  const a = workspaceKey('G:/GitWork/dsh-waystone')
  assert.equal(a, workspaceKey('G:/GitWork/dsh-waystone'))
  assert.match(a, /^[A-Za-z0-9_-]+-[0-9a-f]{8}$/)
  assert.notEqual(a, workspaceKey('G:/GitWork/other'))
})

test('workspaceKey：中文目录名保留（只剥文件名非法字符），纯中文不留空', () => {
  const cn = workspaceKey('D:/SR/项目/上汽/大众联合招标TBOX')
  assert.ok(cn.startsWith('大众联合招标TBOX-'), cn) // 旧规则会退化成 "TBOX-…"
  assert.match(cn, /^.+-[0-9a-f]{8}$/)
  assert.equal(cn, workspaceKey('D:/SR/项目/上汽/大众联合招标TBOX'))
  // 目录名里带 Windows 保留字符（只可能来自非路径输入）仍然要剥掉
  assert.ok(workspaceKey('C:/a/b:c').startsWith('bc-'))
  // 纯非法/空 basename 回退成 ws（'/' 在 win32/posix 下 basename 都是空串；写 'C:/' 只在 Windows 成立）
  assert.match(workspaceKey('/'), /^ws-[0-9a-f]{8}$/)
})

test('resolveDataDir：env 优先于默认', () => {  const dir = tmp()
  const prev = process.env.WAYSTONE_DATA_DIR
  process.env.WAYSTONE_DATA_DIR = dir
  try {
    const r = resolveDataDir({}, { dataDir: '' }, dir)
    assert.equal(r.source, 'env')
    assert.equal(path.resolve(r.dataDir), path.resolve(dir))
  } finally {
    if (prev === undefined) delete process.env.WAYSTONE_DATA_DIR
    else process.env.WAYSTONE_DATA_DIR = prev
  }
})

test('分片追加 + 读时合并 + 状态计算', () => {
  const dir = tmp()
  appendRecord(dir, 's-1', rule({ id: 'as_aaaaaa' }))
  appendRecord(dir, 's-2', rule({ id: 'as_bbbbbb', ts: '2026-11-04T11:00:00Z', sid: 's-2', supersedes: 'as_aaaaaa' }))
  const merged = loadScope(dir)
  assert.equal(merged.records.length, 2)
  assert.equal(merged.sessions, 2)
  const status = computeStatus(merged.records)
  assert.equal(status.get('as_aaaaaa'), 'superseded')
  assert.equal(status.get('as_bbbbbb'), 'active')

  // append-only：再追加不覆盖旧行
  appendRecord(dir, 's-1', rule({ id: 'as_cccccc' }))
  assert.equal(loadScope(dir).records.length, 3)
})

test('判官审计落盘', () => {
  const dir = tmp()
  appendJudgeAudit(dir, 's-1', { turn: 3, accepted: [] })
  appendJudgeAudit(dir, 's-1', { turn: 4, accepted: ['as_aaaaaa'] })
  const file = path.join(dir, 'judge', 's-1.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('探针：行指纹与越界', () => {
  const dir = tmp()
  const file = path.join(dir, 'a.js')
  fs.writeFileSync(file, 'const a = 1\nconst b = 2\n')
  const probe = makeProbe()
  const sha = probe.lineSha256(file, 2)
  assert.match(sha, /^[0-9a-f]{64}$/)
  assert.equal(probe.lineSha256(file, 9), undefined)
})

test('交接段：空库整段不注入，有死路才出现', () => {
  assert.equal(renderTail({}), '', '无线/无死路/无指南命中时不应注入 [交接] 占位')
  const dead = renderTail({ activeDeadends: [{ body: '试过 X 不通', ts: '2026-11-05T00:00:00Z' }] })
  assert.ok(dead.includes('[死路 · 别重试]'), dead)
  assert.ok(dead.includes('试过 X 不通'), dead)
  assert.ok(!dead.includes('无进行中的线'), '没有线就不补占位行：' + dead)
})

test('指南命中去噪：只认 body、且至少两个词命中', () => {
  const g = { id: 'g1', body: '合并重复的 topic 线', criteria: '同一条线不能并列显示' }
  assert.equal(hitGuides([g], '合并').length, 0, '单个二字词撞上正文只是巧合，不算命中')
  assert.equal(hitGuides([g], '合并重复').length, 1, '两个词命中才算')
  assert.equal(hitGuides([g], '并列显示').length, 0, 'criteria 不参与匹配')
})

test('规约段：global 在前、字节稳定、排序固定、带 [未复核]', () => {
  const g = rule({ id: 'as_000001', scope: 'global', body: '机器级：别用 pnpm' })
  const w = rule({ id: 'as_000002', body: '本项目：提交信息用中文', suspect: ['criteria_weak'] })
  const once = renderRules({ global: [g], workspace: [w] })
  const twice = renderRules({ global: [g], workspace: [w] })
  assert.equal(once, twice)
  assert.ok(once.indexOf('[规约 · 全局]') < once.indexOf('[规约 · 本工作区]'))
  assert.ok(once.includes('[未复核]'))
  // 同一批不同入参顺序 → 同一字节（排序键固定）
  assert.equal(renderRules({ global: [g], workspace: [w] }), renderRules({ global: [g], workspace: [w] }))
})

test('规约段：预算截断丢弃尾部而不超预算', () => {
  const many = Array.from({ length: 60 }, (_, i) => rule({ id: 'as_0' + String(100000 + i), body: '规则 ' + i + ' ' + 'x'.repeat(60) }))
  const text = renderRules({ global: [], workspace: many, budgetTokens: 100 })
  assert.ok(estimateTokens(text) <= 100 + 5)
})

test('交接段：第 4 条起的线降级成「名称 (tp_id)：下一步」，最多 6 条，再多只报总数', () => {
  const line = (n, ts) => ({ id: 'as_w' + n, topicId: 'tp_00000' + n, topicName: '线' + n, ts, body: '正文' + n, next: '做' + n })
  const four = [
    line(1, '2026-11-04T04:00:00Z'), line(2, '2026-11-04T03:00:00Z'),
    line(3, '2026-11-04T02:00:00Z'), line(4, '2026-11-04T01:00:00Z'),
  ]
  const out = renderTail({ stateBuckets: four, budgetTokens: 825 })
  // 前 3 条照旧：完整（带正文 + 下一步）
  assert.ok(out.includes('正文1') && out.includes('正文2') && out.includes('正文3'), out)
  // 第 4 条不再被丢掉：降级成一行，仍带 topic_id 与下一步（模型要能认出是哪条线、接着做）
  assert.ok(!out.includes('正文4'), '降级行不该带正文')
  assert.ok(out.includes('- 线4 (tp_000004)：下一步：做4'), out)

  // 10 条线：3 完整 + 6 降级，剩下 1 条只报总数，不静默消失
  const ten = Array.from({ length: 10 }, (_, i) => line(i + 1, '2026-11-04T' + String(10 + (10 - i)) + ':00:00Z'))
  const many = renderTail({ stateBuckets: ten, budgetTokens: 825 })
  assert.ok(many.includes('- 线9 (tp_000009)'), '第 9 条（降级窗口内）应出现')
  assert.ok(!many.includes('线10 '), '第 10 条超出降级窗口，正文/名字不进交接')
  assert.ok(many.includes('…另有 1 条线未展开'), many)
})

test('交接段：state 按 topic_id 平铺（行首带 id）、无名的桶不出现、闭环桶不出现、死路取最新三条、无「记忆目录」段', () => {
  const buckets = [
    { id: 'as_111111', topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '跑测试' },
    { id: 'as_222222', topicId: 'tp_bbbbbb', topicName: 't-ui', ts: '2026-11-04T11:00:00Z', body: '改概览页', next: '等设计稿' },
    { topicId: 'tp_cccccc', topicName: '', ts: '2026-11-04T12:30:00Z', body: '没有名字的桶', next: '不该出现' },
    { topicId: 'tp_dddddd', topicName: 't-done', ts: '2026-11-04T13:00:00Z', body: '这条已完成', next: '', closed: true },
  ]
  const dead = [{ id: 'as_9', kind: 'deadend', ts: '2026-11-04T09:00:00Z', body: '别用 sync fs 做大批量读' }]
  const normal = renderTail({ stateBuckets: buckets, activeDeadends: dead })
  assert.ok(!normal.includes('[记忆目录]'))
  assert.ok(!normal.includes('状态可能滞后'), '滞后免责声明已从注入移除，滞后信息只在契约一.3')
  // 接手提示不再是一个列表条目：粗体独立成段（前面空一行），免得被读成第 N 条待办
  assert.ok(normal.includes('\n\n**接手：上面的「下一步」是待办'), normal)
  assert.ok(!normal.includes('- 接手：'), '接手提示不该再带列表符号')
  assert.ok(normal.includes('- as_111111 t-main (tp_aaaaaa)：已写 store；下一步：跑测试'), normal)
  assert.ok(normal.includes('- as_222222 t-ui (tp_bbbbbb)：改概览页；下一步：等设计稿'), normal)
  assert.ok(!normal.includes('没有名字的桶'), normal) // 没名字的桶不注入
  assert.ok(!normal.includes('主线'), normal) // 没有「主线」这个兜底桶
  assert.ok(!normal.includes('t-done'), normal) // 已完成的线不进交接
  assert.ok(!normal.includes('目标：'), normal) // 不再有 目标/在做 这套分类
  // 死路独立成段，一行一条，与交接段之间空一行
  assert.ok(normal.includes('[死路 · 别重试]'), normal)
  assert.ok(normal.includes('- as_9 别用 sync fs 做大批量读'), normal)
  assert.ok(!normal.includes('死路（别重试）：'), normal)
  // 只有死路、没有线时：只出死路段，不补 [交接] 空壳
  const deadOnly = renderTail({ activeDeadends: dead, budgetTokens: 690 })
  assert.ok(deadOnly.startsWith('[死路 · 别重试]'), deadOnly)
  assert.ok(!deadOnly.includes('[交接]'), deadOnly)

  // 旧 branch：boundary=true 才注入「[记忆目录]」。因宿主每步渲染两次 context、
  // 落地的是第二次，该行永远到不了模型，已连分支一起删除。
  const noDir = renderTail({ stateBuckets: buckets, activeDeadends: dead })
  assert.ok(noDir.startsWith('[交接]'), noDir)
  assert.ok(!noDir.includes('[记忆目录]'), noDir)

  const tight = renderTail({ stateBuckets: buckets, activeDeadends: dead, budgetTokens: 30 })
  // 预算连一条线都放不下 ⇒ 整段放弃，不留"[交接]+接手行"空壳
  assert.equal(tight, '')

  // 线内被否决的方案：缩进挂在该线下面（否决属于线，不是跨线教训）
  const withVeto = renderTail({
    stateBuckets: [{ id: 'as_333333', topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '跑测试', vetoes: [{ id: 'as_v11111', body: '用户否掉了 file 锚点方案' }, { id: 'as_v22222', body: '不再加锚点展示 UI' }] }],
    budgetTokens: 690,
  })
  assert.ok(withVeto.includes('- as_333333 t-main (tp_aaaaaa)：已写 store；下一步：跑测试'), withVeto)
  assert.ok(withVeto.includes('  ✗ 已否决 as_v11111：用户否掉了 file 锚点方案'), withVeto)
  assert.ok(withVeto.includes('  ✗ 已否决 as_v22222：不再加锚点展示 UI'), withVeto)
  // 线闭环 → 整条线（连同它的否决）退出交接
  const closedVeto = renderTail({
    stateBuckets: [{ topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '', closed: true, vetoes: ['用户否掉了 file 锚点方案'] }],
    budgetTokens: 690,
  })
  assert.ok(!closedVeto.includes('已否决'), closedVeto)
  // 预算收紧顺序：丢跨线教训（死路）→ 丢否决子行 → 保线本体
  const tightVeto = renderTail({
    stateBuckets: [{ topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '跑测试', vetoes: ['被否的方案甲'] }],
    activeDeadends: [{ id: 'as_d1', kind: 'deadend', ts: '2026-11-04T09:00:00Z', body: '死'.repeat(80) }],
    budgetTokens: 55,
  })
  assert.ok(tightVeto.includes('- t-main (tp_aaaaaa)'), tightVeto)
  assert.ok(tightVeto.includes('✗ 已否决：被否的方案甲'), tightVeto) // 死路先丢，否决子行还在
  assert.ok(!tightVeto.includes('[死路'), tightVeto)
  const tighter = renderTail({
    stateBuckets: [{ topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '跑测试', vetoes: ['被否的方案甲'] }],
    budgetTokens: 45,
  })
  assert.ok(tighter.includes('- t-main (tp_aaaaaa)'), tighter)
  assert.ok(!tighter.includes('✗ 已否决'), tighter) // 再紧就丢否决子行，线本体留住

  // 死路 body 上限 100 字（线有 120 字上限，死路以前完全不截断，能挤掉进行中的线）
  const clippedDead = renderTail({
    activeDeadends: [{ id: 'as_d9', kind: 'deadend', ts: '2026-11-04T09:00:00Z', body: '死'.repeat(120) }],
    budgetTokens: 690,
  })
  assert.ok(clippedDead.includes('死'.repeat(100) + '…'), clippedDead)
  assert.ok(!clippedDead.includes('死'.repeat(101)), clippedDead)

  // 预算收紧时先丢死路、保住进行中的线（当前工作优先于历史教训）
  const deads = [1, 2, 3].map((n) => ({ id: 'as_d' + n, kind: 'deadend', ts: '2026-11-04T09:0' + n + ':00Z', body: '死'.repeat(100) }))
  const squeezed = renderTail({
    stateBuckets: [{ topicId: 'tp_aaaaaa', topicName: 't-main', ts: '2026-11-04T12:00:00Z', body: '已写 store', next: '跑测试' }],
    activeDeadends: deads,
    budgetTokens: 120,
  })
  assert.ok(squeezed.includes('- t-main (tp_aaaaaa)'), squeezed)
  assert.ok(!squeezed.includes('[死路'), squeezed)

  // 单条线的预算：body 到 120 字不截断（旧上限 60），超了才加省略号
  const longBody = '线'.repeat(100)
  const wide = renderTail({
    stateBuckets: [{ topicId: 'tp_eeeeee', topicName: 't-long', ts: '2026-11-04T11:00:00Z', body: longBody, next: 'y' }],
    budgetTokens: 690,
  })
  assert.ok(wide.includes('- t-long (tp_eeeeee)：' + longBody), wide)
  assert.ok(!wide.includes(longBody + '…'), wide)
  const clipped = renderTail({
    stateBuckets: [{ topicId: 'tp_eeeeee', topicName: 't-long', ts: '2026-11-04T11:00:00Z', body: '线'.repeat(130), next: 'y' }],
    budgetTokens: 690,
  })
  assert.ok(clipped.includes('线'.repeat(120) + '…'), clipped)
})

test('loadScope：目录还没记录 = error 空（正常），真读不出来 = error 非空（注入面据此保住旧前缀）', () => {
  const root = tmp()
  // 1) 还没有 assertions 目录：新建工作区，属正常
  assert.equal(loadScope(path.join(root, 'empty')).error, '')
  // 2) assertions 是文件不是目录：readdir 必失败（ENOTDIR），必须报出来而不是当成空库
  const broken = path.join(root, 'broken')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'assertions'), 'not a dir')
  const got = loadScope(broken)
  assert.equal(got.records.length, 0)
  assert.ok(got.error.length > 0, JSON.stringify(got))
})

test('指南索引：命中才出现', () => {
  const guides = [{ id: 'as_g1', kind: 'guide', ts: '2026-11-04T10:00:00Z', body: '发布前跑回归', criteria: 'pytest 全绿' }]
  const hit = renderTail({ activeGuides: guides, recentUserText: '发布前到底跑不跑回归？' })
  assert.ok(hit.includes('[指南索引] 1 条命中'))
  // 带 id：模型不必再猜关键词，直接把 as_xxx 传给 waystone_recall
  assert.ok(hit.includes('as_g1 发布前跑回归'), hit)
  assert.ok(hit.includes('把 id 传给 waystone_recall'), hit)
  assert.ok(!hit.includes('无进行中的线'), '指南命中但无线时也不补占位行：' + hit)
  const miss = renderTail({ activeGuides: guides, recentUserText: '今天天气怎么样' })
  assert.ok(!miss.includes('[指南索引]'))
})

test('死路窗口按轮次跳 3 轮转：7 轮内每条都出现，相邻两轮不重叠', () => {
  const dead = Array.from({ length: 7 }, (_, i) => ({ id: 'as_d' + i, ts: '2026-11-0' + (i + 1) + 'T00:00:00Z', body: '坑' + i }))
  const windows = []
  const seen = new Set()
  for (let t = 0; t < 7; t++) {
    const out = renderTail({ activeDeadends: dead, rotate: t, budgetTokens: 690 })
    const ids = [...out.matchAll(/as_d\d/g)].map((m) => m[0].slice(-1))
    windows.push(ids.join(','))
    for (const i of ids) seen.add(i)
  }
  // 旧行为是永远最新三条（6,5,4），最老的 3 条永远排不到
  assert.equal(windows[0], '6,5,4', '首轮取最新三条：' + windows[0])
  assert.equal(windows[1], '3,2,1', '第二轮跳 3 条、与首轮零重叠：' + windows[1])
  assert.equal(seen.size, 7, '7 轮内每条死路都该出现：' + windows.join(' | '))
})

test('时间戳：本地时间带偏移，Date.parse 可还原，且与旧 UTC 记录混排仍按瞬时正确', () => {
  const t = new Date(2026, 10, 5, 23, 25, 54, 123) // 本地 2026-11-05 23:25:54.123
  const s = nowIso(t)
  // 人读就是本地墙钟时间
  assert.equal(s.slice(0, 19), '2026-11-05T23:25:54')
  // 带偏移，机器解析不歧义
  assert.match(s, /[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(s), t.getTime(), 'Date.parse 必须还原同一瞬时')
  // 老数据是 UTC（Z），两种混排、按瞬时排序不能错位
  const mixed = ['2026-11-05T15:25:53.999Z', s, nowIso(new Date(t.getTime() + 1))]
  const sorted = [...mixed].sort((a, b) => Date.parse(a) - Date.parse(b))
  assert.equal(sorted[1], s)
  assert.equal(sorted[2], mixed[2])
})

test('readConfig：volatile 热改即时生效（活格子换值，不重启、不读文件）', () => {
  const cell = { v: 30, get() { return this.v } }
  assert.equal(readConfig({ rulesMax: cell }).config.rulesMax, 30)
  cell.v = 7 // 宿主热改：同一个活格子换值
  assert.equal(readConfig({ rulesMax: cell }).config.rulesMax, 7)
})
