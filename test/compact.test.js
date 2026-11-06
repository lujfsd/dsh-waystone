import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCompact, buildCompactInput, parseCompactOutput, pickMerges, shrinkTarget, meetsShrink, MIN_SHRINK, HARD_MIN_SHRINK, hardTarget, MAX_GROUPS, MERGE_BODY_MAX_CHARS, MAX_CONCLUSION, MAX_FACT } from '../lib/compact.js'
import { computeStatus, topicIdOf } from '../lib/schema.js'
import { CONFIG_DEFAULTS } from '../lib/store.js'

const rec = (id, kind, body, extra = {}) => ({ id, kind, body, ts: '2026-11-05T00:00:00Z', sid: 's', turn: 1, ...extra })

test('整理触发：只看阈值（可被配置覆盖），没有冷却', () => {
  assert.equal(shouldCompact({ conclusion: MAX_CONCLUSION - 1, fact: 0 }), false, '没超限不该整理')
  assert.equal(shouldCompact({ conclusion: MAX_CONCLUSION, fact: 0 }), true)
  assert.equal(shouldCompact({ conclusion: 0, fact: 40 }), true, 'fact 超限也触发')
  assert.equal(shouldCompact({ conclusion: 0, fact: 39 }), false)
  // 配置覆盖：阈值即触发线，等号算到；差一条不触发
  assert.equal(shouldCompact({ conclusion: 10, fact: 0 }, { conclusion: 10, fact: 40 }), true)
  assert.equal(shouldCompact({ conclusion: 9, fact: 0 }, { conclusion: 10, fact: 40 }), false, '9 < 10 不该整理')
  // 默认值必须与 store.CONFIG_FIELDS 的 fallback 一致，否则「没配」和「配了默认值」行为分叉
  assert.equal(CONFIG_DEFAULTS.compactConclusionMax, MAX_CONCLUSION)
  assert.equal(CONFIG_DEFAULTS.compactFactMax, MAX_FACT)
  assert.equal(CONFIG_DEFAULTS.compactBatch, 60)
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
  assert.ok(system.includes('≤ 8 条'), system)
  assert.ok(system.includes('40%') && system.includes('20%'), system)
  assert.ok(system.includes(MERGE_BODY_MAX_CHARS + ' 字'), '提示词要写死合并正文上限，模型不照做就整组白干：' + system)
  assert.ok(system.includes('提炼'), '要明确「合并是提炼不是拼接」：' + system)
})

test('合并正文上限 800：正好保留，超一字整组丢', () => {
  const limitPool = [rec('as_1', 'conclusion', '甲'), rec('as_2', 'conclusion', '乙')]
  assert.equal(pickMerges([{ kind: 'conclusion', body: '线'.repeat(MERGE_BODY_MAX_CHARS), merge: ['as_1', 'as_2'] }], limitPool).length, 1)
  assert.equal(pickMerges([{ kind: 'conclusion', body: '线'.repeat(MERGE_BODY_MAX_CHARS + 1), merge: ['as_1', 'as_2'] }], limitPool).length, 0)
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
