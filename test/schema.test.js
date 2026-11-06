import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRecord, computeStatus, cmpStrength, quotaVictim, strengthRank, factGate, BODY_MAX_CHARS,
} from '../lib/schema.js'

const probe = { lineSha256: () => undefined, fileExists: () => false }
const userMessages = ['以后都别用 pnpm，会把路径写脏', '这个项目的提交信息用中文']

const base = (over = {}) => ({
  v: 1,
  id: 'as_1a2b3c',
  ts: '2026-11-04T22:58:03+08:00',
  sid: 's-1',
  turn: 7,
  kind: 'rule',
  scope: 'workspace',
  body: '本机不用 pnpm',
  criteria: '出现 pnpm 命令即违规',
  anchor: { type: 'turn', sid: 's-1', turn: 7, quote: '以后都别用 pnpm' },
  source: { author: 'user', quote: '以后都别用 pnpm' },
  strength: 'user_said',
  ...over,
})

const code = (rec, ctx = { userMessages, probe }) => {
  const v = validateRecord(rec, ctx)
  return v.ok ? 'OK' : v.code
}

test('通过：rule 带原话与锚点', () => {
  assert.equal(code(base()), 'OK')
})

test('E_SCHEMA：缺 id / kind 未知 / scope 非法', () => {
  assert.equal(code(base({ id: undefined })), 'E_SCHEMA')
  assert.equal(code(base({ kind: 'note' })), 'E_SCHEMA')
  assert.equal(code(base({ scope: 'everywhere' })), 'E_SCHEMA')
})

test('E_BODY：超长或换行', () => {
  assert.equal(code(base({ body: 'x'.repeat(BODY_MAX_CHARS + 1) })), 'E_BODY')
  assert.equal(code(base({ body: 'x'.repeat(BODY_MAX_CHARS) })), 'OK', '上限是 ' + BODY_MAX_CHARS + ' 字，正好合法')
  assert.equal(code(base({ body: '第一行\n第二行' })), 'E_BODY')
})

test('E_ANCHOR_MISSING：kind 要求的锚点型不符', () => {
  // conclusion 现接受 turn（环境事实/判断锚在本轮对话，不绑文件行）
  assert.equal(code(base({ kind: 'conclusion', anchor: { type: 'turn', sid: 's-1', turn: 7, quote: 'q' } })), 'OK')
  assert.equal(code(base({ anchor: { type: 'file', path: 'a.js' } })), 'E_ANCHOR_MISSING')
})

test('E_ANCHOR_BAD：file 行不存在 / 指纹不符；url 缺 sha256', () => {
  const fileAnchor = { type: 'file', path: '/tmp/a.js', line: 3, quote: 'const a', sha256: 'deadbeef' }
  assert.equal(code(base({ kind: 'fact', anchor: fileAnchor, source: { author: 'model' } })), 'E_ANCHOR_BAD')
  assert.equal(code(base({ kind: 'fact', anchor: fileAnchor, source: { author: 'model' } }), {
    userMessages,
    probe: { lineSha256: () => 'ffff', fileExists: () => true },
  }), 'E_ANCHOR_BAD')
  assert.equal(code(base({
    kind: 'fact',
    anchor: { type: 'url', url: 'https://x', fetched_at: '2026-11-04T00:00:00Z' },
    source: { author: 'tool' },
  })), 'E_ANCHOR_MISSING')
})

test('E_QUOTE：rule 的原话不是本会话用户消息子串', () => {
  assert.equal(code(base({ source: { author: 'user', quote: '我从没说过这句' } })), 'E_QUOTE')
})

// 回归：conclusion/fact 的 quote 是"据以推断的依据原文"，不是用户原话，不该过 E_QUOTE。
test('E_QUOTE 只约束 rule/guide；conclusion 可引用命令输出作依据', () => {
  assert.equal(code(base({
    kind: 'conclusion',
    source: { author: 'tool', quote: 'wslc: command not found' },
    strength: 'measured',
  })), 'OK')
  const turnAnchor = { type: 'turn', sid: 's-1', turn: 7, quote: 'q' }
  assert.equal(code(base({ kind: 'fact', anchor: turnAnchor, source: { author: 'tool' } })), 'OK')
})

test('E_TOPIC：state 必须带合法 topic_id（tp_ + 6 位 hex）', () => {
  const st = (over = {}) => base({ kind: 'state', criteria: undefined, source: { author: 'model' }, next: '继续', topic_id: 'tp_0a0b0c', ...over })
  assert.equal(code(st()), 'OK')
  assert.equal(code(st({ topic_id: undefined })), 'E_TOPIC')
  assert.equal(code(st({ topic_id: '' })), 'E_TOPIC')
  assert.equal(code(st({ topic_id: 't-main' })), 'E_TOPIC')
  assert.equal(code(st({ topic_id: 'tp_ZZZZZZ' })), 'E_TOPIC')
  // 只有名字（旧协议）不再被接受
  assert.equal(code(st({ topic_id: undefined, topic: 't-main' })), 'E_TOPIC')
  // 其它 kind 不强制 topic_id
  assert.equal(code(base()), 'OK')
})

test('E_NEXT：state 缺 next，非 state 写了 next', () => {
  const st = base({ kind: 'state', criteria: undefined, source: { author: 'model' }, next: undefined, topic_id: 'tp_0a0b0c' })
  assert.equal(code(st), 'E_NEXT')
  assert.equal(code({ ...st, next: '继续跑测试' }), 'OK')
  assert.equal(code(base({ next: '继续' })), 'E_NEXT')
})

test('E_SCOPE：只有 rule 能进 global', () => {
  assert.equal(code(base({ scope: 'global' })), 'OK')
  assert.equal(code(base({ kind: 'state', scope: 'global', criteria: undefined, source: { author: 'model' }, next: 'x', topic_id: 'tp_0a0b0c' })), 'E_SCOPE')
})

test('四态计算：superseded / expired / active / closed', () => {
  const r1 = base({ id: 'as_000001', ts: '2026-11-04T10:00:00Z' })
  const r2 = base({ id: 'as_000002', ts: '2026-11-04T11:00:00Z', supersedes: 'as_000001' })
  const r3 = base({ id: 'as_000003', ts: '2026-11-04T12:00:00Z', retracts: 'as_000002' })
  const r4 = base({ id: 'as_000004', ts: '2026-11-04T13:00:00Z', kind: 'expire', target: 'as_000003' })
  const status = computeStatus([r1, r2, r3, r4])
  assert.equal(status.get('as_000001'), 'superseded')
  assert.equal(status.get('as_000002'), 'expired')
  assert.equal(status.get('as_000003'), 'expired')
  assert.equal(status.get('as_000004'), 'active')
})

// 数据治理时一次撤回多条，避免"撤一条写一条"把召回面塞满噪音。
test('retracts 收 id 数组：一条记录可撤回多条', () => {
  const a = base({ id: 'as_00000a', ts: '2026-11-04T10:00:00Z' })
  const b = base({ id: 'as_00000b', ts: '2026-11-04T10:01:00Z' })
  const c = base({ id: 'as_00000c', ts: '2026-11-04T10:02:00Z' })
  const killer = base({ id: 'as_00000d', ts: '2026-11-04T11:00:00Z', kind: 'conclusion', retracts: ['as_00000a', 'as_00000b'] })
  const status = computeStatus([a, b, c, killer])
  assert.equal(status.get('as_00000a'), 'expired')
  assert.equal(status.get('as_00000b'), 'expired')
  assert.equal(status.get('as_00000c'), 'active')
  assert.equal(status.get('as_00000d'), 'active')
})

test('closed：同 topic 最后一条 state 的 next 为空串才算完成，旧步骤仍是 superseded', () => {
  const st = (id, ts, topic, next, over = {}) => base({
    id, ts, topic, next, kind: 'state',
    criteria: undefined, source: { author: 'model' },
    ...over,
  })
  const done = st('as_100001', '2026-11-05T02:00:00Z', 't-a', '')
  const doing = st('as_100002', '2026-11-05T03:00:00Z', 't-b', '继续跑测试')
  const s = computeStatus([done, doing])
  assert.equal(s.get('as_100001'), 'closed')
  assert.equal(s.get('as_100002'), 'active')

  // 同一个 topic：后一步顶掉前一步，只有最后那条的 next 决定是否完成
  const step1 = st('as_100003', '2026-11-05T01:00:00Z', 't-c', '下一步')
  const step2 = st('as_100004', '2026-11-05T04:00:00Z', 't-c', '还没完', { supersedes: 'as_100003' })
  const s2 = computeStatus([step1, step2])
  assert.equal(s2.get('as_100003'), 'superseded')
  assert.equal(s2.get('as_100004'), 'active')

  // 闭环不是过期：没有 retract/expire 时不会变成 expired
  assert.notEqual(s.get('as_100001'), 'expired')
})

test('强度序按类别：rule 看用户原话，conclusion 看实测', () => {
  assert.ok(cmpStrength('rule', 'user_said', 'measured') > 0)
  assert.ok(cmpStrength('conclusion', 'measured', 'user_said') > 0)
  assert.ok(strengthRank('rule', 'user_said') > strengthRank('rule', 'inferred'))
})

test('配额淘汰：不超限不淘汰，超限淘汰最久未命中 + 最弱者', () => {
  const rules = [
    base({ id: 'as_00000a', strength: 'inferred' }),
    base({ id: 'as_00000b', strength: 'user_said' }),
    base({ id: 'as_00000c', strength: 'user_said' }),
  ]
  assert.equal(quotaVictim(rules, 30), null)
  const victim = quotaVictim(rules, 2, (id) => (id === 'as_00000a' ? 0 : 1))
  assert.equal(victim, 'as_00000a')
})

// 事实的唯一口径：长期不变、与代码实现无关。两类内容不许进 fact：
// L1 变更叙事（会变成 state 的事）——L2 代码坐标/构建产物（会随代码变的值）。
test('事实入库闸：L1 变更叙事、L2 代码坐标与构建产物一律拒收，并给改写方向', () => {
  // 该收的：环境/约束/路径
  assert.equal(factGate('本机未装 docker，容器一律用 wslc').ok, true)
  assert.equal(factGate('GitHub 出网必须走代理 http://127.0.0.1:7897').ok, true, 'IPv4 不能被版本号规则误杀')
  assert.equal(factGate('数据根 D:\\AppData\\waystone\\data，配置只来自 profile 的 patch').ok, true)

  // L1：变更叙事 → 建议写 state
  const l1 = factGate('判官并发由 2 改为 6，已落地')
  assert.equal(l1.ok, false)
  assert.equal(l1.code, 'L1')
  assert.equal(l1.suggest, 'state')

  // L2：代码坐标 / 构建产物 → 建议写 conclusion
  for (const body of [
    '代码锚点：topicIdOf() 在 schema.js:24-29',
    '宿主版本 0.2.2-rc.1',
    'npm pack 只收 15 files / 84.5 KB',
    '测试 100/100 通过',
    '判官超时 180 s',
  ]) {
    const g = factGate(body)
    assert.equal(g.ok, false, body + ' 应被拒')
    assert.equal(g.code, 'L2', body)
    assert.equal(g.suggest, 'conclusion', body)
  }
  assert.match(l1.message, /改写成 state/, '拒收必须带改写方向')
})
