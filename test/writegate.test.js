import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { judgeScope, alignedQuote, pickQuoteTwin, pickTwin, edgeAllowed, entSeq, scopeMarkerOf } from '../lib/schema.js'
import { callJudge } from '../lib/judge.js'

/** 最小 Cordis 上下文替身（与 test/plugin.test.js 同构，只实现本插件用到的表面）。 */
function makeCtx(baseDir, services = {}) {
  const sections = []
  const contexts = []
  const tools = []
  const handlers = new Map()
  const routes = []
  const ctx = {
    baseDir,
    systemPrompt: {
      section(s) { sections.push(s); return () => {} },
      context(c) { contexts.push(c); return () => {} },
    },
    tools: { register(d) { tools.push(d); return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    inject(_names, cb) { cb(this) },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    get(name) { return services[name] },
    effect(fn) { fn(); return () => {} },
    fire(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args) },
  }
  ctx._sections = sections
  ctx._contexts = contexts
  ctx._tools = tools
  ctx._routes = routes
  return ctx
}

function toolOf(ctx, name) {
  const t = ctx._tools.find((x) => x.name === name)
  assert.ok(t, '未注册工具：' + name)
  return t
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-gate-'))
}

/** 递归找某个目录下所有 jsonl 的内容（断言落盘副作用用）。 */
function jsonlText(dir) {
  let out = ''
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out += fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

/** 造一个「用户说了某句原话」的会话：lastTurn 与 userMessageTurns 同步推进。 */
function say(ctx, agent, turn, text) {
  ctx.fire('agent/inbox/claimed', { agent, turn, message: { role: 'user', content: [{ type: 'text', text }] } })
}

const RULE_A = '用户要求把 ~/.dsh/AGENTS.md 里「## 5. 代码检索」整段删除，理由是模型默认会用 grep，不需要该规则。已删并将原 6/7 顺延为 5/6、§4 内「见 §7」同步改「见 §6」。'
const RULE_B = '用户要求把 ~/.dsh/AGENTS.md 里「## 5. 代码检索」整段删除，理由是模型默认会用 grep、不需要这条规则。已删；原 6/7 顺延为 5/6，§4 内「见 §7」同步改「见 §6」。'
const QUOTE = '把AGENTS.md中的“代码检索” 整段都删掉吧，模型默认会用grep'

// ─────────────────────── 1. scope 裁决（判定表） ───────────────────────

test('judgeScope：只有明说跨项目范围才升，长期词/局部限定/否定/历史/疑问一律降级', () => {
  const base = (quote) => ({ kind: 'rule', scope: 'global', source: { quote }, anchor: { type: 'turn', turn: 2, sid: 's', quote } })
  const ctx = (msgs) => ({ messages: msgs, turns: msgs.map(() => 2), lastTurn: 2 })
  const cases = [
    // 必须降级（误升是那两条规则误进全局库的同类损害）
    ['把AGENTS.md中的“代码检索” 整段都删掉吧', 'workspace'],
    ['以后都别用 pnpm', 'workspace'],
    ['禁止修改代码文件', 'workspace'],
    ['不是所有项目，只这一个仓库', 'workspace'],
    ['全局规则里别加这条', 'workspace'],
    ['以前所有项目都用过 pnpm 但现在只这个仓库用', 'workspace'],
    ['跨项目的坑记一下', 'workspace'],
    ['以后都在提交前跑一下测试', 'workspace'],
    ['所有项目里只有这个仓库用 pnpm', 'workspace'],
    ['是不是所有项目都要这样', 'workspace'],
    ['这台机器上都别用 pnpm', 'workspace'], // 局部限定优先：没有明说"所有机器/每台机器"
    // 必须升格（正向证据齐全）
    ['所有项目都别用 pnpm', 'global'],
    ['所有项目一律禁止用 pnpm', 'global'],
    ['每个项目都要过 node --test', 'global'],
    ['跨项目统一用 pnpm', 'workspace'], // 「跨项目」不构成显式作用域词
    ['全局规则里加一条：所有项目都用 pnpm', 'global'],
    ['applies across all my projects', 'global'],
    ['Every repo must run node --test', 'global'],
  ]
  for (const [quote, want] of cases) {
    const got = judgeScope(base(quote), ctx([quote]))
    assert.equal(got.scope, want, quote + ' → ' + got.scope + '（' + got.reason + '）')
  }
})

test('judgeScope：只认本轮原话（历史轮与未对齐的片段都不算）', () => {
  const rec = (quote, turn) => ({ kind: 'rule', scope: 'global', source: { quote }, anchor: { type: 'turn', turn, sid: 's', quote } })
  // 同一句原话，但它是上一轮说的
  const old = judgeScope(rec('所有项目都别用 pnpm', 1), { messages: ['所有项目都别用 pnpm'], turns: [1, 2], lastTurn: 2 })
  assert.equal(old.scope, 'workspace')
  assert.match(old.reason, /本轮/)
  // 本轮没说过 → 不升
  const none = judgeScope(rec('所有项目都别用 pnpm', 2), { messages: ['别的东西'], turns: [2], lastTurn: 2 })
  assert.equal(none.scope, 'workspace')
  // 片段冒充整句 → 不升
  const frag = judgeScope(rec('所有项目', 2), { messages: ['我不是说所有项目，只是这一个仓库'], turns: [2], lastTurn: 2 })
  assert.equal(frag.scope, 'workspace')
  // 本轮明说，且是完整分句 → 升
  const ok = judgeScope(rec('所有项目都别用 pnpm', 2), { messages: ['先说个事。所有项目都别用 pnpm，会把路径写脏'], turns: [2], lastTurn: 2 })
  assert.equal(ok.scope, 'global')
})

test('alignedQuote / scopeMarkerOf / entSeq 的边界', () => {
  assert.equal(alignedQuote('以后都别用 pnpm', ['以后都别用 pnpm，会把路径写脏']), true, '逗号分隔的分句也算对齐')
  assert.equal(alignedQuote('别用 pnpm', ['以后都别用 pnpm，会把路径写脏']), false)
  assert.equal(alignedQuote('', ['x']), false)
  assert.equal(scopeMarkerOf('所有仓库统一'), '所有仓库')
  assert.equal(scopeMarkerOf('以后都别用 pnpm'), '')
  assert.deepEqual(entSeq(RULE_A), entSeq(RULE_B), '本案两条 body 的实体序列完全相同')
  assert.notDeepEqual(entSeq('依赖统一用 pnpm'), entSeq('依赖统一用 yarn'))
})

// ─────────────────────── 2. 端到端：scope 闸 ───────────────────────

test('端到端：rule+global 没有跨项目证据 → 照写但降级到本工作区，且可见', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-gate-1', session: { id: 's-gate-1', header: { cwd: work } } }
  say(ctx, agent, 2, QUOTE)
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', scope: 'global', body: RULE_A, criteria: 'AGENTS.md 出现代码检索章节即违规',
      anchor: { type: 'turn' }, source: { author: 'user', quote: QUOTE }, strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 1, '降级不等于拒写')
  assert.ok(w.warnings.some((x) => x.code === 'scope_downgraded'), JSON.stringify(w.warnings))
  const all = jsonlText(home)
  assert.ok(!all.includes('"scope":"global"'), '全局库里不该出现这条：' + all)
  assert.ok(all.includes('scope_downgraded'), 'suspect 要落盘，否则页面上看不出来')
})

test('端到端：用户明说「所有项目」的完整分句 → 真的进全局库', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-gate-2', session: { id: 's-gate-2', header: { cwd: work } } }
  const quote = '所有项目都别用 pnpm'
  say(ctx, agent, 3, quote)
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', scope: 'global', body: '所有项目统一用 pnpm，禁用 npm', criteria: '任一项目出现 npm 命令即违规',
      anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.accepted.length, 1, JSON.stringify(w.rejected))
  assert.ok(!w.warnings.some((x) => x.code === 'scope_downgraded'), JSON.stringify(w.warnings))
  assert.ok(jsonlText(home).includes('"scope":"global"'))
})

// ─────────────────────── 3. 端到端：同引文更新（D1） ───────────────────────

test('端到端：同一句原话下的同 kind 同 scope 规则 → 新条取代旧条，注入面只剩一条', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-d1', session: { id: 's-d1', header: { cwd: work } } }
  say(ctx, agent, 2, QUOTE)
  const base = { kind: 'rule', criteria: 'AGENTS.md 出现代码检索章节即违规', anchor: { type: 'turn' }, source: { author: 'user', quote: QUOTE }, strength: 'user_said' }
  const w1 = await toolOf(ctx, 'waystone_write').execute({ records: [{ ...base, body: RULE_A }] }, { agent })
  const w2 = await toolOf(ctx, 'waystone_write').execute({ records: [{ ...base, body: RULE_B }] }, { agent })
  assert.equal(w1.accepted.length, 1)
  assert.equal(w2.accepted.length, 1, JSON.stringify(w2.rejected))
  assert.ok(w2.warnings.some((x) => x.code === 'quote_update'), JSON.stringify(w2.warnings))
  const recall = await toolOf(ctx, 'waystone_recall').execute({ query: '代码检索', kind: 'rule' }, { agent })
  const lines = JSON.stringify(recall)
  assert.equal((lines.match(/代码检索/g) || []).length >= 1, true)
  // 旧条必须已 superseded：默认召回里只剩新条
  const active = lines.split('as_').length - 1
  assert.equal(active, 1, '注入/召回面只该剩一条：' + lines)
})

test('D1 不跨 kind、不跨 scope、不吞实体不同的同句双规则', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-d1-2', session: { id: 's-d1-2', header: { cwd: work } } }
  const quote = '以后都别用 pnpm，会把路径写脏'
  say(ctx, agent, 2, quote)
  // 同 quote 的两条不同规则（实体不同）必须都活下来
  const w1 = await toolOf(ctx, 'waystone_write').execute({
    records: [
      { kind: 'rule', body: '依赖安装统一用 pnpm', criteria: '出现 npm install 即违规', anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'user_said' },
      { kind: 'rule', body: '提交信息一律用中文', criteria: '提交信息出现英文整句即违规', anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'user_said' },
    ],
  }, { agent })
  assert.equal(w1.accepted.length, 2, JSON.stringify(w1.rejected))
  assert.ok(!w1.warnings.some((x) => x.code === 'quote_update'), JSON.stringify(w1.warnings))
  // conclusion 用同一句 quote 做依据：D1 只收 rule/guide
  const w2 = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'conclusion', body: 'pnpm 会把路径写脏', anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'measured' }],
  }, { agent })
  assert.equal(w2.accepted.length, 1)
  assert.ok(!w2.warnings.some((x) => x.code === 'quote_update'), JSON.stringify(w2.warnings))
})

test('pickQuoteTwin 单元：跨 scope / 实体为空 / 显式 supersedes 都不命中', () => {
  const q = '所有项目都别用 pnpm'
  const old = { id: 'as_aaaaaa', kind: 'rule', _scope: 'global', ts: '2026-01-01T00:00:00+08:00', body: '所有项目统一 pnpm', source: { quote: q } }
  const mk = (over) => ({ id: 'as_bbbbbb', kind: 'rule', scope: 'global', body: '所有项目统一 pnpm', source: { quote: q }, ...over })
  assert.equal(pickQuoteTwin(mk({}), [old]).id, 'as_aaaaaa')
  assert.equal(pickQuoteTwin(mk({ scope: 'workspace' }), [old]), null, '跨 scope 不合并（安全阀）')
  assert.equal(pickQuoteTwin(mk({ supersedes: 'as_cccccc' }), [old]), null, '显式边优先')
  assert.equal(pickQuoteTwin(mk({ body: '这个不用记' }), [old]), null, '实体序列不同不合并')
  assert.equal(pickQuoteTwin(mk({ kind: 'conclusion' }), [old]), null, '只有 rule/guide 参与')
})

test('pickTwin：按强度/新近度确定选择，state 仍取最新', () => {
  const twins = [
    { id: 'as_1', strength: 'inferred', ts: '2026-01-03T00:00:00+08:00' },
    { id: 'as_2', strength: 'user_said', ts: '2026-01-01T00:00:00+08:00' },
    { id: 'as_3', strength: 'measured', ts: '2026-01-02T00:00:00+08:00' },
  ]
  assert.equal(pickTwin(twins, 'rule').id, 'as_2', '规约取最强的')
  assert.equal(pickTwin(twins, 'state').id, 'as_1', '状态取最新')
  assert.equal(pickTwin([], 'rule'), null)
})

// ─────────────────────── 4. 端到端：显式边越权 ───────────────────────

test('边校验：工作区记录不许 supersede / 跨 kind 取代全局规约', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-edge', session: { id: 's-edge', header: { cwd: work } } }
  const quote = '所有项目都别用 pnpm'
  say(ctx, agent, 2, quote)
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'rule', scope: 'global', body: '所有项目统一 pnpm，禁用 npm', criteria: '出现 npm 即违规', anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'user_said' }],
  }, { agent })
  const gid = w.accepted[0]
  // 工作区 rule 想 supersede 全局 rule：越级，丢边
  const w2 = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'conclusion', body: '本仓库改用 yarn 是因为 pnpm 走不通', supersedes: gid, anchor: { type: 'turn' }, source: { author: 'model', quote: '本仓库改用 yarn' } }],
  }, { agent })
  assert.equal(w2.accepted.length, 1, JSON.stringify(w2.rejected))
  assert.ok(w2.warnings.some((x) => x.code === 'edge_dropped'), JSON.stringify(w2.warnings))
  assert.equal(w2.accepted[0] === gid, false)
})

test('边校验：跨 kind 的 supersedes 也丢；跨 scope 的 retracts 带 reason 才放行', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-edge-2', session: { id: 's-edge-2', header: { cwd: work } } }
  say(ctx, agent, 2, '记一下这条 workspace 规则')
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'rule', body: '本工作区代码规范用 tabs', criteria: '出现空格缩进即违规', anchor: { type: 'turn' }, source: { author: 'user', quote: '记一下这条 workspace 规则' }, strength: 'user_said' }],
  }, { agent })
  const rid = w.accepted[0]
  const w2 = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'conclusion', body: '缩进之争已在评审里定案', anchor: { type: 'turn' }, source: { author: 'model', quote: '记一下这条 workspace 规则' }, supersedes: rid }],
  }, { agent })
  assert.ok(w2.warnings.some((x) => x.code === 'edge_dropped'), '跨 kind 取代必须丢边：' + JSON.stringify(w2.warnings))
})

test('edgeAllowed 单元：缺目标/结构记录/跨 kind/跨 scope 的判定', () => {
  const rule = { kind: 'rule', _scope: 'global' }
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'workspace', edge: 'supersedes', target: rule }), 'cross_scope')
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'workspace', edge: 'retracts', target: rule }), 'cross_scope_reason')
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'workspace', edge: 'retracts', reason: '误写', target: rule }), '')
  assert.equal(edgeAllowed({ recKind: 'conclusion', recScope: 'workspace', edge: 'supersedes', target: { kind: 'rule', _scope: 'workspace' } }), 'kind')
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'global', edge: 'supersedes', target: rule }), '')
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'global', edge: 'supersedes', target: null }), 'missing')
  assert.equal(edgeAllowed({ recKind: 'rule', recScope: 'global', edge: 'supersedes', target: { kind: 'expire' } }), 'struct')
})

// ─────────────────────── 5. 端到端：拒绝要原子 ───────────────────────

test('端到端：state+global+new_topic 被拒后，全局库里不留脏 topic', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-atomic', session: { id: 's-atomic', header: { cwd: work } } }
  say(ctx, agent, 1, '开一条新线')
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'state', scope: 'global', new_topic: '越权铸造的全局topic', body: 'x', next: 'y', anchor: { type: 'turn' } }],
  }, { agent })
  assert.equal(w.accepted.length, 0)
  assert.equal(w.rejected[0].code, 'E_SCOPE', JSON.stringify(w.rejected))
  assert.deepEqual(w.topics, {}, '被拒的记录不该回传铸造出来的 topic id')
  assert.ok(!jsonlText(home).includes('越权铸造的全局topic'), '全局库不该留下 topic 记录')
})

// ─────────────────────── 6. 判官：预算型失败不打死判官 ───────────────────────

test('callJudge：输出被 max-tokens 截断 → E_JUDGE_BUDGET（不是普通故障）', async () => {
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'max-tokens' }, usage: { outputTokens: 1200 } }
    },
  }
  await assert.rejects(
    () => callJudge({ llm, selection: { provider: 'p', model: 'm' }, input: { system: '', user: '' }, maxTokens: 1200 }),
    (e) => e.code === 'E_JUDGE_BUDGET',
  )
  const llm2 = {
    async *stream() {
      yield { type: 'text-delta', text: '{"records":' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  await assert.rejects(
    () => callJudge({ llm: llm2, selection: { provider: 'p', model: 'm' }, input: { system: '', user: '' }, maxTokens: 1200 }),
    (e) => e.code === 'E_JUDGE_BUDGET',
  )
  const llm3 = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await assert.rejects(
    () => callJudge({ llm: llm3, selection: { provider: 'p', model: 'm' }, input: { system: '', user: '' } }),
    (e) => e.code === 'E_JUDGE_EMPTY',
  )
})

test('端到端：判官连续预算型失败 3 次后仍不被关闭（可以继续归档）', async () => {
  const home = tmpHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const calls = []
  const ctx = makeCtx(home, {
    llm: {
      stream() {
        calls.push(1)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'max-tokens' }, usage: { outputTokens: 4000 } }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(ctx, {})
  const agent = { id: 's-judge', session: { id: 's-judge', header: { cwd: work } } }
  for (let turn = 1; turn <= 3; turn++) {
    say(ctx, agent, turn, '把 X 改成 Y 吧')
    ctx.fire('tools/result', { agent, name: 'write' }, { isError: true })
    ctx.fire('agent/turn-stopping', { agent, turn })
    await new Promise((r) => setTimeout(r, 25))
  }
  // 每轮 callJudge 内部还会重试一次（retries=1），所以 3 轮 = 6 次流式调用
  assert.equal(calls.length, 6, '三轮回合都真的调了判官（含其内部重试）')
  const tail = ctx._sections[1].text({ agent })
  assert.ok(!tail.includes('记忆判官不可用'), '预算型失败不该关闭判官：' + tail)
})
test('跨工作区撤回：A 撤掉的全局规则在 B 的注入面也消失（失效要落在全局库）', async () => {
  const home = tmpHome()
  const workA = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-wa-'))
  const workB = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-wb-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const a = { id: 's-x-a', session: { id: 's-x-a', header: { cwd: workA } } }
  const b = { id: 's-x-b', session: { id: 's-x-b', header: { cwd: workB } } }
  const quote = '所有项目都别用 pnpm'
  const body = '所有项目统一用 pnpm，禁用 npm'
  say(ctx, a, 2, quote)
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'rule', scope: 'global', body, criteria: '任一项目出现 npm 命令即违规', anchor: { type: 'turn' }, source: { author: 'user', quote }, strength: 'user_said' }],
  }, { agent: a })
  const gid = w.accepted[0]
  assert.ok(ctx._sections[1].text({ agent: b }).includes(body), '先确认 B 能看到这条全局规则')
  const w2 = await toolOf(ctx, 'waystone_write').execute({
    records: [{ kind: 'conclusion', body: '这条全局规则是误升，撤回', retracts: gid, reason: 'scope 无跨项目证据', anchor: { type: 'turn' }, source: { author: 'model', quote } }],
  }, { agent: a })
  assert.equal(w2.accepted.length, 1, JSON.stringify(w2.rejected))
  assert.ok(w2.warnings.some((x) => x.code === 'cross_scope_retract_mirrored'), JSON.stringify(w2.warnings))
  assert.ok(!ctx._sections[1].text({ agent: b }).includes(body), '失效必须镜像到全局库，否则别的工作区照常注入')
})
