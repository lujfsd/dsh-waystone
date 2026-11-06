import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject, judgeSignal } from '../lib/index.js'
import { topicIdOf } from '../lib/schema.js'
import { workspaceKey } from '../lib/store.js'
import { CONTRACT, CONTRACT_VERSION } from '../lib/contract.js'

/** 最小 Cordis 上下文替身：只实现本插件用到的表面，验证"能加载 + 工具可调用"。 */
function makeCtx(baseDir, services = {}) {
  const sections = []
  const contexts = []
  const tools = []
  const handlers = new Map()
  const effects = []
  const routes = []
  const ctx = {
    baseDir,
    systemPrompt: {
      section(s) {
        sections.push(s)
        return () => {}
      },
      context(c) {
        contexts.push(c)
        return () => {}
      },
    },
    tools: {
      register(d) {
        tools.push(d)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    inject(_names, callback) {
      callback(this)
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    fire(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args)
    },
  }
  ctx._sections = sections
  ctx._contexts = contexts
  ctx._tools = tools
  ctx._handlers = handlers
  ctx._effects = effects
  ctx._routes = routes
  return ctx
}

function toolOf(ctx, name) {
  const t = ctx._tools.find((x) => x.name === name)
  assert.ok(t, '未注册工具：' + name)
  return t
}

test('装配：inject 声明 + 2 section + 1 context + 3 工具', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const ctx = makeCtx(home)
  apply(ctx, {})

  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(ctx._sections.length, 2)
  assert.equal(ctx._sections[0].name, 'waystone:contract')
  assert.equal(ctx._sections[0].text(), CONTRACT)
  assert.equal(ctx._sections[0].order, 9400)
  assert.equal(ctx._sections[1].order, 9410)
  assert.equal(ctx._contexts.length, 1)
  assert.equal(ctx._contexts[0].order, 10000)
  assert.equal(ctx._contexts[0].required, true, 'tail 段要顶住 suppressRuntimeContext，否则 includeRuntimeContext:false 的部署里交接静默消失')
  assert.deepEqual(ctx._tools.map((t) => t.name), ['waystone_write', 'waystone_recall', 'waystone_status'])
  for (const t of ctx._tools) {
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
    assert.equal(t.parameters.type, 'object')
  }
})

test('缓存前缀稳定：读一遍记忆（recall / 反复渲染）不改变规约段字节', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-prefix', session: { id: 's-prefix', header: { cwd: work } } }
  const exec = { agent }
  const quote = '以后都别用 pnpm，会把路径写脏'
  ctx.fire('agent/inbox/claimed', { agent, turn: 2, message: { role: 'user', content: [{ type: 'text', text: quote }] } })

  // 两条同强度规则：排序只能落到 id（旧实现会落到 lastSeen，读一次就可能翻转）
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [
      { kind: 'rule', body: '不要用 pnpm 安装依赖', criteria: '出现 pnpm 命令即违规', anchor: { type: 'turn', sid: 's-prefix', turn: 2, quote }, source: { author: 'user', quote }, strength: 'user_said' },
      { kind: 'rule', body: '提交信息一律用中文', criteria: '看到英文提交信息即违规', anchor: { type: 'turn', sid: 's-prefix', turn: 2, quote }, source: { author: 'user', quote }, strength: 'user_said' },
    ],
  }, exec)
  assert.equal(w.accepted.length, 2, JSON.stringify(w.rejected))

  const before = ctx._sections[1].text({ agent })
  assert.ok(before.includes('[规约 · 本工作区]'), before)

  // 召回会刷 lastSeen（命中索引变了），但系统提示前缀必须一个字节都不动
  await toolOf(ctx, 'waystone_recall').execute({ query: 'pnpm' }, exec)
  assert.equal(ctx._sections[1].text({ agent }), before)
  // 反复渲染同样稳定（渲染本身不得写命中索引）
  assert.equal(ctx._sections[1].text({ agent }), before)
})

test('闭环：写入 → 规约注入 → 召回 → doctor(injected)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-test', session: { id: 's-test', header: { cwd: work } } }
  const exec = { agent }

  // 会话里先有一句用户原话（E_QUOTE 依据）
  ctx.fire('agent/inbox/claimed', { agent, turn: 3, message: { role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm，会把路径写脏' }] } })

  const write = toolOf(ctx, 'waystone_write')
  const w = await write.execute({
    records: [{
      kind: 'rule',
      body: '本机不用 pnpm',
      criteria: '出现 pnpm 命令即算违规',
      anchor: { type: 'turn', sid: 's-test', turn: 3, quote: '以后都别用 pnpm' },
      source: { author: 'user', quote: '以后都别用 pnpm' },
      strength: 'user_said',
    }],
  }, exec)
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 1)

  // 落盘位置符合"统一根 + workspace 作用域"
  const wsDir = path.join(home, 'waystone', 'data', 'ws')
  const keys = fs.readdirSync(wsDir)
  assert.equal(keys.length, 1)
  assert.match(keys[0], /-[0-9a-f]{8}$/)
  const shard = path.join(wsDir, keys[0], 'v1', 'assertions', 's-test.jsonl')
  assert.ok(fs.existsSync(shard))

  // 规约段注入（section 面）
  const rulesText = ctx._sections[1].text({ agent })
  assert.ok(rulesText.includes('[规约 · 本工作区]'), rulesText)
  assert.ok(rulesText.includes('本机不用 pnpm'))

  // 尾部 context：只有 rule 时没有可交接内容 ⇒ 无 [交接] 段；但库存行照出
  const tail = ctx._contexts[0].text({ agent })
  assert.equal(tail, '[记忆库] rule 1 —— 需要时 waystone_recall')

  // 召回（返回值必须能过宿主 lossless JSON 校验：不能带 undefined）
  const recall = toolOf(ctx, 'waystone_recall')
  const r = await recall.execute({ query: 'pnpm' }, exec)
  assert.equal(r.total, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  assert.equal(r.hits[0].kind, 'rule')
  assert.equal(r.hits[0].scope, 'workspace')
  assert.equal(r.hits[0].status, 'active')

  // doctor + 真实注入原文
  const status = toolOf(ctx, 'waystone_status')
  const st = await status.execute({ injected: true }, exec)
  assert.equal(st.dataDirSource, 'default')
  assert.equal(st.rules.workspace, 1)
  assert.equal(st.rules.global, 0)
  assert.ok(st.rulesText.includes('[规约 · 本工作区]'), st.rulesText)
  assert.equal(typeof st.injectedText, 'string')
  assert.equal(st.injectedText, '[记忆库] rule 1 —— 需要时 waystone_recall')
})

test('状态按 topic_id 分线：新线铸造 id、桶内新 state 取代旧的、抄错 id 拒收、存量历史收口为 superseded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-state', session: { id: 's-state', header: { cwd: work } } }
  const exec = { agent }
  ctx.fire('agent/inbox/claimed', { agent, turn: 4, message: { role: 'user', content: [{ type: 'text', text: '先做 A，再做 B' }] } })

  const write = toolOf(ctx, 'waystone_write')
  const anchor = { type: 'turn', sid: 's-state', turn: 4, quote: '先做 A，再做 B' }
  const stateRec = (body, next, over = {}) => ({ kind: 'state', body, next, ...over, anchor })

  // 既不给 topic_id 也不给 new_topic → 拒收
  const noTopic = await write.execute({ records: [stateRec('没 topic 的状态', 'x')] }, exec)
  assert.equal(noTopic.accepted.length, 0)
  assert.equal(noTopic.rejected[0].code, 'E_TOPIC', JSON.stringify(noTopic.rejected))

  // 新线：给名字，系统铸造 topic_id 并回传
  const first = await write.execute({ records: [stateRec('在做 A', '跑 A 的测试', { new_topic: 't-main' })] }, exec)
  assert.equal(first.accepted.length, 1, JSON.stringify(first.rejected))
  const mainId = Object.keys(first.topics)[0]
  assert.match(mainId, /^tp_[0-9a-f]{6}$/)
  assert.equal(first.topics[mainId], 't-main')

  // 同 id 继续推进（不再新建名字）
  await write.execute({ records: [stateRec('在做 B', '跑 B 的测试', { topic_id: mainId })] }, exec)
  const uiFirst = await write.execute({ records: [stateRec('在做 UI', '等设计稿', { new_topic: 't-ui' })] }, exec)
  const uiId = Object.keys(uiFirst.topics)[0]

  // 抄错 id → E_TOPIC_UNKNOWN；同名新线 → E_TOPIC_EXISTS（带现成 id）
  const bad = await write.execute({ records: [stateRec('抄错 id', 'x', { topic_id: 'tp_000000' })] }, exec)
  assert.equal(bad.rejected[0].code, 'E_TOPIC_UNKNOWN', JSON.stringify(bad.rejected))
  const dup = await write.execute({ records: [stateRec('同名新线', 'x', { new_topic: 't-main' })] }, exec)
  assert.equal(dup.rejected[0].code, 'E_TOPIC_EXISTS', JSON.stringify(dup.rejected))
  assert.ok(dup.rejected[0].message.includes(mainId), dup.rejected[0].message)

  const recall = toolOf(ctx, 'waystone_recall')
  const active = await recall.execute({ kind: 'state', query: '做' }, exec)
  assert.deepEqual(active.hits.map((h) => h.body).sort(), ['在做 B', '在做 UI'], JSON.stringify(active.hits))
  assert.equal((await recall.execute({ kind: 'state', query: '做', include_expired: true }, exec)).total, 3)

  // A′：记录 id / topic id 也能直接当 query 用——交接行首的 tp_、指南索引里的 as_ 就是给这个用的
  // 且必须排首位：正文里提及该 id 的记录 hits 同为 1，会凭 kind 强度反超（实测 as_53c51e 被判第 3）
  const recId = active.hits[0].id
  const byRecId = await recall.execute({ query: recId }, exec)
  assert.ok(byRecId.hits.some((h) => h.id === recId), '记录 id 应能直取：' + JSON.stringify(byRecId.hits))

  // 首位锁：另写一条 conclusion 正文提及前一条 conclusion 的 id。后者 hits 相同、强度相同，
  // 旧排序退到 ts 决胜，于是新写入的提及者被排到前面（线上实测就是这样把 guide 目标挤到第 3）。
  const c1 = await write.execute({ records: [{ kind: 'conclusion', body: '旧结论 A', anchor, source: { author: 'tool', quote: '旧结论 A' }, strength: 'measured' }] }, exec)
  assert.equal(c1.accepted.length, 1, '造 conclusion 失败：' + JSON.stringify(c1.rejected))
  const cid = c1.accepted[0]
  assert.match(cid, /^as_[0-9a-f]{6}$/)
  await write.execute({ records: [{ kind: 'conclusion', body: '结论见 ' + cid + ' 那条', anchor, source: { author: 'tool', quote: '结论见 ' + cid }, strength: 'measured' }] }, exec)
  const byGuideId = await recall.execute({ query: cid }, exec)
  assert.equal(byGuideId.hits[0].id, cid, '记录 id 直取必须排首位：' + JSON.stringify(byGuideId.hits.map((h) => h.id + ':' + h.kind)))
  const byTopicId = await recall.execute({ query: mainId }, exec)
  assert.equal(byTopicId.hits[0].topicId, mainId, 'topic id 直取必须排首位：' + JSON.stringify(byTopicId.hits.map((h) => h.topicId)))

  // 交接：一条线一行，行首带 topic_id（模型直写时靠它认线）
  const tail = ctx._contexts[0].text({ agent })
  // 每行都带 as_ 记录 id（可直接 recall 取全文），括号里是 topic_id（写 state 时认线用）
  assert.ok(tail.includes(' t-main (' + mainId + ')：在做 B；下一步：跑 B 的测试'), tail)
  assert.ok(tail.includes(' t-ui (' + uiId + ')：在做 UI；下一步：等设计稿'), tail)
  assert.match(tail, /- as_[0-9a-f]{6} t-main \(tp_[0-9a-f]{6}\)/, '交接行首必须带记录 id：' + tail)
  assert.ok(!tail.includes('主线'), tail)
  assert.ok(!tail.includes('目标：') && !tail.includes('在做：'), tail)

  // 存量收口：老记录只有名字（没有 topic_id），按名字派生 id；新 state 用派生 id 就能接着同一条线
  const wsKey = fs.readdirSync(path.join(home, 'waystone', 'data', 'ws'))[0]
  const shard = path.join(home, 'waystone', 'data', 'ws', wsKey, 'v1', 'assertions', 's-state.jsonl')
  const legacy = (id, body, ts) => JSON.stringify({
    v: 1, id, ts, sid: 's-legacy', turn: 1, kind: 'state', scope: 'workspace', topic: 't-legacy', body, next: '老下一步',
    anchor: { type: 'turn', sid: 's-legacy', turn: 1, quote: 'x' },
  }) + '\n'
  fs.appendFileSync(shard, legacy('as_aaaa01', '老状态一', '2026-11-01T10:00:00.000Z') + legacy('as_aaaa02', '老状态二', '2026-11-02T10:00:00.000Z'))
  const legacyId = topicIdOf({ topic: 't-legacy' })
  assert.match(legacyId, /^tp_[0-9a-f]{6}$/)

  const w = await write.execute({ records: [stateRec('老线前进', '继续', { topic_id: legacyId })] }, exec)
  assert.equal(w.accepted.length, 1, JSON.stringify(w.rejected))
  const legacyHits = await recall.execute({ kind: 'state', query: '老' }, exec)
  assert.deepEqual(legacyHits.hits.map((h) => h.body), ['老线前进'], JSON.stringify(legacyHits.hits.map((h) => h.body)))

  // 闭环：next 写空串 = 本线已完成（四态里的 closed）→ 不进交接，默认召回仍查得到
  const closed = await write.execute({ records: [stateRec('UI 做完了', '', { topic_id: uiId })] }, exec)
  assert.equal(closed.accepted.length, 1, JSON.stringify(closed.rejected))
  const tail2 = ctx._contexts[0].text({ agent })
  assert.ok(!tail2.includes('t-ui'), tail2)
  const byDefault = await recall.execute({ kind: 'state', query: '做' }, exec)
  const doneHit = byDefault.hits.find((h) => h.body === 'UI 做完了')
  assert.ok(doneHit, '已完成默认就该召回得到：' + JSON.stringify(byDefault.hits.map((h) => h.body)))
  assert.equal(doneHit.status, 'closed', '闭环记录的状态应该是 closed')
  const still = await recall.execute({ kind: 'state', query: '做', include_expired: true }, exec)
  assert.ok(still.hits.some((h) => h.body === 'UI 做完了'), JSON.stringify(still.hits.map((h) => h.body)))
})

test('三条入口都能收用户原话：session/event(user/message) 决定 E_QUOTE 是否放行', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const session = { id: 's-ev', header: { cwd: work } }
  const agent = { id: 's-ev', session }

  ctx.fire('session/event', session, {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm，会把路径写脏' }] } },
  })

  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', body: '本机不用 pnpm', criteria: '出现 pnpm 即违规',
      anchor: { type: 'turn', sid: 's-ev', turn: 1, quote: '以后都别用 pnpm' },
      source: { author: 'user', quote: '以后都别用 pnpm' },
      strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 1)

  // 写进来的 rule 立刻出现在规约段（section 面），block 顺序 global → workspace
  const text = ctx._sections[1].text({ agent })
  assert.ok(text.includes('[规约 · 本工作区]'))
  assert.ok(text.includes('本机不用 pnpm'))
})

test('会话 durable 日志里的旧原话也算数（插件加载前说过的话不能被 E_QUOTE 误拒）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const session = {
    id: 's-hist',
    header: { cwd: work },
    events: [
      { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm，会把路径写脏' }] } } },
    ],
  }
  const agent = { id: 's-hist', session }
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', body: '本机不用 pnpm', criteria: '出现 pnpm 即违规',
      anchor: { type: 'turn', sid: 's-hist', turn: 1, quote: '以后都别用 pnpm' },
      source: { author: 'user', quote: '以后都别用 pnpm' },
      strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 1)
})

test('E_SCOPE 经工具可见：state 不能进 global', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-scope', session: { id: 's-scope', header: { cwd: work } } }
  ctx.fire('agent/inbox/claimed', { agent, turn: 1, message: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'state', scope: 'global', body: '已实现 schema', next: '写 store', new_topic: 't-scope',
      anchor: { type: 'turn', sid: 's-scope', turn: 1, quote: '继续' },
      source: { author: 'model' },
    }],
  }, { agent })
  assert.equal(w.accepted.length, 0)
  assert.equal(w.rejected[0].code, 'E_SCOPE')
})

test('E_QUOTE 经工具可见：goal 续跑轮的用户原话只能从 pre-step 收到', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-pre', session: { id: 's-pre', header: { cwd: work } } }

  // 只经过 agent/pre-step（不经过 inbox/claimed）的用户消息
  let nextCalled = false
  for (const fn of ctx._handlers.get('agent/pre-step') || []) {
    await fn({
      agent,
      turn: 2,
      messages: [{ role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm，会把路径写脏' }] }],
    }, async () => {
      nextCalled = true
      return { kind: 'continue' }
    })
  }
  assert.equal(nextCalled, true, '前一步瀑布必须被放行')

  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', body: '本机不用 pnpm', criteria: '出现 pnpm 即违规',
      anchor: { type: 'turn', sid: 's-pre', turn: 2, quote: '以后都别用 pnpm' },
      source: { author: 'user', quote: '以后都别用 pnpm' },
      strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 1)
})

test('迁移路由：只收 POST、只认旧根、当前根非空拒绝；成功时复制且源保留', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const legacyRoot = path.join(home, 'waystone', 'data') // legacyRoots 的候选之一（baseDir/waystone/data）
  const newRoot = path.join(home, 'newdata') // 当前根：空库
  fs.mkdirSync(path.join(legacyRoot, 'global', 'v1', 'assertions'), { recursive: true })
  const legacyFile = path.join(legacyRoot, 'global', 'v1', 'assertions', 's1.jsonl')
  const legacyLine = JSON.stringify({ id: 'as_aaaaaa', kind: 'rule', body: '旧库里的规则', ts: '2026-11-06T00:00:00+08:00' })
  fs.writeFileSync(legacyFile, legacyLine + '\n')

  const ctx = makeCtx(home)
  apply(ctx, { dataDir: newRoot })
  const route = ctx._routes.find((r) => r.path === '/api/waystone/migrate')
  assert.ok(route, '未注册迁移路由')

  const call = async (url, method = 'POST') => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
    await route.handler({ url, method }, res)
    return { status: res.status, data: JSON.parse(res.body) }
  }

  // 非 POST 一律拒绝
  assert.equal((await call('/api/waystone/migrate?from=' + encodeURIComponent(legacyRoot), 'GET')).status, 405)
  // 任意路径不许迁（只认本插件列出的旧根）
  assert.equal((await call('/api/waystone/migrate?from=' + encodeURIComponent(path.join(home, 'elsewhere')))).status, 400)

  // 正常迁移：复制成功、源保留
  const ok = await call('/api/waystone/migrate?from=' + encodeURIComponent(legacyRoot))
  assert.equal(ok.status, 200)
  assert.equal(ok.data.ok, true)
  assert.equal(ok.data.lines, 1)
  assert.equal(fs.readFileSync(path.join(newRoot, 'global', 'v1', 'assertions', 's1.jsonl'), 'utf8').trim(), legacyLine)
  assert.ok(fs.existsSync(legacyFile), '迁移不该删源（删源要人跑脚本 --prune）')

  // 当前根已有记录：拒绝合并（合并是脚本 --merge 的事）
  assert.equal((await call('/api/waystone/migrate?from=' + encodeURIComponent(legacyRoot))).status, 409)
})

test('只读查看页：/api/waystone/state 给出规约/交接/分组，且一个字节都不写', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const session = { id: 's-page', header: { cwd: work }, events: [] }
  const agent = { id: 's-page', session }
  ctx.fire('session/event', session, {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm，会把路径写脏' }] } },
  })
  const written = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule', body: '本机不用 pnpm', criteria: '出现 pnpm 即违规',
      anchor: { type: 'turn', sid: 's-page', turn: 1, quote: '以后都别用 pnpm' },
      source: { author: 'user', quote: '以后都别用 pnpm' },
      strength: 'user_said',
    }],
  }, { agent })
  assert.equal(written.rejected.length, 0)

  const route = ctx._routes.find((r) => r.path === '/api/waystone/state')
  assert.ok(route, '未注册只读数据路由')

  const shardDir = path.join(home, 'waystone', 'data', 'ws')
  const shardBefore = fs.readFileSync(
    path.join(shardDir, fs.readdirSync(shardDir)[0], 'v1', 'assertions', 's-page.jsonl'),
    'utf8',
  )

  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
  await route.handler({ url: '/api/waystone/state' }, res)
  assert.equal(res.status, 200)

  const data = JSON.parse(res.body)
  assert.equal(data.rules.workspace, 1)
  // 配置面：都要透到查看页（少透一个，页面就显示 undefined，配置也改不动）
  assert.equal(data.config.rulesMax, 30)
  assert.equal(data.config.injectBudgetTokens, 1500)
  assert.equal(data.config.compactPoolMax, 60)
  assert.equal(data.config.compactBatch, 60)
  assert.ok(data.rulesText.includes('本机不用 pnpm'), data.rulesText)
  // 只有 rule、没有线/死路/指南命中 ⇒ 交接段整段为空，不注入占位
  assert.equal(data.tailText, '')
  // 但尾部要给一行库存：不给条数，模型不知道 fact/conclusion 压着没看
  const injectedTail = ctx._contexts[0].text({ agent })
  assert.ok(injectedTail.includes('[记忆库] rule 1'), injectedTail)
  assert.ok(injectedTail.includes('waystone_recall'), injectedTail)
  assert.equal(data.groups.rule.length, 1)
  assert.equal(data.groups.rule[0].id, written.accepted[0])
  assert.ok(data.workspaces.some((w) => w.key === data.workspaceKey))
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data)

  // 只读：分片字节不变
  const shardAfter = fs.readFileSync(
    path.join(shardDir, fs.readdirSync(shardDir)[0], 'v1', 'assertions', 's-page.jsonl'),
    'utf8',
  )
  assert.equal(shardAfter, shardBefore)
})

test('空目录冷启动不崩：无 config、无数据也能渲染', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-cold', session: { id: 's-cold', header: { cwd: home } } }
  assert.equal(ctx._sections[1].text({ agent }), '')
  // 空库不注入交接占位：整段为空串（不再输出「- 状态：无进行中的线」）
  assert.equal(ctx._contexts[0].text({ agent }), '')
})

test('判官有界并发 ≤6，且卸载 abort 在飞调用（LEV-7）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  let started = 0
  let aborted = 0
  const stream = async function* ({ signal }) {
    started += 1
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 40)
      if (signal) {
        signal.addEventListener('abort', () => {
          aborted += 1
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }
    })
    yield { type: 'text-delta', text: '{"records":[],"skip":true,"why":"x"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = makeCtx(home, {
    llm: { stream },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(ctx, {})

  const agents = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: 's-j' + i, session: { id: 's-j' + i, header: { cwd: work } } }))
  for (const agent of agents) {
    // file-change 是判官的四类触发之一
    ctx.fire('tools/result', { agent, name: 'write' }, { isError: false })
    ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  }
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(started, 6, '同时只允许 6 条判官在飞，实际 ' + started)

  // 卸载：在飞的判官必须被取消，且取消不算失败
  // 注意 effects[0] 是路由那条（在 inject 里先注册），表面 effect 是最末一个
  assert.ok(ctx._effects.every((fn) => typeof fn === 'function'))
  for (const dispose of ctx._effects) dispose()
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(aborted, 6, '卸载应 abort 在飞的 ' + 6 + ' 条，实际 ' + aborted)

  // session/disposed 两种载荷形态都不得抛
  assert.doesNotThrow(() => ctx.fire('session/disposed', { id: 's-j0' }))
  assert.doesNotThrow(() => ctx.fire('session/disposed', { session: { id: 's-j1' } }))
})

// 回归（本次修复的核心）：判官必须同时看到「人话」和「助手干了什么」。
// 旧实现两个都拿不到 —— 用户消息被 runtime-context 快照占满、助手摘要恒空，
// 于是每轮都 skip:true，表现为"插件从来不记新东西"。
test('判官输入含真实用户话与助手产出，且不含 runtime-context 快照', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const seen = []
  const ctx = makeCtx(home, {
    llm: {
      stream(req) {
        seen.push(req)
        return (async function* () {
          yield { type: 'text-delta', text: '{"records":[],"skip":true,"why":"x"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(ctx, {})
  const session = { id: 's-ctx', header: { cwd: work } }
  const agent = { id: 's-ctx', session }

  // 宿主每步把运行时快照以 user/message 追加：它不是人写的原话
  ctx.fire('session/event', session, {
    type: 'user/message',
    data: {
      message: {
        role: 'user',
        source: { kind: 'runtime-context' },
        content: [{ type: 'text', text: 'Current runtime context. cwd=G:\\x GUI=http://127.0.0.1:1' }],
      },
    },
  })
  // 真实用户话
  ctx.fire('session/event', session, {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '以后都别用 pnpm' }] } },
  })
  // 助手产出：宿主帧是 chunk，旧实现按 frame.type === 'text-delta' 取不到
  ctx.fire('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '已改成 npm ci' } },
  })

  ctx.fire('tools/result', { agent, name: 'write' }, { isError: false })
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(seen.length, 1, '判官应被调用一次')
  const input = seen[0].messages[0].content[0].text
  assert.ok(input.includes('以后都别用 pnpm'), '真实用户话必须在判官输入里\n' + input)
  assert.ok(input.includes('已改成 npm ci'), '助手产出必须在判官输入里\n' + input)
  assert.ok(!input.includes('Current runtime context.'), '运行时快照不该进判官输入\n' + input)
})

// 回归：模型不知道自己的 sid/turn，只写 {type:"turn"} 时写入路径必须补全，
// 否则 conclusion/fact 想锚"本轮观察"永远写不进来。
test('turn 锚点自动补全：conclusion/fact 只给 type 也能落盘', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const agent = { id: 's-anchor', session: { id: 's-anchor', header: { cwd: work } } }
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [
      { kind: 'fact', body: '本机未装 docker，容器一律用 wslc', anchor: { type: 'turn' }, source: { author: 'tool' }, strength: 'measured' },
      { kind: 'conclusion', body: 'pnpm 11 的 minimumReleaseAge 会拦插件安装', anchor: { type: 'turn' }, source: { author: 'tool', quote: 'ERR_PNPM_MINIMUM_RELEASE_AGE' }, strength: 'measured' },
    ],
  }, { agent })
  assert.equal(w.rejected.length, 0, JSON.stringify(w.rejected))
  assert.equal(w.accepted.length, 2)
})

// 回归：事实的定义是「长期不变、与代码实现无关」。变更叙事（L1）与代码坐标/构建产物（L2）
// 一旦进 fact 就会永久留在 [项目档案] 里，所以入库时就拒，并给出改写方向。
test('事实入库闸经工具可见：变更叙事写 fact 被拒，且给出改写建议', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const agent = { id: 's-gate', session: { id: 's-gate', header: { cwd: work } } }
  const ctx = makeCtx(home)
  apply(ctx, {})
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [
      { kind: 'fact', body: '判官并发由 2 改为 6，已落地', anchor: { type: 'turn' }, source: { author: 'tool' }, strength: 'measured' },
      { kind: 'conclusion', body: '判官并发由 2 改为 6，为的是多会话同时收尾时不互相挤掉', anchor: { type: 'turn' }, source: { author: 'tool', quote: '改为 6' }, strength: 'measured' },
    ],
  }, { agent })
  assert.equal(w.accepted.length, 1, JSON.stringify(w.rejected))
  assert.equal(w.rejected[0].code, 'E_FACT_GATE', JSON.stringify(w.rejected))
  assert.match(w.rejected[0].message, /改写成 (state|conclusion)/, '拒收必须给出改写方向，否则模型只会重试同一句')
})

// 回归：模型主动写时唯一能看到 kind 语义的地方就是这条 description，不能被缩回裸枚举。
test('waystone_write 的 kind 参数带判据（模型侧唯一入口）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const d = toolOf(ctx, 'waystone_write').parameters.properties.records.items.properties.kind.description
  assert.ok(d.includes('conclusion=') && d.includes('fact='), d)
  assert.ok(d.includes('turn'), d)
})

// 回归：契约与判官必须同一口径——"只是改这一版"是决策不是规约。
// 旧契约把"用户明确纠正"也当 rule 触发，与判官判据打架，会持续生产错类记录。
test('契约口径：一次性改法不写 rule；工具参数声明 suspect', () => {
  assert.ok(CONTRACT.includes('只是让你改这一版'), '契约缺"一次性改法≠规约"口径')
  assert.ok(CONTRACT.includes('先查记忆'), '契约缺"动手先 recall"口径')
  // 回归：交接里的「下一步」是待办，模型要主动接手；next 必须可执行，否则接不下去。
  assert.ok(CONTRACT.includes('「下一步」不是描述，是待办'), '契约缺"next 是待办、要接手去做"口径')
  assert.ok(CONTRACT.includes('动词开头 + 完成判据'), '契约缺 next 写法约束')
  // 版本只活在 CONTRACT_VERSION 里；标题进每轮系统提示，带版本等于让缓存前缀随发版抖动。
  assert.equal(CONTRACT.split('\n')[0], '[waystone · 工作记忆契约]', '契约标题不要带版本号')
  assert.match(CONTRACT_VERSION, /^v\d+$/)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const ctx = makeCtx(home)
  apply(ctx, {})
  const props = toolOf(ctx, 'waystone_write').parameters.properties.records.items.properties
  assert.ok(props.suspect, 'RECORD_PROPERTIES 缺 suspect：模型永远标不出 [未复核]')
  assert.ok(props.strength.description.includes('measured>user_said'), props.strength.description)
})

test('判官信号：超时到点 abort，卸载 abort 也能穿透（LEV-7）', async () => {
  const timed = judgeSignal(undefined, 10)
  assert.equal(timed.aborted, false)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(timed.aborted, true, '超时未 abort：一次挂起的流会永久占住判官并发名额')

  const teardown = new AbortController()
  const chained = judgeSignal(teardown.signal, 60000)
  teardown.abort()
  assert.equal(chained.aborted, true, '卸载 abort 必须穿透到调用')
})

test('规约段预算跟配置走（不再写死 800）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home)
  apply(ctx, { injectBudgetTokens: 200 })
  const agent = { id: 's-budget', session: { id: 's-budget', header: { cwd: work } } }
  const quote = '以后都别用 pnpm'
  ctx.fire('agent/inbox/claimed', { agent, turn: 1, message: { role: 'user', content: [{ type: 'text', text: quote }] } })
  const w = await toolOf(ctx, 'waystone_write').execute({
    records: [{
      kind: 'rule',
      body: '长规则 ' + 'x'.repeat(400),
      criteria: '出现即违规',
      anchor: { type: 'turn', sid: 's-budget', turn: 1, quote },
      source: { author: 'user', quote },
      strength: 'user_said',
    }],
  }, { agent })
  assert.equal(w.accepted.length, 1, JSON.stringify(w.rejected))
  assert.equal(ctx._sections[1].text({ agent }), '', '200 tok 预算下 400 字规则应被整段截掉（预算真的读配置了）')
})

test('卸载后不再写盘：in-flight 判官被 abort 时不落审计（否则回落到 ~/.dsh 写错库）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-work-'))
  const ctx = makeCtx(home, {
    llm: { stream: async function* () { throw new Error('boom') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(ctx, {})
  const agent = { id: 's-unload', session: { id: 's-unload', header: { cwd: work } } }
  // file-change 触发判官，随即卸载：in-flight 那次在 abort 后不得留下任何审计
  ctx.fire('tools/result', { agent, name: 'write' }, { isError: false })
  ctx.fire('agent/turn-stopping', { agent, turn: 1 })
  for (const dispose of ctx._effects) dispose()
  await new Promise((r) => setTimeout(r, 80))
  const fallback = path.join(os.homedir(), '.dsh', 'waystone', 'data', 'ws', workspaceKey(work))
  assert.equal(fs.existsSync(fallback), false, '卸载后不得往回落根（~/.dsh）写盘')
})
