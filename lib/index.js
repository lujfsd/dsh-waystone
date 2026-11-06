/**
 * waystone（路标）· DSH 工作记忆插件入口（V5 §9 装配 / §6 工具面 / §5 注入）。
 *
 * 纯 addon：只注册 systemPrompt 两个面 + 三个工具 + 若干只读事件观察；
 * 不改宿主文件、不依赖目标行稳定、不弹窗、不阻塞回合。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { CONTRACT } from './contract.js'
import {
  validateRecord, computeStatus, cmpStrength, quotaVictim, INTERNAL_KIND, TOPIC_KIND, topicIdOf, BODY_MAX_CHARS,
} from './schema.js'
import * as store from './store.js'
import { renderRules, renderTail, renderUnavailable, hitGuides, firstFieldPath } from './render.js'
import { shouldJudge, buildJudgeInput, parseJudgeOutput, callJudge, enforceScope, capNarrative } from './judge.js'
import { shouldCompact, buildCompactInput, parseCompactOutput, pickMerges, meetsShrink, hardTarget, shrinkTarget, MERGE_BODY_MAX_CHARS } from './compact.js'
import { PROFILE_MAX_CHARS, PROFILE_PROMPT_VERSION, profileHash, buildProfileInput, parseProfileOutput, pickProfile, attachSources } from './profile.js'
import { migrate } from './migrate.js'

export const name = 'waystone'
export const inject = ['tools', 'systemPrompt']

/**
 * 标记一个字段「可在运行时热改」（schemastery 的 volatile 角色）。
 *
 * ★ 这一步是插件页那个配置表单能出现的**前提**：宿主的新设置页只投影带 volatile
 *   标记的字段，没标记 ⇒ 该 entry 没有可编辑字段 ⇒ 行配置视图拿到的 `form` 是
 *   undefined（实测症状：页面显示「宿主没有提供 form」）。
 *   特性检测：schemastery ≥3.18.4 才有 `.volatile()`，老版本原样返回。
 */
const editable = (schema) => (schema && typeof schema.volatile === 'function' ? schema.volatile() : schema)

/**
 * 插件行配置 schema（宿主据此投影出配置表单；也用于校验 apply 收到的 config）。
 * schemastery 由宿主提供；取不到就退化为"无表单"，绝不因此让插件加载失败。
 *
 * ★ 必须是**同步**拿到（C-10：模块顶层不得 `await`，否则插件入口的求值被推迟）：
 *   先用 `import.meta.resolve` 走 **import 条件**拿到同一个 `.mjs`，再 `require()`
 *   （Node ≥22.12 默认启用 require(esm)）。实测两者拿到的是**同一个 default 导出**
 *   （schemastery 的 Schema 类是同一份），不会出现 README 里说的"两个实例对不上"。
 *   不退回 `require('@deepseek-ai/schemastery')` 的 CJS 入口——那是另一份 Schema 类，
 *   表单会静默消失；宁可没有表单，也不装一个错误的 schema。
 */
let ConfigSchema
try {
  const req = createRequire(import.meta.url)
  const mod = req(fileURLToPath(import.meta.resolve('@deepseek-ai/schemastery')))
  const S = mod.default || mod
  ConfigSchema = S.object({
    rulesMax: editable(S.number().min(1).max(200).default(30).description(
      '「规则」条数上限（只算用户的硬要求）：全局规则与本工作区规则各自封顶，结论/事实/指南/死路不计入。'
      + '超出时淘汰「最久没被召回、强度最低」的那条，新写的照样能进来。')),
    injectBudgetTokens: editable(S.number().min(200).max(8000).default(1500).description(
      '每轮注入预算（词元，按 2 个字符 ≈ 1 个词元估算）。规约段用掉全额；交接段只用其中的 55%（最少 300 词元）')),
    compactConclusionMax: editable(S.number().min(1).max(500).default(60).description(
      '本工作区里还「有效」的结论（没被新结论取代、也没过期）达到多少条触发一次合并整理')),
    compactFactMax: editable(S.number().min(1).max(500).default(40).description(
      '还「有效」的事实达到多少条触发一次合并整理（同上，不含自动生成的「项目档案」那条）')),
    compactBatch: editable(S.number().min(10).max(200).default(60).description(
      '单次整理最多把最新的多少条送进模型；调小省输入但收敛慢，调大一次到位但输入变长')),
    dataDir: editable(S.string().default('').description(
      '存储根（全局库与各工作区库都在它下面）。填什么就是什么：不会在你填的目录下再补一层 waystone/data，'
      + '根下只会有 global/ 与 ws/ 两个子目录；只有留空才用默认根 <宿主数据目录>/waystone/data'
      + '（宿主没给数据目录时退回 ~/.dsh/waystone/data）。相对路径按会话工作目录解析。'
      + '环境变量 WAYSTONE_DATA_DIR 优先于这里；改这里不搬数据，旧库原样留在原处')),
  })
} catch {
  ConfigSchema = undefined
}
export const Config = ConfigSchema

// order 取宿主保留表里的空位：9000 已被 DELIVERABLE_FILE_REFERENCES 占用（同 order 时按
// name 字典序决定先后），9400/9410 落在 9000-9900 之间没有宿主条目的位置。context 的 10000
// 与 section 不是同一张表（宿主 context order 只有 100-210），所以它永远是最后一段。
const SECTION_ORDER = 9400
const RULES_ORDER = 9410
const TAIL_ORDER = 10000

const STATE_THROTTLE_TURNS = 5
const JUDGE_MAX_FAILURES = 3

/** 每会话运行态（不落盘：观察层只活在内存，V5 §3.3）。 */
const sessions = new Map()
/** id → 最近一次被注入/被召回的时间（配额淘汰排序用，不落盘，V5 §4.3）。 */
const lastSeen = new Map()

/**
 * 判官全局并发闸（LEV-7 有界）：同时最多 N 个会话在调 LLM，超限的这轮直接跳过
 * （不消费观察数据，留到下一轮）。per-session 的 `judgeBusy` 只管自己。
 */
const JUDGE_MAX_CONCURRENT = 6
let judgeRunning = 0
/**
 * 调用超时（LEV-7）：只等卸载 abort 不够——一次挂起的流会永久占住 judgeRunning 名额
 * （两个就堵死全部判官），compact/profile 的单飞标志同理。这里把「卸载取消」与「超时取消」
 * 并起来；超时按失败计数（连 3 次降级为手动写入），不静默吞掉。
 */
// 2026-11-06：60 s → 180 s。compactBatch=60 的整理官在 60 s 内跑不完（实测每次正好 60.0 s 被
// abort，文本为空 → 报「整理官输出不是 JSON」），而判官/档案的调用远小于 60 s，故统一放宽。
const JUDGE_TIMEOUT_MS = 180000
export function judgeSignal(base, ms = JUDGE_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(ms)
  return base ? AbortSignal.any([base, timeout]) : timeout
}
/**
 * 判官的在飞取消器：卸载/重载时 abort（LEV-1/7）。
 * 刻意**不**串宿主 `agent/turn-stopping` 载荷里的 `signal`：那个 signal 是回合 phase
 * 作用域的，回合收尾即可能 abort，而判官正好在收尾之后才开始跑 —— 串上去会变成
 * "每次都立刻被取消"，功能静默失效。卸载取消才是真正需要贯穿的那一条。
 */
let judgeAbort = null
/**
 * 卸载后置真：in-flight 的判官/整理/档案在 await 之后一律直接返回，不再起新调用、不再写盘。
 * 只有 abort 不够——abort 后 catch 分支仍会写一条审计，而那时 `ctxRef` 已清空，数据根会
 * 回落到 `~/.dsh`（宿主给了自定义 baseDir 时就是写错库；本机表现为单元测试往真库写分片）。
 */
let unloaded = false

function sessionState(agent) {
  const sid = store.sessionIdOf(agent)
  let st = sessions.get(sid)
  if (!st) {
    st = {
      sid,
      cwd: store.cwdOf(agent),
      lastTurn: 0,
      userMessages: [],
      filesTouched: new Set(),
      sawError: false,
      topicWrite: false,
      topic: '',
      assistantText: '',
      judgeFailures: 0,
      judgeDisabled: false,
      judgeBusy: false,
      lastStateWriteTurn: 0,
      injected: '',
      injections: [],
    }
    sessions.set(sid, st)
  }
  return st
}

function freshObservation(st) {
  st.filesTouched = new Set()
  st.sawError = false
  st.topicWrite = false
  st.assistantText = ''
}

/**
 * 宿主每步都会把 runtime-context 快照以 user/message 追加（agent-loop:1067，
 * source.kind === 'runtime-context'）。它不是人写的原话：混进用户消息集会
 * 让判官只看到环境噪音，也会给 E_QUOTE 提供假原话。用结构标记判定，别匹配文案。
 */
export function isInjectedMessage(message) {
  const kind = message && message.source && message.source.kind
  return kind === 'runtime-context'
}

/**
 * 从 agent/assistant-stream 帧里取文本增量。
 * 宿主帧只有 start/chunk/end（agent-loop:358-410），文本在 chunk.chunk.text。
 */
export function textOfStreamFrame(frame) {
  if (!frame || frame.type !== 'chunk') return ''
  const chunk = frame.chunk
  if (!chunk || chunk.type !== 'text-delta') return ''
  return typeof chunk.text === 'string' ? chunk.text : ''
}

function textOfMessage(message) {
  const content = message && message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 工具结果是 lossless JSON：undefined/函数会让宿主整体拒收（实测 "value is not lossless JSON"）。 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

function rememberUserText(st, text) {
  const t = String(text || '').trim()
  if (!t) return
  if (st.userMessages[st.userMessages.length - 1] === t) return
  st.userMessages.push(t)
  if (st.userMessages.length > 60) st.userMessages.splice(0, st.userMessages.length - 60)
}

/**
 * 本会话用户原话全集（E_QUOTE 的判定依据）。
 * 回忆 ring 只覆盖"插件加载之后"；会话 durable 日志（session.events / snapshotEvents）
 * 才含更早的原话，必须并上，否则真原话会被 E_QUOTE 误拒。
 */
function userTextsOf(agent, st) {
  const out = [...(st ? st.userMessages : [])]
  try {
    const session = agent && agent.session
    if (!session) return out
    const events = Array.isArray(session.events)
      ? session.events
      : (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [])
    if (!Array.isArray(events)) return out
    for (const ev of events) {
      if (!ev || ev.type !== 'user/message') continue
      const data = ev.data || {}
      const message = data.message || data
      if (isInjectedMessage(message)) continue
      const text = textOfMessage(message)
      if (text) out.push(text)
    }
  } catch {
    /* 会话日志不可读时只用 ring，不阻塞写入 */
  }
  return out
}

function newId() {
  return 'as_' + crypto.randomBytes(3).toString('hex')
}

/** 从已知目录构造快照（global + 工作区合并，global 在前）。 */
function snapshotFromDirs(dirs, cfg, root) {
  const g = store.loadScope(dirs.globalDir)
  const w = store.loadScope(dirs.workspaceDir)
  const records = [
    ...g.records.map((r) => ({ ...r, _scope: 'global' })),
    ...w.records.map((r) => ({ ...r, _scope: 'workspace' })),
  ]
  const status = computeStatus(records)
  const active = records.filter((r) => status.get(r.id) === 'active')
  return {
    cfg: cfg || store.readConfig(configDefaults()),
    root,
    dirs,
    records,
    status,
    active,
    // 非空 = 分片读不出来（EIO/EACCES…），不是「还没有记录」。注入面据此保住上一次的前缀。
    storeError: g.error || w.error || '',
    byKind(kind) {
      return active.filter((r) => r.kind === kind)
    },
    sessions: g.sessions + w.sessions,
  }
}

/** 读一次全量快照（按 agent 的工作目录定位作用域）。 */
function snapshot(agent) {
  const cfg = store.readConfig(configDefaults())
  const cwd = store.cwdOf(agent)
  const root = store.resolveDataDir(ctxRef, cfg.config, cwd)
  const dirs = store.scopeDirs(root.dataDir, cwd)
  return { ...snapshotFromDirs(dirs, cfg, root), cwd }
}

/** 按工作区键读快照（Web 查看页用：页面不绑定会话）。 */
function snapshotForKey(key) {
  const cfg = store.readConfig(configDefaults())
  const root = store.resolveDataDir(ctxRef, cfg.config, process.cwd())
  const dirs = store.scopeDirsForKey(root.dataDir, key)
  return { ...snapshotFromDirs(dirs, cfg, root), key }
}

let ctxRef = null
/**
 * 插件行配置（cordis.patch.yml 的 config + 设置页里 volatile 字段的热改）。
 *
 * ★ 必须是**活引用**，不能只在 apply 时快照：宿主把 volatile 编辑直接写回 apply
 *   收到的同一个 config 对象（`loader/volatile-update` 只是通知），快照会让设置页
 *   改完不生效。读取一律走 configDefaults()。
 */
let rowConfigRef = {}

function configDefaults() {
  return rowConfigRef && typeof rowConfigRef === 'object' ? rowConfigRef : {}
}

function activeRulesOf(snap) {
  return snap.byKind('rule')
}

/** 规约段文本（纯函数：只由记忆内容与预算决定，不碰 lastSeen/时钟，前缀字节稳定）。 */
function rulesTextOf(snap) {
  const rules = activeRulesOf(snap)
  return renderRules({
    global: rules.filter((r) => r._scope === 'global'),
    workspace: rules.filter((r) => r._scope === 'workspace'),
    budgetTokens: snap.cfg.config.injectBudgetTokens,
  })
}

/** doctor 与查看页共用：file 锚点已失效的条数。 */
function countStaleAnchors(active, probe) {
  let n = 0
  for (const r of active) {
    if (r.anchor && r.anchor.type === 'file') {
      const sha = probe.lineSha256(r.anchor.path, r.anchor.line)
      if (!sha || sha !== r.anchor.sha256) n++
    }
  }
  return n
}

/** doctor 与查看页共用：规约条数（全局 / 本工作区 / 上限）。 */
function ruleStatsOf(snap) {
  const rules = activeRulesOf(snap)
  return {
    global: rules.filter((r) => r._scope === 'global').length,
    workspace: rules.filter((r) => r._scope === 'workspace').length,
    max: snap.cfg.config.rulesMax,
  }
}

/**
 * topic 注册表：topic_id → {id, name}。
 * 真实 topic 记录按 ts 最早一条定名（名字随 id 锁定）；老 state 只有名字时按名字派生 id（同名自动并线）。
 */
function topicsOf(snap) {
  const byId = new Map()
  const records = [...snap.records].sort((x, y) => (Date.parse(x.ts) || 0) - (Date.parse(y.ts) || 0))
  for (const r of records) {
    if (r.kind === TOPIC_KIND && r.id && !byId.has(r.id)) {
      byId.set(r.id, { id: r.id, name: String(r.body || '').trim() })
    }
  }
  for (const r of records) {
    if (r.kind !== 'state') continue
    const id = topicIdOf(r)
    if (!id || byId.has(id)) continue
    byId.set(id, { id, name: String(r.topic || '').trim() || '未命名' })
  }
  return byId
}

/** 铸造一个没被占用的 topic_id。 */
function mintTopicId(registry) {
  for (;;) {
    const id = 'tp_' + crypto.randomBytes(3).toString('hex')
    if (!registry.has(id)) return id
  }
}

/**
 * state 按 topic_id 分桶，每桶取最新一条 active，按 ts 倒序（V5 §5.2 并行多线）。
 * 同一工作区可以同时干几件事：写 state 时给 topic_id（或 new_topic 建新线）就各自成线。
 * `closed` = 该桶最新一条的 next 为空串（本线已完成，不进交接）。
 */
/**
 * 线内被否决的方案：conclusion + suspect:['vetoed'] + topic_id。
 * 否决属于某条线（不是跨线教训），所以随线显示在交接，线闭环后退出交接、只留 recall。
 */
function vetoesOf(snap) {
  return snap
    .byKind('conclusion')
    .filter((r) => Array.isArray(r.suspect) && r.suspect.includes('vetoed') && topicIdOf(r))
    .sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
}

function stateBucketsOf(snap) {
  const registry = topicsOf(snap)
  const states = [...snap.byKind('state')].sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
  const seen = new Set()
  const out = []
  for (const r of states) {
    const key = topicIdOf(r)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const name = (registry.get(key) || {}).name || String(r.topic || '').trim() || '未命名'
    out.push({ id: r.id, topicId: key, topicName: name, body: r.body, next: r.next || '', closed: !r.next, ts: r.ts })
  }
  const vetoes = vetoesOf(snap)
  for (const b of out) {
    b.vetoes = vetoes.filter((v) => topicIdOf(v) === b.topicId).slice(0, 2).map((v) => ({ id: v.id, body: v.body }))
  }
  return out
}

/**
 * 规约段渲染（section order 9410）。
 *
 * ★ 这一段进**系统提示**（= provider 缓存前缀），所以字节只能由「记忆内容」决定：
 *   - 排序键是纯函数 `(强度, id)`，不引用 lastSeen / 时钟；
 *   - 渲染时不刷 lastSeen（那是召回的事）——"读一遍记忆"不得改变前缀；
 *   - 易变的错误行（E_CONFIG）留在 tail（context 块），不污染前缀。
 *
 * 读盘失败时返回上一次成功的文本（`lastGoodRulesText`），首轮就失败则返回空串
 * （空 section 被宿主丢弃）——**绝不用错误行占位**，否则一次抖动就换掉整个前缀。
 */
let lastGoodRulesText = ''
function rulesTextFor(agent) {
  try {
    const snap = snapshot(agent)
    // 分片读不出来 ≠ 没有规则：沿用上一次成功的文本，别让一次抖动换掉整个前缀
    if (snap.storeError && lastGoodRulesText) return lastGoodRulesText
    const text = rulesTextOf(snap)
    lastGoodRulesText = text
    return text
  } catch (e) {
    noteError('render:rules', e)
    // 读盘失败沿用上一次成功的规约文本：错误行只走 tail（E_CONFIG/E_RENDER），
    // 绝不进 section——一次瞬时抖动不该作废整条历史的前缀。
    return lastGoodRulesText
  }
}

/** 诊断落到 <baseDir>/waystone/errors.log；`[trace:…]` 前缀区分正常留痕与异常。 */
function note(where, line) {
  try {
    const dir = path.join(store.baseDirOf(ctxRef), 'waystone')
    store.ensureDir(dir)
    store.appendText(path.join(dir, 'errors.log'), store.nowIso() + ' [' + where + '] ' + line + '\n')
  } catch {
    /* 诊断自身失败绝不影响会话 */
  }
}

/** 渲染/存储异常的落盘诊断（V5 §5.4：注入只给一行 code，原因与下一步留给 doctor/日志）。 */
function noteError(where, error) {
  note(where, String((error && error.stack) || error))
}

/** 正常路径的排查留痕：同一条 errors.log，靠 `trace:` 前缀与异常区分。 */
function noteTrace(where, info) {
  note('trace:' + where, String(info))
}

/** 尾部 context（目录 → 指南索引 → 交接），状态段永远在最末。 */
/**
 * 交接段预算：占 injectBudgetTokens 的 55%（默认 1500 → 825 tok）。
 * 交接段要装得下并行线：前 3 条带 body/next，第 4 条起降级成「名称 (tp_id)：下一步」，
 * 最多再列 6 条——旧上限 3 条会把第 4 条以后的线整条丢掉，模型永远不知道它还开着。
 * 这一段进的是 context 尾部，不是缓存前缀——放宽不会破坏字节稳定。
 */
const TAIL_BUDGET_RATIO = 0.55
const tailBudgetOf = (budget) => Math.max(300, Math.floor(budget * TAIL_BUDGET_RATIO))

function tailTextFor(agent) {
  try {
    const st = sessionState(agent)
    const snap = snapshot(agent)
    const budget = snap.cfg.config.injectBudgetTokens
    const texts = []

    // 判官降级提示（V5 §3.2）：注入尾部一行，用户与模型都能看见
    if (st.judgeDisabled) texts.push('[记忆判官不可用，已降级为手动写入]')

    // 写错了/读错了也让人看见（V5 §5.4）；带字段路径，别只给一个码
    if (snap.cfg.error) texts.push(renderUnavailable('E_CONFIG', firstFieldPath(snap.cfg.error)))
    if (snap.root.error) texts.push(renderUnavailable('E_CONFIG', firstFieldPath(snap.root.error)))
    // 分片读不出来：错误只在这里可见，section 那边已保住上一次的文本
    if (snap.storeError) texts.push(renderUnavailable('E_STORE', ''))

    const recentUser = st.userMessages.slice(-3).join('\n')
    const buckets = stateBucketsOf(snap)
    // 记忆库库存：fact / 普通 conclusion 从不进上下文，没有这一行模型不知道"库里还压着几条没看"。
    // 只给条数不给内容（进的是尾部 context，不是缓存前缀，不破坏字节稳定）。
    const inv = [
      ['线', buckets.filter((b) => !b.closed).length],
      ['rule', snap.byKind('rule').length],
      ['guide', snap.byKind('guide').length],
      ['fact', snap.byKind('fact').length],
      ['conclusion', snap.byKind('conclusion').length],
      ['deadend', snap.byKind('deadend').length],
    ].filter(([, n]) => n > 0)
    const cm = readJsonMeta(snap.dirs.workspaceDir, COMPACT_FILE)
    const compactStamp = cm && Number.isInteger(cm.before) ? '（上次整理：' + cm.before + ' → ' + cm.after + ' 条）' : ''
    if (inv.length) texts.push('[记忆库] ' + inv.map(([k, n]) => k + ' ' + n).join(' · ') + compactStamp + ' —— 需要时 waystone_recall')
    const profileRec = profileFactOf(snap)
    const body = renderTail({
      stateBuckets: buckets,
      activeDeadends: snap.byKind('deadend'),
      activeGuides: snap.byKind('guide'),
      profile: profileRec ? profileRec.body : '',
      recentUserText: recentUser,
      budgetTokens: tailBudgetOf(budget),
      rotate: st.lastTurn, // 死路窗口按轮次跳 3 条轮转；tail 是动态 context，不进缓存前缀
    })
    texts.push(body)

    for (const g of hitGuides(snap.byKind('guide'), recentUser)) lastSeen.set(g.id, Date.now())

    const out = texts.filter(Boolean).join('\n\n')
    st.injected = out
    // 只在字节变化时记一条：注入没变时每一步都会重渲染，全记会把「最近几次」刷成同一行的噪音
    const digest = crypto.createHash('sha256').update(out).digest('hex').slice(0, 16)
    const last = st.injections[st.injections.length - 1]
    if (!last || last.sha256 !== digest) {
      st.injections.push({ turn: st.lastTurn, bytes: Buffer.byteLength(out, 'utf8'), sha256: digest })
      if (st.injections.length > 10) st.injections.shift()
    }
    return out
  } catch (e) {
    noteError('render:tail', e)
    return renderUnavailable('E_RENDER')
  }
}

// ───────────────────────────── 写入 ─────────────────────────────

/**
 * turn 锚点补全：模型不知道自己的 sid/turn，判官知道。缺啥用会话事实填，
 * 缺 quote 用 body 兜底——否则 conclusion/fact 想锚"本轮观察"永远写不进来。
 */
function fillTurnAnchor(rec, st) {
  const a = rec.anchor
  if (!a || a.type !== 'turn') return rec
  rec.anchor = {
    ...a,
    sid: a.sid || st.sid,
    turn: Number.isInteger(a.turn) ? a.turn : (rec.turn || 1),
    quote: a.quote || rec.body,
  }
  return rec
}

/**
 * 统一写路径（工具与判官共用）：逐条确定性校验 → 冲突树 → 追加分片 → 配额淘汰 → 跨作用域去重。
 * V5 §4.1（硬拒）/ §4.3（淘汰不拒）/ §4.4（冲突判定树）/ §2.1（跨库重复）。
 */
function writeRecords(agent, rawRecords, opts = {}) {
  const snap = snapshot(agent)
  const st = sessionState(agent)
  const probe = store.makeProbe()
  const accepted = []
  const rejected = []
  const warnings = []
  const rulesMax = snap.cfg.config.rulesMax

  const append = (dir, record) => store.appendRecord(dir, st.sid, record)
  const registry = topicsOf(snap)
  const minted = {}
  const rejectUnknownTopic = (index, id) => {
    const list = [...registry.values()].slice(0, 8).map((t) => t.id + ' ' + t.name).join(' / ') || '（无）'
    rejected.push({ index, code: 'E_TOPIC_UNKNOWN', message: '未知 topic_id：' + id + '；现有：' + list })
  }

  rawRecords.forEach((raw, index) => {
    const rec = {
      v: 1,
      id: raw.id || newId(),
      ts: raw.ts || store.nowIso(),
      sid: st.sid,
      turn: Number.isInteger(raw.turn) ? raw.turn : (st.lastTurn || 1),
      kind: raw.kind,
      scope: raw.scope || 'workspace',
      topic: typeof raw.topic === 'string' ? raw.topic.trim() : '',
      topic_id: typeof raw.topic_id === 'string' ? raw.topic_id.trim() : '',
      new_topic: typeof raw.new_topic === 'string' ? raw.new_topic.trim() : '',
      body: typeof raw.body === 'string' ? raw.body.trim() : raw.body,
      criteria: raw.criteria,
      next: raw.next,
      anchor: raw.anchor,
      source: raw.source,
      strength: raw.strength || 'inferred',
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
      suspect: Array.isArray(raw.suspect) ? raw.suspect : [],
      supersedes: raw.supersedes,
      retracts: raw.retracts,
      reason: raw.reason,
    }
    if (rec.kind === INTERNAL_KIND || rec.kind === TOPIC_KIND) {
      rejected.push({ index, code: 'E_SCHEMA', message: (rec.kind === TOPIC_KIND ? 'topic' : 'expire') + ' 是内部记录，不接受直接写入' })
      return
    }
    fillTurnAnchor(rec, st)

    // ---- state 的 topic：只认 topic_id；新线才收 new_topic（铸造 topic_id + 落一条 topic 记录）----
    if (rec.kind === 'state') {
      if (rec.new_topic) {
        const clash = [...registry.values()].find((t) => t.name === rec.new_topic)
        if (clash) {
          rejected.push({ index, code: 'E_TOPIC_EXISTS', message: '已存在同名 topic：' + clash.id + '（' + clash.name + '），请直接用该 topic_id' })
          return
        }
        const id = mintTopicId(registry)
        rec.topic_id = id
        rec.topic = rec.new_topic
        registry.set(id, { id, name: rec.new_topic })
        minted[id] = rec.new_topic
        // topic 记录先落盘（id → 名字）：之后任何人都只能按这个名字引用它
        try {
          append(rec.scope === 'global' ? snap.dirs.globalDir : snap.dirs.workspaceDir, {
            v: 1, id, ts: rec.ts, sid: st.sid, turn: rec.turn, kind: TOPIC_KIND, scope: rec.scope, body: rec.new_topic,
          })
        } catch (e) {
          rejected.push({ index, code: 'E_STORE', message: 'topic 记录写失败：' + String(e && e.message) })
          return
        }
      } else if (rec.topic_id) {
        if (!registry.get(rec.topic_id)) {
          rejectUnknownTopic(index, rec.topic_id)
          return
        }
        // 名字由注册表锁定：同 id 只有一个名字
        rec.topic = registry.get(rec.topic_id).name
      } else {
        rejected.push({ index, code: 'E_TOPIC', message: 'state 必须给 topic_id（逐字抄 [交接]/召回）或 new_topic（确实是新线）' })
        return
      }
      delete rec.new_topic
    } else if (rec.topic_id) {
      // 非 state 也可以认线：被否决的方案（conclusion + suspect:['vetoed']）会随该线显示在交接里
      if (!registry.get(rec.topic_id)) {
        rejectUnknownTopic(index, rec.topic_id)
        return
      }
      rec.topic = registry.get(rec.topic_id).name
    }

    // 判官判 global 必须带原话依据，否则强制降级（V5 §3.2 / §2.1）
    if (opts.origin === 'judge' && rec.scope === 'global') {
      const downgraded = enforceScope(rec, opts.why, st.userMessages)
      if (downgraded.scope !== 'global') rec.suspect = downgraded.suspect
      rec.scope = downgraded.scope
    }

    const verdict = validateRecord(rec, { userMessages: userTextsOf(agent, st), probe })
    if (!verdict.ok) {
      rejected.push({ index, code: verdict.code, message: verdict.message })
      return
    }

    // 判同：哈希/关键词只召回候选，判同交判官 —— 这里只做"逐字节相同"的确定性去重
    const identicalGlobal = rec.scope === 'workspace' && rec.kind === 'rule'
      ? snap.active.find((r) => r._scope === 'global' && r.kind === 'rule' && r.body === rec.body && (r.criteria || '') === (rec.criteria || ''))
      : null

    // 冲突判定树（V5 §4.4）：state 按 topic_id 分桶（老记录按名字派生 id），其它 kind 仍要显式 topic + 同 criteria 轴
    const wantTopic = topicIdOf(rec)
    const isTwin = (r) => r.kind === rec.kind
      && r.id !== rec.id
      && (rec.kind === 'state'
        ? Boolean(wantTopic) && topicIdOf(r) === wantTopic
        : Boolean(rec.topic) && r.topic === rec.topic && (r.criteria || '') === (rec.criteria || ''))
    const twins = snap.active.filter(isTwin)

    let supersedes = rec.supersedes
    if (!supersedes && twins.length) {
      if (rec.kind === 'state') {
        // 桶内单槽：新 state 恒取代桶内最新那条（状态是快照，最新的才算当前）
        supersedes = twins.reduce((a, b) => ((Date.parse(b.ts) || 0) > (Date.parse(a.ts) || 0) ? b : a)).id
      } else {
        const cmp = cmpStrength(rec.kind, rec.strength, twins[0].strength)
        if (cmp > 0) supersedes = twins[0].id
        else if (cmp === 0 && rec.kind === 'rule') supersedes = twins[0].id // 规约永不并列
        // 同类结论同强度：两条同时 active（不写 supersedes）
      }
    }
    if (supersedes) rec.supersedes = supersedes

    const dirOf = (scope) => (scope === 'global' ? snap.dirs.globalDir : snap.dirs.workspaceDir)
    try {
      append(dirOf(rec.scope), rec)
    } catch (e) {
      rejected.push({ index, code: 'E_STORE', message: String(e && e.message) })
      return
    }
    accepted.push(rec.id)
    if (rec.topic) {
      st.topicWrite = true
      st.topic = rec.topic
    }

    // 同桶残留的旧 state 一并收口（含本改造之前写入的、一直 active 的历史状态）：
    // 状态是快照，历史不留在注入面，只能在 waystone_recall(include_expired) 里查到。
    if (rec.kind === 'state') {
      for (const t of twins) {
        if (t.id === supersedes) continue
        append(dirOf(rec.scope), {
          v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: st.lastTurn,
          kind: INTERNAL_KIND, target: t.id, reason: 'state-superseded-by: ' + rec.id,
        })
      }
    }

    // 弱于现有同轴条目：仍落盘（append-only 不丢信息），随后写 expire 让它不参与注入
    if (!supersedes && twins[0] && cmpStrength(rec.kind, rec.strength, twins[0].strength) < 0) {
      append(dirOf(rec.scope), {
        v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: st.lastTurn,
        kind: INTERNAL_KIND, target: rec.id, reason: 'strength-below-existing: ' + twins[0].id,
      })
    }

    // 跨库逐字节重复：保留 global，本工作区那条写 expire（V5 §2.1）
    if (identicalGlobal) {
      append(dirOf('workspace'), {
        v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: st.lastTurn,
        kind: INTERNAL_KIND, target: rec.id, reason: 'duplicate-of-global: ' + identicalGlobal.id,
      })
      warnings.push({ index, code: 'duplicate_of_global', against: identicalGlobal.id })
    }

    // 配额淘汰（V5 §4.3）：新条目恒可进，超限就写 expire 指向最久未命中 + 最低强度那条
    if (rec.kind === 'rule') {
      const fresh = snapshot(agent)
      const scoped = fresh.byKind('rule').filter((r) => r._scope === rec.scope)
      const victim = quotaVictim(scoped, rulesMax, (id) => lastSeen.get(id) || Date.parse((scoped.find((r) => r.id === id) || {}).ts) || 0)
      if (victim && victim !== rec.id) {
        append(dirOf(rec.scope), {
          v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: st.lastTurn,
          kind: INTERNAL_KIND, target: victim, reason: 'E_QUOTA_EVICT: rules>' + rulesMax,
        })
        warnings.push({ index, code: 'E_QUOTA_EVICT', against: victim })
      }
    }

    // "waystone_write 之后的下一轮"曾是边界轮（V5 §5.1），该注入行已删除（见 render.js 注释）
  })

  return { accepted, rejected, warnings, topics: minted }
}

// ───────────────────────────── 判官 ─────────────────────────────

function currentSelection() {
  try {
    const svc = ctxRef.get('agentDefaultModel')
    if (svc && typeof svc.currentSelection === 'function') return svc.currentSelection()
  } catch {
    /* 取不到就按不可用处理 */
  }
  return null
}

async function runJudge(agent, turn) {
  const st = sessionState(agent)
  if (unloaded) return
  if (st.judgeDisabled || st.judgeBusy) return
  if (judgeRunning >= JUDGE_MAX_CONCURRENT) {
    // 超限是静默跳过（不消费本轮观察，留到下一轮）。至少留一条痕迹，否则调了并发数
    // 也不知道跳过还在不在发生。
    noteTrace('judge:busy-skip', 'running=' + judgeRunning + ' max=' + JUDGE_MAX_CONCURRENT + ' turn=' + turn)
    return // 有界并发：超限留到下一轮，不消费本轮观察
  }
  const reasons = shouldJudge({
    filesTouched: st.filesTouched,
    sawError: st.sawError,
    userMessages: st.userMessages.slice(-6),
    topicWrite: st.topicWrite,
  })
  const observation = {
    userMessages: st.userMessages.slice(-6),
    assistantText: st.assistantText,
    topicWrite: st.topicWrite,
  }
  freshObservation(st)
  if (!reasons.length) return

  const snap = snapshot(agent)
  const stateRec = [...snap.byKind('state')].sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))[0]
  const rules = snap.byKind('rule').map((r) => ({ id: r.id, body: r.body }))
  const topics = stateBucketsOf(snap).map((b) => ({ id: b.topicId, name: b.topicName, next: b.next }))
  // 判官看不到已有死路就会把同一件事再写一遍（实测：两个并发会话 45 秒内各写了一条同义死路）。
  // 死路是语义判同，交给判官：把现成的 8 条摆进输入，让它自己认。
  const deadends = [...snap.byKind('deadend')]
    .sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
    .slice(0, 8)
    .map((d) => ({ id: d.id, body: d.body }))
  // 判官看不到已有 fact 就只能新写，旧事实永远留着（实测 24h 冷却早删了还在复读）；
  // 给它最新 20 条做对照，才能把「新结论推翻旧事实」写成 supersedes。项目档案本身不参与。
  const facts = [...snap.byKind('fact')]
    .filter((r) => !(Array.isArray(r.suspect) && r.suspect.includes('profile')))
    .sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
    .slice(0, 20)
    .map((r) => ({ id: r.id, body: r.body }))
  const input = buildJudgeInput({
    userMessages: observation.userMessages,
    assistantText: observation.assistantText,
    rules,
    topics,
    deadends,
    facts,
    stateNext: stateRec && stateRec.next,
    currentTopic: st.topic,
  }).user.replace('__SID__', st.sid).replace('__TURN__', String(turn))
  const system = buildJudgeInput({}).system
  const inputHash = crypto.createHash('sha256').update(system + '\n' + input).digest('hex')

  st.judgeBusy = true
  judgeRunning += 1
  try {
    const llm = ctxRef.get('llm')
    const signal = judgeSignal(judgeAbort ? judgeAbort.signal : undefined)
    const raw = await callJudge({ llm, selection: currentSelection(), input: { system, user: input }, signal })
    if (unloaded) return
    const parsed = parseJudgeOutput(raw)
    const why = parsed.why
    let records = parsed.records
    if (parsed.skip || !records.length) {
      store.appendJudgeAudit(snap.dirs.workspaceDir, st.sid, { ts: store.nowIso(), turn, sid: st.sid, inputHash, output: raw, accepted: [], rejected: [], reasons })
      st.judgeFailures = 0
      return
    }
    // state 节流（V5 §3.2）：非四类强触发时每 5 轮合并一次；接受最多 5 轮滞后
    const strong = reasons.includes('user-correction') || reasons.includes('topic-progress')
    if (!strong && turn - st.lastStateWriteTurn < STATE_THROTTLE_TURNS) {
      records = records.filter((r) => r && r.kind !== 'state')
    }
    const hadState = records.some((r) => r && r.kind === 'state')
    // 结论/事实每轮各至多 1 条：不定闸门时判官把"改了什么/讨论经过"也写成 conclusion，
    // 实测一天 47 条流水账，而这些 kind 从不进上下文 ⇒ 只写不读。
    const beforeCap = records.length
    records = capNarrative(records)
    const droppedNarrative = beforeCap - records.length
    const res = writeRecords(agent, records, { origin: 'judge', why })
    if (hadState && res.accepted.length) st.lastStateWriteTurn = turn
    // 判官审计落盘：输入哈希 + 输出 + 采纳结果，可复算（V5 §3.2）
    store.appendJudgeAudit(snap.dirs.workspaceDir, st.sid, {
      ts: store.nowIso(), turn, sid: st.sid, inputHash, output: raw,
      accepted: res.accepted, rejected: res.rejected, warnings: res.warnings, reasons, why,
      droppedNarrative,
    })
    st.judgeFailures = 0
  } catch (e) {
    // 卸载后连审计都不写：此时 ctxRef 已空，数据根会回落 ~/.dsh
    if (unloaded) return
    // 卸载/重载触发的 abort 不算失败：它说明这次判官被有意取消，不是判官坏了
    const aborted = !!(judgeAbort && judgeAbort.signal.aborted)
    if (!aborted) {
      st.judgeFailures += 1
      if (st.judgeFailures >= JUDGE_MAX_FAILURES) st.judgeDisabled = true
    }
    try {
      const snap2 = snapshot(agent)
      store.appendJudgeAudit(snap2.dirs.workspaceDir, st.sid, {
        ts: store.nowIso(), turn, sid: st.sid, inputHash, output: null,
        accepted: [], rejected: [], reasons, aborted, error: String((e && e.message) || e),
      })
    } catch {
      /* 审计失败不阻塞 */
    }
  } finally {
    st.judgeBusy = false
    judgeRunning -= 1
  }
}

// ───────────────────────────── 整理（合并） ─────────────────────────────

const COMPACT_FILE = 'compact.json'
const PROFILE_FILE = 'profile.json'

/** 整理/档案的旁路元数据（落盘：冷却、指纹与尾部提示都要跨重启看到）。读不到 = null。 */
function readJsonMeta(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  } catch {
    return null
  }
}

function writeJsonMeta(dir, name, meta) {
  try {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(meta), 'utf8')
  } catch {
    /* 记不下最多多做一次，不影响主流程 */
  }
}

/** 当前生效的项目档案（最新一条 suspect:['profile'] 的 fact）。 */
function profileFactOf(snap) {
  return [...snap.byKind('fact')]
    .filter((r) => Array.isArray(r.suspect) && r.suspect.includes('profile'))
    .sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))[0]
}

let compactRunning = false
/**
 * 整理官：conclusion/fact 超限时，把讲同一件事的多条压成一条（信息保留、条数下降）。
 *
 * 与判官同构（llm.stream 一次调用 → 严格 JSON → 确定性校验 → append-only 落盘），
 * 但**不**走 writeRecords：合并结果不该再参与判同/配额那套，也不该被"弱于现有同轴条目"悄悄 expire。
 * 旧记录靠 retracts 变 expired —— 原文仍在盘上，include_expired 能取回。
 */
async function maybeCompact(agent, turn) {
  if (unloaded) return
  if (compactRunning) {
    noteTrace('compact:busy', 'turn=' + turn)
    return
  }
  let st
  let snap
  try {
    st = sessionState(agent)
    snap = snapshot(agent)
  } catch (e) {
    noteError('compact:snapshot', e)
    return
  }
  // 被否决记录也进合并队列；能不能合交给 compact.pickMerges 守：
  // 只允许「同为已否决 + 同一条线」成组（混组会把否决糊到普通结论上，跨线合并后挂不回任何一条线）。
  // 项目档案（suspect:['profile']）是汇总产物，不参与合并，否则会被当普通事实合掉、档案就没了。
  const pool = [...snap.byKind('conclusion'), ...snap.byKind('fact')]
    .filter((r) => !(Array.isArray(r.suspect) && r.suspect.includes('profile')))
  const conclusion = pool.filter((r) => r.kind === 'conclusion').length
  const fact = pool.filter((r) => r.kind === 'fact').length
  const meta = readJsonMeta(snap.dirs.workspaceDir, COMPACT_FILE)
  const cfg = snap.cfg.config
  if (!shouldCompact({ conclusion, fact }, { conclusion: cfg.compactConclusionMax, fact: cfg.compactFactMax })) {
    noteTrace('compact:not-due', 'conclusion=' + conclusion + ' fact=' + fact + ' last=' + ((meta && meta.after) || '-'))
    return
  }
  const llm = ctxRef.get('llm')
  const selection = currentSelection()
  if (!llm || !selection) {
    // 取不到模型就当没到时机，下轮再说，不计失败
    noteTrace('compact:no-llm', 'llm=' + !!llm + ' selection=' + JSON.stringify(selection || null))
    return
  }

  compactRunning = true
  const before = conclusion + fact
  // 失败时把模型原始输出带进审计（截断 2000 字）：没有它，超时/空输出/写坏 JSON 三种情况
  // 在日志里长得一模一样，只能靠猜。
  let raw = ''
  noteTrace('compact:run', 'turn=' + turn + ' conclusion=' + conclusion + ' fact=' + fact + ' model=' + (selection && selection.model))
  const stamp = store.nowIso()
  const turnNo = Number.isInteger(turn) ? turn : st.lastTurn
  try {
    // 每次只送最新的 compactBatch 条（默认 60），40% 目标按这一批算（60 条 → 36 条）。
    // 收敛靠「失败不冷却 + 每轮重跑」：合并后 pool 若仍超阈值，下一轮再取最新一批，直到落回阈值以下。
    // 已知代价（接受）：① pool 远超批次大小时，最旧那批永远进不了窗口，不会被整理；
    // ② 上一轮合并出的新记录 ts 最新，会再次进窗，可能被重复合并、body 逐轮重写。
    // 两条都不是错合并（原文留在被 retracts 的旧记录里），但会多花一次调用。
    // 按 topic 分桶不是出路：存量里 21% 的 conclusion 没有 topic，同一件事还会被写成 3~4 个
    // 不同名字，严格分桶只会把同义分裂固化（结论 as_15919e）。所以只保留尾部窗口 + 多轮收敛。
    const batch = pool.slice(-cfg.compactBatch)
    const target = shrinkTarget(batch.length)
    const input = buildCompactInput({ records: batch })
    // 输出预算：MAX_GROUPS(8) 组 × (body ≤500 字 + quote 200 字) + JSON 结构 ≈ 4k token，留余量取 6000。
    raw = await callJudge({ llm, selection, input, signal: judgeSignal(judgeAbort ? judgeAbort.signal : undefined), maxTokens: 6000 })
    if (unloaded) return
    const dropped = []
    const ops = pickMerges(parseCompactOutput(raw).groups, batch, dropped)
    const accepted = []
    const rejected = []
    const pending = []
    for (const op of ops) {
      const rec = {
        v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: turnNo,
        kind: op.kind, body: op.body, strength: op.strength,
        anchor: { type: 'turn', sid: st.sid, turn: turnNo, quote: op.quote },
        source: { author: 'model', quote: op.quote },
        retracts: op.retracts,
      }
      if (op.topic) rec.topic = op.topic
      // 被否决的合并结果必须保留否决标记与 topic_id：否则页面认不出「✗ 已否决」、交接子行也挂不回线
      if (op.suspect) rec.suspect = op.suspect
      if (op.topicId) rec.topic_id = op.topicId
      // 合并记录有单独的正文上限（提炼多条长事实天然超 500），普通写入仍守 500
      const verdict = validateRecord(rec, { maxBody: MERGE_BODY_MAX_CHARS })
      if (!verdict.ok) {
        rejected.push({ index: pending.length + rejected.length, code: verdict.code, message: verdict.message })
        continue
      }
      pending.push(rec)
    }
    // 净减护栏（C）已降级为**警告**，不再整批作废：整批作废会让「个别组超长」拖死全部可用的组
    // （2026-11-06 实测 turn 12：8 组里 4 组 body 超 800 被丢，剩下 60→54 不到硬底线 48，结果一条都没合）。
    // 现在按「已通过校验的组」照常落盘；被丢的组不 retract 来源，原记录保持 active，下一轮仍是候选。
    // 40% 仍是提示词目标、20% 是参考底线，靠多轮收敛。
    const retracted = pending.reduce((n, r) => n + (Array.isArray(r.retracts) ? r.retracts.length : 0), 0)
    const warnings = []
    if (!meetsShrink({ before: batch.length, retracted, added: pending.length })) {
      warnings.push({
        code: 'E_SHRINK',
        message: '净减不足：' + batch.length + ' → ' + (batch.length - retracted + pending.length)
          + '，硬底线 ≤ ' + hardTarget(batch.length) + '（目标 ≤ ' + target + '）；仍按已过校验的组落盘',
      })
    }
    for (const rec of pending) {
      try {
        store.appendRecord(snap.dirs.workspaceDir, st.sid, rec)
        accepted.push(rec.id)
      } catch (e) {
        rejected.push({ index: accepted.length + rejected.length, code: 'E_STORE', message: String(e && e.message) })
      }
    }
    // 没有冷却：成功后 pool 自然落回阈值以下就不会再跑；失败（E_SHRINK/E_STORE）下一轮接着试。
    // meta 只留 before/after 给注入行做「上次整理」展示，不写任何时间戳。
    const after = accepted.length ? before - retracted + accepted.length : before
    if (accepted.length) writeJsonMeta(snap.dirs.workspaceDir, COMPACT_FILE, { before, after })
    store.appendJudgeAudit(snap.dirs.workspaceDir, st.sid, {
      ts: stamp, turn: turnNo, sid: st.sid, origin: 'compact', output: raw, accepted, rejected, before, after, dropped, warnings,
    })
    noteTrace('compact:done', 'before=' + before + ' after=' + after + ' accepted=' + accepted.length
      + ' rejected=' + JSON.stringify(rejected.map((r) => r.code))
      + ' dropped=' + JSON.stringify(dropped.map((d) => d.code + ':' + d.chars))
      + ' warn=' + JSON.stringify(warnings.map((w) => w.code)))
  } catch (e) {
    // 整理失败绝不影响会话，也不计入判官失败计数；同样不占冷却，下一轮重试
    noteError('compact:failed', e)
    try {
      store.appendJudgeAudit(snap.dirs.workspaceDir, st.sid, {
        ts: stamp, turn: turnNo, sid: st.sid, origin: 'compact',
        output: raw ? raw.slice(0, 2000) : null, accepted: [], rejected: [], before, error: String((e && e.message) || e),
      })
    } catch {
      /* 审计失败不阻塞 */
    }
  } finally {
    compactRunning = false
  }
}

let profileRunning = false
/**
 * 项目档案：把工作区里的 fact 汇总成一段「怎么构建/测试/运行」的摘要，注入 tail 的 [项目档案] 段。
 *
 * 与判官/整理官同构（一次 LLM 调用 → 严格 JSON → 确定性校验 → append-only），
 * 但只在**事实集合变化**时跑（profile.json 存 hash）：事实没变 0 调用、0 token。
 * 写出的是一条 fact（suspect:['profile']），旧档案用 retracts 撤回——原文仍可取回。
 */
async function maybeProfile(agent, turn) {
  if (unloaded) return
  if (profileRunning) return
  let st
  let snap
  try {
    st = sessionState(agent)
    snap = snapshot(agent)
  } catch (e) {
    noteError('profile:snapshot', e)
    return
  }
  // 档案本身不参与原料：否则拿自己当输入，每次都会变
  const facts = [...snap.byKind('fact')]
    .filter((r) => !(Array.isArray(r.suspect) && r.suspect.includes('profile')))
  if (facts.length < 2) return
  // 指纹 = 事实集合 + 档案格式版本：只改提示词/格式时也能触发一次重生成
  const hash = profileHash(facts) + '|' + PROFILE_PROMPT_VERSION
  const meta = readJsonMeta(snap.dirs.workspaceDir, PROFILE_FILE)
  if (meta && meta.hash === hash) return
  const llm = ctxRef.get('llm')
  const selection = currentSelection()
  if (!llm || !selection) {
    noteTrace('profile:no-llm', 'facts=' + facts.length)
    return
  }

  profileRunning = true
  const stamp = store.nowIso()
  const turnNo = Number.isInteger(turn) ? turn : st.lastTurn
  try {
    // 只送最新的 40 条：更老的事实要么已被覆盖，要么与当前环境无关，全量送只会撑大输入
    const batch = facts.slice(-40)
    const input = buildProfileInput({
      facts: batch,
      project: path.basename(st.cwd || '') || '',
    })
    const raw = await callJudge({ llm, selection, input, signal: judgeSignal(judgeAbort ? judgeAbort.signal : undefined), maxTokens: 3000 })
    if (unloaded) return
    const picked = pickProfile(parseProfileOutput(raw))
    if (!picked) {
      // 模型判定「没有可汇总的」：记下 hash，避免事实不变时每轮重试
      noteTrace('profile:skip', 'facts=' + facts.length)
      writeJsonMeta(snap.dirs.workspaceDir, PROFILE_FILE, { hash, id: (meta && meta.id) || '', ts: stamp })
      return
    }
    // 概括正文 + 插件拼的来源 id：需要细节时按 id recall（旧 fact 可能 expired，需 include_expired）
    const body = attachSources(picked.body, batch)
    const rec = {
      v: 1, id: newId(), ts: store.nowIso(), sid: st.sid, turn: turnNo,
      kind: 'fact', body, strength: 'inferred',
      suspect: ['profile'], topic: '项目档案',
      anchor: { type: 'turn', sid: st.sid, turn: turnNo, quote: picked.quote || picked.body.slice(0, 200) },
      source: { author: 'model', quote: picked.quote || picked.body.slice(0, 200) },
    }
    // 旧档案必须撤回，否则会在面板里并排两条；meta 丢了也能从库里找到上一条
    const previous = (meta && meta.id) || (profileFactOf(snap) || {}).id
    if (previous) rec.retracts = previous
    const verdict = validateRecord(rec, { maxBody: PROFILE_MAX_CHARS, allowNewlines: true })
    if (!verdict.ok) {
      noteTrace('profile:invalid', verdict.code)
      writeJsonMeta(snap.dirs.workspaceDir, PROFILE_FILE, { hash, id: (meta && meta.id) || '', ts: stamp })
      return
    }
    store.appendRecord(snap.dirs.workspaceDir, st.sid, rec)
    writeJsonMeta(snap.dirs.workspaceDir, PROFILE_FILE, { hash, id: rec.id, ts: rec.ts })
    store.appendJudgeAudit(snap.dirs.workspaceDir, st.sid, {
      ts: stamp, turn: turnNo, sid: st.sid, origin: 'profile', output: raw,
      accepted: [rec.id], rejected: [], hash, chars: rec.body.length,
    })
    noteTrace('profile:done', 'chars=' + rec.body.length + ' facts=' + facts.length)
  } catch (e) {
    // 档案失败不影响会话，也不占冷却：事实没变、hash 没落盘，下一轮自然重试
    noteError('profile:failed', e)
  } finally {
    profileRunning = false
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

function toolOutput(value) {
  return { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

export const RECORD_PROPERTIES = {
  kind: { type: 'string', description: 'state=做到哪了；rule=用户下的硬要求（原话须是命令/要求句，疑问句、评价句、单次纠正不算）；guide=下次能照着跑的有序步骤（含命令/路径/检查点；约束、原则、一次性改动记录不算）；deadend=踩过的坑/犯过的错（只收外部世界——工具/API/环境/平台——不按预期的教训；已修复的代码缺陷、关于记忆系统自身写法的反思都不写；用户否决过的方案不算坑，写 conclusion + topic_id + suspect:[\'vetoed\']）；fact=单点环境事实或可重读的指针；conclusion=带依据的判断（必须附 source.quote 依据原文）。环境事实与判断优先用 turn 锚点' },
  scope: { type: 'string', description: '默认 workspace：话里带具体项目/目录/文件/命令/工具链算工作区规约。global 只有 rule 能进，仅当用户说「以后都/所有项目/每台机器/禁止」这类跨项目要求时才给，且需用 source.quote 复述原话，否则静默降级' },
  topic: { type: 'string', description: '其它 kind 用它做同轴判同（可空）；state 不再用它认线，改走 topic_id / new_topic' },
  topic_id: { type: 'string', description: 'state 必填（除非给 new_topic）；其它 kind 也可以用它把记录挂到某条线——例如被否决的方案（conclusion + suspect vetoed）会随该线显示在交接。一律从 [交接] 或 waystone_recall 里逐字抄的 tp_1a2b3c，抄错会被拒（E_TOPIC_UNKNOWN）' },
  new_topic: { type: 'string', description: '仅当这是新线时给名字：系统铸造 topic_id 并在返回的 topics 里告诉你。同名已存在会被拒并返回现成 id（E_TOPIC_EXISTS）' },
  body: { type: 'string', description: '≤' + BODY_MAX_CHARS + ' 字单行；事实只留指针' },
  criteria: { type: 'string', description: 'rule/guide 必填：怎么算违规 / 怎么算跑通' },
  next: { type: 'string', description: '仅 state：下一步一句话；写空串 = 本线已闭环（不进交接，记录仍保留）' },
  anchor: {
    type: 'object',
    description: 'file{path,line,quote,sha256} | turn{sid,turn,quote} | url{url,fetched_at,sha256}。conclusion/fact 记环境事实或判断时优先 turn（可只写 {type:"turn"}，sid/turn/quote 由系统补）',
  },
  source: { type: 'object', description: '{author:"user"|"model"|"tool", quote:"用户原话片段"}' },
  strength: { type: 'string', description: 'user_said|measured|inferred。rule/guide/deadend 序为 user_said>measured>inferred（看用户原话）；conclusion/fact 序为 measured>user_said>inferred（看实测，用户记错事实时不许顶到最高）' },
  confidence: { type: 'number', description: '0~1' },
  suspect: { type: 'array', description: '语义层自评标记：criteria_weak（判据虚，注入显示为[未复核]）、maybe_dup（可能与既有条目重复）、vetoed（用户否决过的方案，只用在 conclusion + topic_id 上，会缩进显示在该线下面）' },
  supersedes: { type: 'string', description: '本条取代的记录 id' },
  retracts: { type: 'string', description: '本条撤回的记录 id；可传 id 数组一次撤多条（治理时避免一条噪音换一条）' },
  reason: { type: 'string', description: '一句话说清为什么' },
}

function buildTools() {
  return [
    {
      name: 'waystone_write',
      description: '写工作记忆（默认交给回合末判官；只在这四种情况主动写：用户明确纠正/下硬要求、发现记忆有错、确认了可复用步骤、某条线已经完成——你自己验证过或用户确认都算，写完 next 空串闭环，别等判官）。一次调用批量提交 records 数组。',
      parameters: {
        type: 'object',
        properties: { records: { type: 'array', items: { type: 'object', properties: RECORD_PROPERTIES } } },
        required: ['records'],
      },
      output: toolOutput(),
      async execute(args) {
        const agent = args && args.__agent
        const list = args && Array.isArray(args.records) ? args.records : []
        if (!list.length) return { accepted: [], rejected: [{ index: 0, code: 'E_SCHEMA', message: 'records 为空' }], warnings: [] }
        return writeRecords(agent, list, { origin: 'tool' })
      },
    },
    {
      name: 'waystone_recall',
      description: '按键词或 id 取回旧记忆（指南全文只能用这个取）。query 里可直接放记录 id（as_1a2b3c）或 topic id（tp_1a2b3c）按 id 取；scope 默认 all = 全局 + 当前工作区；无 embedding，按命中词数/强度/更新时间排序。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，按空白切词做子串命中；也可直接传记录 id（as_1a2b3c）或 topic id（tp_1a2b3c），按 id 取回' },
          kind: { type: 'string', description: '只看某一类：state|rule|conclusion|guide|fact|deadend' },
          scope: { type: 'string', description: 'all（默认）| global | workspace' },
          topic: { type: 'string', description: '按议题过滤；可直接传 tp_1a2b3c（交接行首那个）' },
          include_expired: { type: 'boolean', description: '是否包含已被取代/撤回的记录' },
          limit: { type: 'number', description: '默认 20' },
        },
      },
      output: toolOutput(),
      async execute(args) {
        const agent = args && args.__agent
        const snap = snapshot(agent)
        const query = String((args && args.query) || '').trim()
        const words = query.split(/\s+/).map((w) => w.toLowerCase()).filter(Boolean)
        const kind = args && args.kind
        const scope = (args && args.scope) || 'all'
        const topic = args && args.topic
        const includeExpired = !!(args && args.include_expired)
        const limit = Math.min(100, Math.max(1, Number(args && args.limit) || 20))

        let pool = snap.records
        // 默认放行「进行中」与「已完成」：做完的线仍是事实，只有被取代/过期/撤回的才要 include_expired
        if (!includeExpired) pool = pool.filter((r) => ['active', 'closed'].includes(snap.status.get(r.id)))
        if (kind) pool = pool.filter((r) => r.kind === kind)
        if (scope && scope !== 'all') pool = pool.filter((r) => r._scope === scope)
        if (topic) pool = pool.filter((r) => r.topic === topic || topicIdOf(r) === topic)
        if (kind === undefined) pool = pool.filter((r) => r.kind !== INTERNAL_KIND && r.kind !== TOPIC_KIND)

        const registry = topicsOf(snap)

        const scored = []
        for (const r of pool) {
          // 记录 id 与 topic id 也进匹配面：交接/指南索引里给了 id，模型塞进 query 就能直取，
          // 不用记「哪个 id 配哪个参数」。id 形如 as_1a2b3c / tp_1a2b3c，不会污染正常关键词命中。
          const hay = ((r.id || '') + ' ' + (topicIdOf(r) || '') + ' ' + (r.body || '') + ' ' + (r.criteria || '') + ' ' + (r.next || '') + ' ' + (r.topic || '')).toLowerCase()
          let hits = 0
          if (words.length) {
            for (const w of words) if (hay.includes(w)) hits++
            if (hits === 0) continue
          }
          // 精确命中（query 就是这条的 id / 它的 topic id）压过一切：正文里提及该 id 的记录
          // hits 同为 1，却会凭 kind 强度反超，实测 as_53c51e 被提及它的 conclusion 挤到第 3。
          const pin = words.some((w) => w === (r.id || '').toLowerCase() || w === (topicIdOf(r) || '').toLowerCase())
          scored.push({ r, hits, pin })
        }
        scored.sort((x, y) => {
          if (x.pin !== y.pin) return x.pin ? -1 : 1
          if (y.hits !== x.hits) return y.hits - x.hits
          const s = cmpStrength(x.r.kind, x.r.strength, y.r.strength)
          if (s !== 0) return s
          return (Date.parse(y.r.ts) || 0) - (Date.parse(x.r.ts) || 0)
        })
        const hits = scored.slice(0, limit).map(({ r }) => {
          lastSeen.set(r.id, Date.now())
          return {
            id: r.id,
            kind: r.kind,
            scope: r._scope,
            body: r.body,
            criteria: r.criteria,
            next: r.next,
            status: snap.status.get(r.id),
            anchor: r.anchor,
            evidence: (r.source && r.source.quote) || (r.anchor && r.anchor.quote) || '',
            updatedAt: r.ts,
            suspect: r.suspect || [],
            topicId: topicIdOf(r) || undefined,
            topicName: (registry.get(topicIdOf(r)) || {}).name || undefined,
          }
        })
        return { hits, total: scored.length }
      },
    },
    {
      name: 'waystone_status',
      description: 'doctor：这份记忆存在哪、有多少条、锚点是否失效、本轮真实注入了什么。用户问"你记得什么/记歪了没"时用 injected=true 取原文。',
      parameters: {
        type: 'object',
        properties: { injected: { type: 'boolean', description: 'true = 额外返回本轮真实注入原文' } },
      },
      output: toolOutput(),
      async execute(args) {
        const agent = args && args.__agent
        const st = sessionState(agent)
        const snap = snapshot(agent)
        const probe = store.makeProbe()
        const staleAnchors = countStaleAnchors(snap.active, probe)
        const gStats = store.scopeStats(snap.dirs.globalDir)
        const wStats = store.scopeStats(snap.dirs.workspaceDir)
        const out = {
          dataDir: snap.root.dataDir,
          dataDirSource: snap.root.source,
          globalDir: snap.dirs.globalDir,
          workspaceDir: snap.dirs.workspaceDir,
          workspaceKey: snap.dirs.workspaceKey,
          legacyDirs: store.legacyRoots(ctxRef, snap.root.dataDir),
          sizeBytes: gStats.sizeBytes + wStats.sizeBytes,
          lastWriteAt: [gStats.lastWriteAt, wStats.lastWriteAt].filter(Boolean).sort().pop() || null,
          sessions: snap.sessions,
          rules: ruleStatsOf(snap),
          staleAnchors,
          judgeDisabled: st.judgeDisabled,
          lastInjections: st.injections.slice(-5),
          contractBytes: Buffer.byteLength(CONTRACT, 'utf8'),
        }
        // 缺失项一律不出现（工具结果是 lossless JSON，不能带 undefined）
        if (snap.root.error) out.dataDirError = snap.root.error
        if (snap.storeError) out.storeError = snap.storeError
        if (snap.cfg.error) out.configError = snap.cfg.error
        if (args && args.injected) {
          // 本轮真实注入原文：规约段（system prompt）+ 尾部（context），V5 §6.3
          out.rulesText = rulesTextFor(agent)
          out.injectedText = st.injected
        }
        return out
      },
    },
  ]
}

// ───────────────────────────── 只读查看页的数据面 ─────────────────────────────

/**
 * 会话 → 工作区键（会话顶部那个查看页按会话维度打开）。
 * 取不到（宿主没给 agents 服务 / 会话已关）就返回空，由调用方回落到「最近写入的工作区」。
 */
function workspaceKeyOfSession(sessionId) {
  if (!sessionId) return ''
  try {
    const agents = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent) return store.workspaceKey(store.cwdOf(agent))
  } catch {
    /* 会话查不到不阻塞渲染 */
  }
  return ''
}

/**
 * Web 查看页的只读数据（V5 §6.3 doctor 的可视化版本）。
 * 只读：不写盘、不改状态，页面刷新即重算。
 * 工作区优先级：显式 ws > 会话所属工作区 > 最近写入的工作区。
 */
function pagePayload(requestedKey, sessionId) {
  const cfg = store.readConfig(configDefaults())
  const root = store.resolveDataDir(ctxRef, cfg.config, process.cwd())
  const workspaces = store.listWorkspaces(root.dataDir)
  const sessionKey = workspaceKeyOfSession(sessionId)
  const wanted = [requestedKey, sessionKey].find((k) => k && workspaces.some((w) => w.key === k))
  const key = wanted || (workspaces[0] && workspaces[0].key) || ''

  const head = {
    dataDir: root.dataDir,
    dataDirSource: root.source,
    workspaces,
    // 换根后旧库还在原地：这里列出「旧根 + 还有多少条」，并给出当前根已有多少条，
    // 供查看页判断能不能「一键迁移」（只允许新根为空时迁）。
    legacyDirs: store.legacyRoots(ctxRef, root.dataDir),
    rootRecords: store.recordCountUnder(root.dataDir),
  }
  if (cfg.error) head.configError = cfg.error
  if (root.error) head.dataDirError = root.error
  if (!key) return { ...head, empty: true, groups: {}, rulesText: '', tailText: '' }

  const snap = snapshotForKey(key)
  const rules = snap.byKind('rule')
  const gStats = store.scopeStats(snap.dirs.globalDir)
  const wStats = store.scopeStats(snap.dirs.workspaceDir)

  const probe = store.makeProbe()
  const staleAnchors = countStaleAnchors(snap.active, probe)

  const registry = topicsOf(snap)
  const compact = (list) => list.map((r) => ({
    id: r.id,
    scope: r._scope,
    body: r.body,
    criteria: r.criteria || '',
    next: r.next || '',
    strength: r.strength || '',
    status: snap.status.get(r.id),
    ts: r.ts,
    topic: r.topic || '',
    topicId: topicIdOf(r) || '',
    topicName: (registry.get(topicIdOf(r)) || {}).name || String(r.topic || ''),
    suspect: r.suspect || [],
    evidence: (r.source && r.source.quote) || (r.anchor && r.anchor.quote) || '',
  }))

  // 该工作区里最近一次真实注入（内存里各自会话的渲染结果）
  let injectedText = ''
  let lastInjections = []
  let judgeDisabled = false
  for (const st of sessions.values()) {
    if (st.cwd && store.workspaceKey(st.cwd) === key) {
      if (st.injected) injectedText = st.injected
      if (st.injections.length) lastInjections = st.injections.slice(-5)
      judgeDisabled = judgeDisabled || st.judgeDisabled === true
    }
  }

  return {
    ...head,
    workspaceKey: key,
    config: {
      rulesMax: snap.cfg.config.rulesMax,
      injectBudgetTokens: snap.cfg.config.injectBudgetTokens,
      compactConclusionMax: snap.cfg.config.compactConclusionMax,
      compactFactMax: snap.cfg.config.compactFactMax,
      compactBatch: snap.cfg.config.compactBatch,
      dataDir: snap.cfg.config.dataDir || '',
      effectiveDataDir: snap.root.dataDir,
      dataDirSource: snap.root.source,
    },
    rules: ruleStatsOf(snap),
    sizeBytes: gStats.sizeBytes + wStats.sizeBytes,
    lastWriteAt: [gStats.lastWriteAt, wStats.lastWriteAt].filter(Boolean).sort().pop() || null,
    sessions: snap.sessions,
    staleAnchors,
    judgeDisabled,
    contractBytes: Buffer.byteLength(CONTRACT, 'utf8'),
    rulesText: rulesTextOf(snap),
    tailText: renderTail({
      stateBuckets: stateBucketsOf(snap),
      activeDeadends: snap.byKind('deadend'),
      activeGuides: snap.byKind('guide'),
      recentUserText: '',
      budgetTokens: tailBudgetOf(snap.cfg.config.injectBudgetTokens),
    }),
    groups: {
      rule: compact(rules),
      state: compact(snap.byKind('state')),
      // 工作线分区要的是「全量 + 四态」：active/closed 是现在，superseded/expired 才是历史
      stateAll: compact(snap.records.filter((r) => r.kind === 'state')),
      conclusion: compact(snap.byKind('conclusion')),
      guide: compact(snap.byKind('guide')),
      deadend: compact(snap.byKind('deadend')),
      fact: compact(snap.byKind('fact')),
    },
    // 注册表快照：页面/外部据此把 topic_id 翻成名字（名字随 id 锁定）
    topics: [...registry.values()].map((t) => ({ id: t.id, name: t.name })),
    injectedText,
    lastInjections,
  }
}

// ───────────────────────────── 装配 ─────────────────────────────

export function apply(ctx, config = {}) {
  // 运行态是模块级单实例（ctxRef/sessions/judgeRunning/…）：同进程挂第二行 waystone 会互踩。
  // 不做 isolate（宿主正常只 apply 一次），但留一条可查痕迹，别让它静默。
  if (ctxRef) noteTrace('apply:second-instance', 'waystone 已在同进程 apply 过；运行态是单实例')
  ctxRef = ctx
  unloaded = false
  judgeAbort = new AbortController()
  rowConfigRef = config && typeof config === 'object' ? config : {}

  // LEV-2：`baseDir` 是 Cordis reflect 属性，只有在 inject 里声明后才能读。
  // 这里解析一次交给 store；拿不到就不调用（store 回落 ~/.dsh），绝不抛给注入面。
  // 数据根因此变成 <baseDir>/waystone/data；旧根由 doctor 的 legacyDirs 列出，
  // 用 scripts/migrate-data-root.mjs 搬。
  try {
    ctx.inject(['baseDir'], (sctx) => {
      try {
        if (typeof sctx.baseDir === 'string' && sctx.baseDir) store.setHostBaseDir(sctx.baseDir)
      } catch {
        /* 读不到就保持回落 */
      }
    })
  } catch {
    /* 该宿主版本没有可注入的 baseDir：保持回落，不影响其余表面 */
  }

  // 设置页改了 volatile 字段：宿主已把新值写回 rowConfigRef；这里只在拿得到 entry
  // 时再对一次账（防止某些版本替换了 config 对象而不是原地改）。
  ctx.on('loader/volatile-update', () => {
    try {
      const entry = ctxRef && ctxRef.fiber && ctxRef.fiber.entry
      if (entry && entry.config && typeof entry.config === 'object') rowConfigRef = entry.config
    } catch {
      /* 拿不到 entry 就继续用当前活引用 */
    }
  })

  const disposers = []
  disposers.push(ctx.systemPrompt.section({
    name: 'waystone:contract',
    order: SECTION_ORDER,
    text: () => CONTRACT,
  }))
  disposers.push(ctx.systemPrompt.section({
    name: 'waystone:rules',
    order: RULES_ORDER,
    text: (context) => rulesTextFor(context && context.agent),
  }))
  // required: true —— 交接段不被宿主的 suppressRuntimeContext() 抑制。取舍已定：这份是会话
  // 状态，被 persona 的 includeRuntimeContext:false 静默吞掉比多注入几十 token 更糟。
  // 「没内容不注入」不受影响：宿主先 filter(text.length > 0)，空串永远不进 context。
  disposers.push(ctx.systemPrompt.context({
    name: 'waystone:tail',
    order: TAIL_ORDER,
    required: true,
    text: (context) => tailTextFor(context && context.agent),
  }))

  for (const tool of buildTools()) {
    const execute = tool.execute
    tool.execute = (args, exec) => {
      // 工具定义是全局注册的：这里把调用方 agent 传进业务函数，绝不留悬空会话态。
      // 任何异常都折成 {error:{code,message}} 返回 —— 工具面不抛异常给模型（V5 §6）。
      const agent = (exec && exec.agent) || undefined
      return Promise.resolve()
        .then(() => execute({ ...(args || {}), __agent: agent }))
        .then((value) => jsonSafe(value))
        .catch((e) => jsonSafe({ error: { code: (e && e.code) || 'E_STORE', message: String((e && e.message) || e) } }))
    }
    disposers.push(ctx.tools.register(tool))
  }

  // 只读查看页的数据路由：/api/waystone/state（同源，浏览器 cookie 自动带上）
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      path: '/api/waystone/state',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url || '/', 'http://127.0.0.1')
          const payload = pagePayload(url.searchParams.get('ws') || '', url.searchParams.get('session') || '')
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(payload))
        } catch (e) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: String((e && e.message) || e) }))
        }
      },
    }), 'waystone: state route')
  })

  // 查看页唯一的写操作：把旧数据根「显式」搬过来。
  // 三个硬前提缺一不可 —— POST、源必须是本插件列出的旧根、当前根必须为空库。
  // 刻意不做自动迁移：静默搬盘比空库更危险（搬错等于把记忆库悄悄挪走）。
  // 不删源：要不要删交给 scripts/migrate-data-root.mjs --prune，由人决定。
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      path: '/api/waystone/migrate',
      handler: async (request, response) => {
        const send = (code, body) => {
          response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(body))
        }
        try {
          if (String(request.method || 'GET').toUpperCase() !== 'POST') return send(405, { ok: false, error: '只接受 POST' })
          const url = new URL(request.url || '/', 'http://127.0.0.1')
          const from = url.searchParams.get('from') || ''
          const cfg = store.readConfig(configDefaults())
          const root = store.resolveDataDir(ctxRef, cfg.config, process.cwd())
          const hit = store.legacyRoots(ctxRef, root.dataDir).find((l) => path.resolve(l.path) === path.resolve(from))
          if (!hit) return send(400, { ok: false, error: 'from 不是本插件列出的旧数据根：' + from })
          const current = store.recordCountUnder(root.dataDir)
          if (current > 0) {
            return send(409, {
              ok: false,
              error: '当前根已有 ' + current + ' 条记录，拒绝合并；要合并请跑 scripts/migrate-data-root.mjs --merge',
            })
          }
          const summary = migrate({ from: hit.path, to: root.dataDir })
          noteTrace('migrate:done', JSON.stringify({ from: summary.src, to: summary.dst, files: summary.files, lines: summary.lines }))
          return send(200, { ok: true, from: summary.src, to: summary.dst, files: summary.files, lines: summary.lines })
        } catch (e) {
          noteError('migrate', e)
          return send(500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'waystone: migrate route')
  })

  // 观察层：只读、有界、不落盘（V5 §3.3）
  // ★ 用户原话有三个入口，缺一个就会让 E_QUOTE 误拒真原话（实测：只靠 inbox/claimed 时
  //   goal 续跑轮的原话收不到）：① session/event 的 user/message（durable 日志，最可靠）
  //   ② agent/inbox/claimed ③ agent/pre-step 的 messages。
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event || event.type !== 'user/message') return
      const data = event.data || {}
      const message = data.message || data
      if (isInjectedMessage(message)) return
      const st = sessionState({ session })
      rememberUserText(st, textOfMessage(message))
    } catch {
      /* 观察失败不影响会话 */
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload && payload.agent
      if (agent) {
        const st = sessionState(agent)
        if (Number.isInteger(payload.turn)) {
          st.lastTurn = payload.turn
        }
        // runtime-context 快照也走这个入口；不过滤就会把上一轮的 [指南索引]/[交接] 当成"用户原话"，
        // 索引行自带每条 guide 的 body 前缀 ⇒ 下一轮必然自我命中（实测：真消息命中 0 条，夹带索引行命中 3/3）。
        for (const m of payload.messages || []) {
          if (isInjectedMessage(m)) continue
          rememberUserText(st, textOfMessage(m))
        }
      }
    } catch {
      /* 观察失败不影响会话 */
    }
    return next()
  })

  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const st = sessionState(agent)
      if (Number.isInteger(payload.turn)) {
        st.lastTurn = payload.turn
      }
      rememberUserText(st, textOfMessage(payload.message))
    } catch {
      /* 观察失败不影响会话 */
    }
  })

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const st = sessionState(agent)
      const text = textOfStreamFrame(payload.frame)
      if (text) {
        st.assistantText += text
        if (st.assistantText.length > 6000) st.assistantText = st.assistantText.slice(-6000)
      }
    } catch {
      /* ignore */
    }
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec && exec.agent
      if (!agent) return
      const st = sessionState(agent)
      const toolName = String((exec && exec.name) || '')
      if (/^(write|edit|multi_edit|apply_patch|notebook_edit|ops_write|ops_edit)$/.test(toolName)) st.filesTouched.add(toolName)
      if (result && result.isError) st.sawError = true
      else if (result && result.value && typeof result.value === 'object' && Number.isInteger(result.value.exitCode) && result.value.exitCode !== 0) {
        st.sawError = true
      }
    } catch {
      /* ignore */
    }
  })

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const st = sessionState(agent)
      const turn = Number.isInteger(payload.turn) ? payload.turn : st.lastTurn
      // 判官不在回合关键路径：fire-and-forget，且自带 catch（未捕获拒绝会让宿主整树 dispose）
      noteTrace('turn-stopping', 'turn=' + turn)
      Promise.resolve()
        .then(() => runJudge(agent, turn))
        .catch((e) => noteError('judge:swallow', e))
        // 判官之后再看一次要不要整理（同一条 fire-and-forget 链，同样不阻塞回合）
        .then(() => maybeCompact(agent, turn))
        .catch((e) => noteError('compact:swallow', e))
        // 整理之后再汇总项目档案（fact 变化才真的调用模型）
        .then(() => maybeProfile(agent, turn))
        .catch((e) => noteError('profile:swallow', e))
    } catch {
      /* ignore */
    }
  })

  ctx.on('session/disposed', (payload) => {
    try {
      // 宿主按首参传 Session；`{ session }` 形态也兼容。删错了代价比漏删大：
      // 漏删 = 每会话运行态永久驻留（LEV-1 回不到基线）。
      const session = (payload && payload.session) || payload
      if (!session || typeof session !== 'object') return
      const sid = String(session.id || (session.header && session.header.id) || '')
      if (sid) sessions.delete(sid)
    } catch {
      /* ignore */
    }
  })

  ctx.effect(() => () => {
    unloaded = true
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {
        /* 卸载时单个 disposer 失败不阻断其余 */
      }
    }
    // 取消在飞判官：不取消的话卸载后它还会写盘（LEV-1/7）
    try {
      if (judgeAbort) judgeAbort.abort()
    } catch {
      /* ignore */
    }
    judgeAbort = null
    judgeRunning = 0
    // 单飞标志与缓存文本回到基线：卸载时正在整理/渲染那一次，否则本进程会永久停在
    //「已在整理」状态（重新启用后 compact/profile 再也不跑）
    compactRunning = false
    profileRunning = false
    lastGoodRulesText = ''
    rowConfigRef = {}
    ctxRef = null
    store.setHostBaseDir(null)
    sessions.clear()
    lastSeen.clear()
  }, 'waystone: surfaces')
}

/** 可视化面：设置页配置表单（Config）+ 只读查看页（lib/client.js）。 */
