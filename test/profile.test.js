import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILE_MAX_CHARS, profileHash, buildProfileInput, parseProfileOutput, pickProfile, attachSources } from '../lib/profile.js'
import { validateRecord } from '../lib/schema.js'
import { renderTail } from '../lib/render.js'

const fact = (id, body, extra = {}) => ({ id, kind: 'fact', body, ts: '2026-11-05T00:00:00Z', ...extra })

test('档案指纹：与事实顺序无关，任一 body 变化就变', () => {
  const a = [fact('as_1', '构建：node --test'), fact('as_2', '容器：wslc')]
  const b = [fact('as_2', '容器：wslc'), fact('as_1', '构建：node --test')]
  assert.equal(profileHash(a), profileHash(b), '顺序不该触发重生成')
  assert.notEqual(profileHash(a), profileHash([fact('as_1', '构建：pnpm test'), fact('as_2', '容器：wslc')]))
})

test('档案输出：剥代码块、skip 语义、非法 JSON 抛错', () => {
  assert.equal(parseProfileOutput('```json\n{"body":"构建用 node --test"}\n```').body, '构建用 node --test')
  assert.equal(parseProfileOutput('{"skip":true}').skip, true)
  assert.throws(() => parseProfileOutput('不是 JSON'))
  assert.equal(parseProfileOutput('{"body":1}').body, '', '非字符串 body 当空处理，交给 pickProfile 丢')
})

test('档案校验：空 / 超长 / 多行保留，不合格返回 null', () => {
  const NL = String.fromCharCode(10)
  assert.equal(pickProfile({ skip: true }), null)
  assert.equal(pickProfile({ body: '   ' }), null)
  assert.equal(pickProfile({ body: 'x'.repeat(PROFILE_MAX_CHARS + 1) }), null)
  const multi = pickProfile({ body: '1) 构建：node --test' + String.fromCharCode(13) + NL + '2) 测试：同上' })
  assert.ok(multi && multi.body.includes(NL), '档案按主题分行，换行要保留')
  assert.ok(!multi.body.includes(String.fromCharCode(13)), 'CRLF 归一成 LF')
  assert.equal(pickProfile({ body: 'a' + NL + NL + NL + NL + 'b' }).body, 'a' + NL + NL + 'b', '三连空行最多留一空行')
})

test('档案输入：带上 fact 正文、id 与上限', () => {
  const { system, user } = buildProfileInput({ facts: [fact('as_1', '构建：node --test', { topic: '构建' })], project: 'dsh-waystone' })
  assert.ok(user.includes('as_1') && user.includes('构建：node --test') && user.includes('dsh-waystone'), user)
  assert.ok(system.includes(String(PROFILE_MAX_CHARS)), system)
  assert.ok(system.includes('不得推断'), system)
  assert.ok(system.includes('提炼') && system.includes('1500'), '档案提示词要写清「提炼不是拼接」与长度目标：' + system)
})

test('来源 id：插件确定性拼接（去重、无 id 不加行、总长不超上限）', () => {
  const facts = [{ id: 'as_aaaaaa' }, { id: 'as_bbbbbb' }, { id: 'as_aaaaaa' }]
  const body = attachSources('1) 构建：node --test', facts)
  assert.ok(body.endsWith('来源：as_aaaaaa as_bbbbbb'), body)
  assert.equal(attachSources('x', []), 'x', '没有来源就不加这一行')
  const long = attachSources('构'.repeat(PROFILE_MAX_CHARS), facts)
  assert.ok([...long].length <= PROFILE_MAX_CHARS, '加了来源行也不能超上限')
})

test('档案记录单独放宽 body 上限与换行，普通写入路径仍是 500 字单行', () => {
  const rec = {
    v: 1, id: 'as_abcdef', ts: '2026-11-05T00:00:00Z', sid: 's', turn: 1, kind: 'fact',
    body: '构'.repeat(PROFILE_MAX_CHARS), suspect: ['profile'], topic: '项目档案',
    anchor: { type: 'turn', sid: 's', turn: 1, quote: 'q' },
  }
  assert.equal(validateRecord(rec, { maxBody: PROFILE_MAX_CHARS }).ok, true)
  assert.equal(validateRecord({ ...rec, body: '构'.repeat(PROFILE_MAX_CHARS + 1) }, { maxBody: PROFILE_MAX_CHARS }).code, 'E_BODY')
  assert.equal(validateRecord(rec).code, 'E_BODY', '不走档案通道就必须守 500 字')
  const multi = { ...rec, body: '1) 构建\n2) 测试' }
  assert.equal(validateRecord(multi).code, 'E_BODY', '普通写入仍然禁多行')
  assert.equal(validateRecord(multi, { maxBody: PROFILE_MAX_CHARS, allowNewlines: true }).ok, true)
})

test('注入：有档案才出 [项目档案] 段，且不挤掉交接与死路', () => {
  const stateBuckets = [{
    id: 'as_s1', topicId: 'tp_abcdef', topicName: '线', body: '在做', next: '下一步', closed: false, ts: '2026-11-05T00:00:00Z',
  }]
  const deadends = [fact('as_d1', '死路甲'), fact('as_d2', '死路乙')]
  const none = renderTail({ stateBuckets, activeDeadends: deadends, budgetTokens: 500 })
  assert.ok(!none.includes('[项目档案]'), '没档案不该出段')

  const profile = '构'.repeat(PROFILE_MAX_CHARS)
  const out = renderTail({ stateBuckets, activeDeadends: deadends, profile, budgetTokens: 500 })
  assert.ok(out.includes('[项目档案]'), out)
  assert.ok(out.includes('[交接]'), '档案不该挤掉交接')
  assert.ok(out.includes('[死路 · 别重试]'), '档案不该挤掉死路')
  assert.ok(out.indexOf('[项目档案]') < out.indexOf('[交接]'), '档案在交接之前')
})
