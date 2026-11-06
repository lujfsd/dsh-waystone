import test from 'node:test'
import assert from 'node:assert/strict'
import { isInjectedMessage, textOfStreamFrame, RECORD_PROPERTIES } from '../lib/index.js'
import { buildJudgeInput, capNarrative, callJudge } from '../lib/judge.js'
import { computeStatus } from '../lib/schema.js'
import { CONTRACT } from '../lib/contract.js'

// 回归：两个并发会话 45 秒内各写了一条同义死路（as_f8bf2b / as_22b40a，bigram 相似度 0.65）。
// 判官当时看不到已有死路，只能重复写；把现成的摆进输入，让它自己认。
test('判官输入带现有死路清单（最多 8 条、每条截 80 字），换措辞的同一件事才不会被重复写', () => {
  const deadends = Array.from({ length: 10 }, (_, i) => ({ id: 'as_d' + i, body: '坑 ' + i + ' ' + 'x'.repeat(95) }))
  const { system, user } = buildJudgeInput({ deadends })
  assert.ok(user.includes('【现有死路'), user.slice(0, 400))
  assert.ok(user.includes('as_d0'))
  assert.ok(!user.includes('as_d8'), '只摆最新 8 条')
  assert.ok(!user.includes('x'.repeat(85)), '每条截到 80 字，别把判官输入撑爆')
  assert.ok(buildJudgeInput({}).user.includes('（无）'))
  // 同一件事有新情况 → 不是拒写，是 supersedes 旧 id（用户更正：万一是新情况）
  assert.ok(system.includes('有新情况'))
  assert.ok(system.includes('supersedes'))
  // 旧记录被取代后不再进注入（只留库里 recall(include_expired)）
  const old = { id: 'as_old', kind: 'deadend', body: '旧', ts: '2026-11-05T01:00:00Z', sid: 's', turn: 1 }
  const next = { id: 'as_new', kind: 'deadend', body: '旧+新', ts: '2026-11-05T02:00:00Z', sid: 's', turn: 2, supersedes: 'as_old' }
  const status = computeStatus([old, next])
  assert.equal(status.get('as_old'), 'superseded')
  assert.equal(status.get('as_new'), 'active')
})

test('判官输入带现有 fact（最多 20 条、每条截 80 字、带分钟级时间），并教它用 supersedes 更新旧事实', () => {
  const facts = Array.from({ length: 25 }, (_, i) => ({ id: 'as_f' + i, body: '事实 ' + i + ' ' + 'y'.repeat(95), ts: '2026-11-06T10:07:09+08:00' }))
  const { system, user } = buildJudgeInput({ facts })
  assert.ok(user.includes('【现有 fact'), user.slice(0, 400))
  assert.ok(user.includes('as_f0'))
  assert.ok(user.includes('as_f0（11-06 10:07）'), '新旧判断全靠写入时间，必须摆进输入：' + user.slice(0, 500))
  assert.ok(!user.includes('as_f20'), '只摆最新 20 条')
  assert.ok(!user.includes('y'.repeat(85)), '每条截到 80 字，别把判官输入撑爆')
  assert.ok(system.includes('写 fact 前对照'), system)
  assert.ok(system.includes('supersedes'), system)
})

// 回归：判官会把"本轮改了什么/讨论经过"写成 conclusion，一天能堆 47 条流水账；
// 而这些 kind 从不进上下文（只写不读）。确定性闸门：每轮 conclusion/fact 各至多 1 条。
test('结论/事实每轮各至多 1 条，其余在写盘前丢弃；其它 kind 不受影响', () => {
  const recs = [
    { kind: 'state', id: 'a' },
    { kind: 'conclusion', id: 'c1' },
    { kind: 'fact', id: 'f1' },
    { kind: 'conclusion', id: 'c2' },
    { kind: 'fact', id: 'f2' },
    { kind: 'deadend', id: 'd1' },
    { kind: 'conclusion', id: 'c3' },
  ]
  assert.deepEqual(capNarrative(recs).map((r) => r.id), ['a', 'c1', 'f1', 'd1'])
  assert.equal(capNarrative([]).length, 0)
  assert.equal(capNarrative(null).length, 0)
  assert.equal(capNarrative(recs, 2).filter((r) => r.kind === 'conclusion').length, 2)
})

// 回归：宿主 assistant-stream 帧只有 start/chunk/end，文本在 chunk.chunk.text。
// 旧实现按 frame.type === 'text-delta' 取，永远取不到 ⇒ 判官输入里的助手摘要恒空。
test('助手文本只从 chunk.chunk.text 取，其它帧一律忽略', () => {
  assert.equal(textOfStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', text: '改完了' } }), '改完了')
  assert.equal(textOfStreamFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'think' } }), '')
  assert.equal(textOfStreamFrame({ type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta: '{}' } }), '')
  assert.equal(textOfStreamFrame({ type: 'start', turn: 1, step: 1 }), '')
  assert.equal(textOfStreamFrame({ type: 'end', index: 7 }), '')
  assert.equal(textOfStreamFrame(undefined), '')
})

// 回归：runtime-context 快照走结构标记，不靠匹配文案（宿主改文案不会让过滤静默失效）。
test('runtime-context 快照被认成注入消息，真用户消息不被误杀', () => {
  assert.equal(isInjectedMessage({ source: { kind: 'runtime-context' }, content: [] }), true)
  assert.equal(isInjectedMessage({ source: { kind: 'user' } }), false)
  assert.equal(isInjectedMessage({}), false)
  assert.equal(isInjectedMessage(undefined), false)
})

// 回归：用户消息段保留尾部。旧实现从头截断，前置噪音一多，最新指令整段被砍掉。
test('判官输入保留最新用户话，不被前置长噪音吃掉', () => {
  const noise = 'Current runtime context. ' + 'x'.repeat(3000)
  const real = '以后都别用 pnpm，会把路径写脏'
  const { user } = buildJudgeInput({ userMessages: [noise, real] })
  assert.ok(user.includes(real), '最新用户消息必须出现在判官输入里')
})

// 回归：scope 判据必须真的进判官 system，否则判官只能靠字面猜 global/workspace。
test('判官 system 带 scope 判据', () => {
  const { system } = buildJudgeInput({})
  assert.ok(system.includes('以后都/所有项目/每台机器/禁止'))
  assert.ok(system.includes('具体项目/目录/文件/命令/工具链'))
})

// 回归：rule 只收「以后都这么办」的承诺；改这一次的 UI 定稿是决策，别占规约配额。
test('判官 system 带承诺强度判据', () => {
  const { system } = buildJudgeInput({})
  assert.ok(system.includes('承诺强度'))
  assert.ok(system.includes('改这一版'))
})

// 回归：约束"产品形状"的需求由代码和测试承载，不该再占规约配额。
test('判官 system 带约束对象判据', () => {
  const { system } = buildJudgeInput({})
  assert.ok(system.includes('约束对象'))
  assert.ok(system.includes('能在测试或代码里被拦住'))
})

// 回归：契约把"纠正"也算 rule 触发时，判官会说另一套；两处口径必须同时存在。
test('判官 system 与契约同口径：一次性改法不写 rule；弱判据自报 suspect', () => {
  const { system } = buildJudgeInput({})
  assert.ok(system.includes('只是让你改这一版'))
  assert.ok(system.includes('criteria_weak'))
})

// 回归：原话是疑问句/评价句/单次纠正时不得升格成 rule —— 三处「教模型怎么用」的定义必须同口径，
// 只改一处就会出现"判官照写、工具描述照收、契约却不认"的分裂（存量 4 条就是这样混进规约段的）。
test('rule 判据含「原话须是命令句」，契约 / 工具描述 / 判官三处同步', () => {
  const { system } = buildJudgeInput({})
  for (const [where, text] of [['判官', system], ['契约', CONTRACT], ['工具描述', RECORD_PROPERTIES.kind.description]]) {
    assert.ok(text.includes('疑问句'), where + ' 缺「疑问句」判据')
    assert.ok(text.includes('评价句'), where + ' 缺「评价句」判据')
  }
})

// 回归：guide 是"能照着跑的有序步骤"，不是约束/原则/一次性改动记录——三处口径必须同步。
// 存量 3 条 guide 有 2 条不是步骤（一条是检查清单、一条是操作许可），就是这样进来的。
test('guide 判据含「有序步骤/检查点」，契约 / 工具描述 / 判官三处同步', () => {
  const { system } = buildJudgeInput({})
  for (const [where, text] of [['判官', system], ['契约', CONTRACT], ['工具描述', RECORD_PROPERTIES.kind.description]]) {
    assert.ok(text.includes('检查点'), where + ' 缺「检查点」判据')
    assert.ok(text.includes('一次性改动记录'), where + ' 缺「一次性改动记录不算 guide」判据')
  }
})

// 回归：deadend 被写成了「已修复的代码缺陷」和「关于记忆写法的元讨论」（as_47a710）。
// 判据收窄成只收外部世界不按预期的教训——三处口径必须同步。
test('deadend 判据排除「已修复缺陷 / 元讨论」，契约 / 工具描述 / 判官三处同步', () => {
  const { system } = buildJudgeInput({})
  for (const [where, text] of [['判官', system], ['契约', CONTRACT], ['工具描述', RECORD_PROPERTIES.kind.description]]) {
    assert.ok(text.includes('已修复的代码缺陷'), where + ' 缺「已修复的代码缺陷不算死路」判据')
    assert.ok(text.includes('关于记忆系统自身写法的反思'), where + ' 缺「元讨论不算死路」判据')
  }
})

// 回归（2026-11-06）：整理官一次 104 s 后返回零字符，报「输出不是 JSON」像解析问题，其实是模型没写。
// 空输出要重试一次；两次都空就把 finish/usage 带进错误文案，别让人再靠猜。
test('callJudge：空输出重试一次，仍空则报「空文本」并带 finish', async () => {
  let calls = 0
  const flaky = {
    async *stream() {
      calls += 1
      if (calls === 1) return
      yield { type: 'text-delta', text: '{"groups":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const selection = { provider: 'p', model: 'm' }
  const out = await callJudge({ llm: flaky, selection, input: { system: 's', user: 'u' } })
  assert.equal(out, '{"groups":[]}')
  assert.equal(calls, 2, '空输出必须重试一次')

  const silent = { async *stream() { yield { type: 'finish', reason: { kind: 'length' } } } }
  await assert.rejects(
    () => callJudge({ llm: silent, selection, input: { system: 's', user: 'u' } }),
    /空文本（finish=length/,
  )
})
