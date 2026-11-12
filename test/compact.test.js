import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCompact, buildCompactInput, parseCompactOutput, pickMerges, pickBatch, shrinkTarget, meetsShrink, MIN_SHRINK, HARD_MIN_SHRINK, hardTarget, MAX_GROUPS, MERGE_BODY_MAX_CHARS, MERGE_BODY_PER_MEMBER, mergeBodyBudget, MAX_POOL } from '../lib/compact.js'
import { computeStatus, topicIdOf } from '../lib/schema.js'
import { CONFIG_DEFAULTS } from '../lib/store.js'

const rec = (id, kind, body, extra = {}) => ({ id, kind, body, ts: '2026-11-05T00:00:00Z', sid: 's', turn: 1, ...extra })

// formatMinute 按宿主机时区渲染（产品有意如此），断言里的分钟数就是"本机时间"。
// 用本地时间构造再转 ISO，UTC runner 上也得到同一个钟点；写死 +08:00 的 ISO 只在东八区绿。
const localAt = (h, m) => new Date(2026, 10, 6, h, m).toISOString()

test('整理触发：看池内总数（结论 + 事实），单一阈值，没有冷却', () => {
  assert.equal(shouldCompact(MAX_POOL - 1), false, '没超限不该整理')
  assert.equal(shouldCompact(MAX_POOL), true, '等号算到')
  assert.equal(shouldCompact(0), false)
  // 配置覆盖：阈值即触发线
  assert.equal(shouldCompact(10, 10), true)
  assert.equal(shouldCompact(9, 10), false)
  // 默认值必须与 store.CONFIG_FIELDS 的 fallback 一致，否则「没配」和「配了默认值」行为分叉
  assert.equal(CONFIG_DEFAULTS.compactPoolMax, MAX_POOL)
  assert.equal(CONFIG_DEFAULTS.compactBatch, 60)
  assert.equal(CONFIG_DEFAULTS.compactConclusionMax, undefined, '分 kind 的阈值已废止')
  assert.equal(CONFIG_DEFAULTS.compactFactMax, undefined)
})

test('净减目标：提示词目标 40%，落盘硬底线 20%（目标是目标，底线是底线）', () => {
  assert.equal(MIN_SHRINK, 0.4)
  assert.equal(HARD_MIN_SHRINK, 0.2)
  assert.equal(shrinkTarget(10), 6, '10 条目标砍到 6 条')
  assert.equal(shrinkTarget(60), 36)
  assert.equal(shrinkTarget(1), 1)
  assert.equal(hardTarget(60), 48, '60 条至少砍到 48 条才落盘')
  // 护栏：够硬底线才落盘
  assert.equal(meetsShrink({ before: 10, retracted: 2, added: 1 }), false, '10 → 9：连 20% 底线都不够')
  assert.equal(meetsShrink({ before: 10, retracted: 2, added: 0 }), true, '10 → 8：刚好够硬底线')
  assert.equal(meetsShrink({ before: 10, retracted: 5, added: 1 }), true, '10 → 6：达到目标')
  assert.equal(meetsShrink({ before: 60, retracted: 1, added: 1 }), false, '只省 0 条，等于没整理')
  // 提示词同时给出目标与底线，且都来自同一组常量的函数
  const { system } = buildCompactInput({ records: Array.from({ length: 10 }, (_, i) => rec('as_' + i, 'conclusion', '判断' + i)) })
  assert.ok(system.includes('≤ 6 条'), system)
  assert.ok(system.includes('最多 8 组'), system)
  assert.ok(system.includes('40%') && system.includes('20%'), system)
  assert.ok(system.includes(MERGE_BODY_MAX_CHARS + ' 字'), '提示词要写死合并正文上限，模型不照做就整组白干：' + system)
  assert.ok(system.includes(String(MERGE_BODY_PER_MEMBER) + ' 字'), '提示词要给出「成员数 × 120」的相对预算：' + system)
  assert.ok(system.includes('提炼'), '要明确「合并是提炼不是摘抄」：' + system)
  assert.ok(!system.includes('信息不许丢'), '「信息不许丢」会把模型推向拼接，已删除')
})

test('批次按池内构成分配：每类至少 1 个位子，批次装满', () => {
  const mk = (kind, n, prefix) => Array.from({ length: n }, (_, i) => ({ id: prefix + i, kind, body: 'x', ts: '2026-11-06T10:00:00+08:00' }))
  // 80 结论 + 10 事实：按构成分（60×80/90≈53 结论 / 7 事实）
  const pool = [...mk('conclusion', 80, 'as_c'), ...mk('fact', 10, 'as_f')]
  const batch = pickBatch(pool, { batch: 60 })
  assert.equal(batch.length, 60)
  assert.equal(batch.filter((r) => r.kind === 'fact').length, 7)
  assert.equal(batch.filter((r) => r.kind === 'conclusion').length, 53)

  // 事实极少时也必须进批次（旧实现踩过的坑：最新 60 条全是结论，一条事实都没有）
  const pool2 = [...mk('conclusion', 100, 'as_c'), ...mk('fact', 2, 'as_f')]
  const b2 = pickBatch(pool2, { batch: 60 })
  assert.equal(b2.filter((r) => r.kind === 'fact').length, 1, '事实再少也留 1 个位子')
  assert.equal(b2.length, 60)

  // 某类不够 → 余量给另一类
  const pool3 = mk('conclusion', 70, 'as_c')
  assert.equal(pickBatch(pool3, { batch: 60 }).length, 60)
  assert.equal(pickBatch(pool3, { batch: 200 }).length, 70, '池子不够就全送')
})

test('组内 kind 必须一致：fact 不能混进 conclusion 组（否则那条事实会被判过期而消失）', () => {
  const pool = [rec('as_1', 'conclusion', '判断'), rec('as_2', 'fact', '事实')]
  const dropped = []
  const ops = pickMerges([{ kind: 'conclusion', body: '合并后的判断', merge: ['as_1', 'as_2'] }], pool, dropped)
  assert.equal(ops.length, 0)
  assert.equal(dropped[0].code, 'E_KIND_MIX')
})

test('整理官输入带分钟级写入时间，并写明「kind 一致 / fact 取新 / 分不清不合」', () => {
  const { system, user } = buildCompactInput({
    records: [
      rec('as_1', 'conclusion', '判断甲', { ts: localAt(9, 0) }),
      rec('as_2', 'fact', '事实乙', { ts: localAt(10, 7) }),
    ],
  })
  assert.ok(user.includes('as_1 | conclusion | [] | 11-06 09:00 |'), user)
  assert.ok(user.includes('as_2 | fact | [] | 11-06 10:07 |'), user)
  assert.ok(system.includes('一组只能有一种 kind'), system)
  assert.ok(system.includes('fact 只留当前值'), system)
  assert.ok(system.includes('分不清就不合'), system)
  assert.ok(system.includes('结论 1 / 事实 1'), '批次构成要写进提示词：' + system)
})

test('合并正文预算 = min(800, 成员数 × 120)：2 条只给 240 字，超一字整组丢', () => {
  const limitPool = [rec('as_1', 'conclusion', '甲'), rec('as_2', 'conclusion', '乙')]
  assert.equal(mergeBodyBudget(2), 240, '2 条合并只值 240 字，模型写 800 就是没提炼')
  assert.equal(mergeBodyBudget(5), 600)
  assert.equal(mergeBodyBudget(9), MERGE_BODY_MAX_CHARS, '成员再多也封顶 800')
  assert.equal(pickMerges([{ kind: 'conclusion', body: '线'.repeat(240), merge: ['as_1', 'as_2'] }], limitPool).length, 1)
  assert.equal(pickMerges([{ kind: 'conclusion', body: '线'.repeat(241), merge: ['as_1', 'as_2'] }], limitPool).length, 0)
})

test('超长组只丢自己：同一批里合规的组照常合，超长组记进 dropped 且不 retract 来源', () => {
  const pool = [
    rec('as_1', 'conclusion', '甲'), rec('as_2', 'conclusion', '乙'),
    rec('as_3', 'fact', '丙'), rec('as_4', 'fact', '丁'),
  ]
  const dropped = []
  const ops = pickMerges([
    { kind: 'conclusion', body: '合规的合并', merge: ['as_1', 'as_2'] },
    { kind: 'fact', body: '超'.repeat(mergeBodyBudget(2) + 50), merge: ['as_3', 'as_4'] },
  ], pool, dropped)
  assert.equal(ops.length, 1, '合规组必须落盘，不能被超重组拖死')
  assert.deepEqual(ops[0].retracts, ['as_1', 'as_2'], '超长组的来源不能被 retract，下一轮还要重试')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].code, 'E_BODY_GROUP')
  assert.equal(dropped[0].merges, 2)
  assert.equal(dropped[0].max, mergeBodyBudget(2), '记的应是这一组自己的预算，不是全局 800')
  assert.ok(dropped[0].chars > dropped[0].max, '要记下实际字数，否则看不出差多少')
})

test('整理官输出：剥代码块、取第一个 JSON 对象', () => {
  const out = parseCompactOutput('```json\n{"groups":[{"kind":"fact","body":"x","merge":["a","b"]}]}\n```')
  assert.equal(out.groups.length, 1)
  assert.deepEqual(parseCompactOutput('{"groups":[]}').groups, [])
  assert.throws(() => parseCompactOutput('不是 JSON'))
})

test('合并校验：不合格的组整组丢掉，不修补', () => {
  const pool = [
    rec('as_1', 'conclusion', '判断甲'),
    rec('as_2', 'conclusion', '判断乙', { topic: '线A', source: { quote: '用户原话原句' } }),
    rec('as_3', 'conclusion', '判断丙'),
    rec('as_4', 'fact', '事实甲'),
    rec('as_5', 'fact', '事实乙'),
  ]
  const groups = [
    { kind: 'conclusion', body: '合并后的判断甲乙', merge: ['as_1', 'as_2'] },
    { kind: 'fact', body: '只给一个 id 不算合并', merge: ['as_4'] }, // 丢
    { kind: 'conclusion', body: '不存在的 id', merge: ['as_1', 'as_nope'] }, // 丢（未知 id）
    { kind: 'conclusion', body: '复用已用过的 id', merge: ['as_1', 'as_3'] }, // 丢（跨组复用）
    { kind: 'rule', body: '不许碰其它 kind', merge: ['as_4', 'as_5'] }, // 丢（kind 非法）
    { kind: 'fact', body: '线'.repeat(MERGE_BODY_MAX_CHARS + 1), merge: ['as_4', 'as_5'] }, // 丢（body 超长）
  ]
  const ops = pickMerges(groups, pool)
  assert.equal(ops.length, 1, JSON.stringify(ops))
  assert.equal(ops[0].kind, 'conclusion')
  assert.deepEqual(ops[0].retracts, ['as_1', 'as_2'])
  assert.equal(ops[0].topic, '线A', '没给 topic 时继承被合并记录里的组名')
  assert.equal(ops[0].quote, '用户原话原句', '没给 quote 时从被合并记录的依据里取')
  assert.equal(ops[0].strength, 'inferred')

  // 跨 topic 的同一件事允许合并（group 自带 topic 就以它为准）
  const cross = pickMerges([{ kind: 'fact', body: '同一件事', topic: '归并后的组名', merge: ['as_4', 'as_5'] }], pool)
  assert.equal(cross[0].topic, '归并后的组名')
  assert.equal(cross[0].quote, '事实甲', '都没有依据时用正文兜底，保证 schema 的 source.quote 必填能过')
})

test('合并结果落盘后：被 merge 的旧记录变 expired，新记录存活（信息不删，只是不进默认召回）', () => {
  const old = [rec('as_1', 'conclusion', '甲'), rec('as_2', 'conclusion', '乙')]
  const merged = rec('as_9', 'conclusion', '甲乙', { retracts: ['as_1', 'as_2'] })
  const status = computeStatus([...old, merged])
  assert.equal(status.get('as_1'), 'expired')
  assert.equal(status.get('as_2'), 'expired')
  assert.equal(status.get('as_9'), 'active')
})

test('整理官输入带上 id/kind/topic/正文/依据，模型才抄得准 id', () => {
  const { user, system } = buildCompactInput({ records: [rec('as_1', 'conclusion', '判断甲', { topic: '线A', source: { quote: '原话' } })] })
  assert.ok(user.includes('as_1') && user.includes('conclusion') && user.includes('线A') && user.includes('原话'), user)
  assert.ok(system.includes('merge') && system.includes('最多 ' + MAX_GROUPS + ' 组'), system)
})

test('被否决记录进合并队列：只允许「同为已否决 + 同一条线」成组', () => {
  const pool = [
    rec('as_11', 'conclusion', '否掉方案甲：太慢', { suspect: ['vetoed'], topic: '线A', source: { quote: '别用甲' } }),
    rec('as_12', 'conclusion', '否掉方案甲：太慢（重复记了一遍）', { suspect: ['vetoed'], topic: '线A' }),
    rec('as_13', 'conclusion', '普通结论', { topic: '线A' }),
    rec('as_14', 'conclusion', '另一条线被否的方案乙', { suspect: ['vetoed'], topic: '线B' }),
  ]
  const { user } = buildCompactInput({ records: [pool[0]] })
  assert.ok(user.includes('（已否决）'), '输入没标出被否决，模型没法按规则 9 分组：' + user)
  const ops = pickMerges([
    { kind: 'conclusion', body: '混组：否决+普通', merge: ['as_11', 'as_13'] }, // 丢：会把否决糊到普通结论上
    { kind: 'conclusion', body: '跨线合并', merge: ['as_11', 'as_14'] }, // 丢：合完挂不回任何一条线
    { kind: 'conclusion', body: '否掉了方案甲（太慢），两次记录合并', merge: ['as_11', 'as_12'] }, // 收
  ], pool)
  assert.equal(ops.length, 1, JSON.stringify(ops))
  assert.equal(ops[0].topic, '线A')
  assert.deepEqual(ops[0].suspect, ['vetoed'], '合并结果丢了否决标记')
  assert.equal(ops[0].topicId, topicIdOf(pool[0]), '合并结果丢了 topic_id，会挂不回线')
})
