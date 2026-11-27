/**
 * 断言记录的确定性校验层（V5 §2.2 / §2.3 / §2.4 / §4.1 / §4.3）。
 *
 * 铁律：本文件**零 IO、零 LLM、纯同步**。需要磁盘/会话事实的地方一律由调用方注入
 * （`ctx.probe` 读文件行指纹，`ctx.userMessages` 会话用户原话），这样单测能直接喂构造样本。
 *
 * 错误码（硬拒）：E_SCHEMA / E_BODY / E_ANCHOR_MISSING / E_ANCHOR_BAD / E_QUOTE / E_NEXT / E_SCOPE / E_TOPIC / E_TOPIC_UNKNOWN
 * 配额（不拒）：E_QUOTA_EVICT —— 由 quotaVictim() 给出淘汰对象，写入方写 expire 记录。
 */
import { createHash } from 'node:crypto'

export const KINDS = ['state', 'rule', 'conclusion', 'guide', 'fact', 'deadend']
/** 内部专用：过期记录（§2.2 四态 / §4.3 淘汰），不接受模型直接写。 */
export const INTERNAL_KIND = 'expire'
/** 内部专用：topic 注册记录（id → 名称），由写入路径按 new_topic 铸造，不接受模型直接写。 */
export const TOPIC_KIND = 'topic'
/** topic_id 的形状：tp_ + 6 位 hex。 */
export const TOPIC_ID_RE = /^tp_[0-9a-f]{6}$/

/**
 * 一条 state 属于哪个 topic：优先 topic_id；老记录（只有 topic 名字）按名字派生一个稳定 id，
 * 同名老记录自动并成同一条线（读时派生，不落盘、不迁移）。
 */
export function topicIdOf(rec) {
  if (rec && rec.topic_id) return rec.topic_id
  const name = String((rec && rec.topic) || '').trim()
  if (!name) return ''
  return 'tp_' + createHash('sha1').update(name).digest('hex').slice(0, 6)
}

export const SCOPES = ['workspace', 'global']
export const STRENGTHS = ['user_said', 'measured', 'inferred']
export const ANCHOR_TYPES = ['file', 'turn', 'url']

/** 按 kind 的必需项（V5 §2.3 表，逐格照抄）。anchor 用数组表示"任一即可"。 */
const KIND_RULES = {
  state: { anchor: ['turn'], criteria: false, quote: false, next: true },
  rule: { anchor: ['turn'], criteria: true, quote: true, next: false },
  conclusion: { anchor: ['turn', 'file', 'url'], criteria: false, quote: true, next: false },
  guide: { anchor: ['file', 'turn'], criteria: true, quote: true, next: false },
  fact: { anchor: ['turn', 'file', 'url'], criteria: false, quote: false, next: false },
  deadend: { anchor: ['file', 'turn'], criteria: false, quote: true, next: false },
}

/** 强度序（高→低），V5 §2.4：规约看用户原话，事实看实测。 */
const STRENGTH_ORDER = {
  'rule': ['user_said', 'measured', 'inferred'],
  'guide': ['user_said', 'measured', 'inferred'],
  'deadend': ['user_said', 'measured', 'inferred'],
  'conclusion': ['measured', 'user_said', 'inferred'],
  'fact': ['measured', 'user_said', 'inferred'],
  'state': ['measured', 'user_said', 'inferred'],
  'expire': ['measured', 'user_said', 'inferred'],
}

/** 单条记忆正文上限。判官实测经常写到 320–415 字，300 会把整条更新拒掉；500 覆盖实测最大值并留余量。 */
export const BODY_MAX_CHARS = 500

const isStr = (v) => typeof v === 'string' && v.length > 0
const fail = (code, message) => ({ ok: false, code, message })

/** cmpStrength(kind, a, b)：a 比 b 强返回 >0，弱返回 <0。 */
export function cmpStrength(kind, a, b) {
  const order = STRENGTH_ORDER[kind] || STRENGTH_ORDER.state
  return order.indexOf(b) - order.indexOf(a)
}

export function strengthRank(kind, strength) {
  const order = STRENGTH_ORDER[kind] || STRENGTH_ORDER.state
  const i = order.indexOf(strength)
  return i < 0 ? order.length : order.length - i
}

/**
 * 校验一条模型/判官提交的记录。
 * @param {object} rec 待校验记录（可已带 v/ts/sid/turn）
 * @param {object} ctx  { userMessages?: string[], maxBody?: number, allowNewlines?: boolean, probe?: { lineSha256(p,line):string|undefined } }
 * @returns {{ok:true}|{ok:false,code:string,message:string}}
 */
export function validateRecord(rec, ctx = {}) {
  // ---- E_SCHEMA ----
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return fail('E_SCHEMA', '记录必须是对象')
  if (!isStr(rec.id) || !/^as_[0-9a-f]{6,}$/.test(rec.id)) return fail('E_SCHEMA', 'id 必须是 as_<hex>')
  if (!isStr(rec.ts) || Number.isNaN(Date.parse(rec.ts))) return fail('E_SCHEMA', 'ts 必须是 ISO 时间')
  if (!isStr(rec.sid)) return fail('E_SCHEMA', 'sid 缺省')
  if (!Number.isInteger(rec.turn) || rec.turn < 0) return fail('E_SCHEMA', 'turn 必须是整数')
  if (!isStr(rec.kind) || !KINDS.includes(rec.kind)) {
    return fail('E_SCHEMA', 'kind 未知：' + String(rec.kind))
  }
  if (!isStr(rec.body)) return fail('E_SCHEMA', 'body 必填')
  if (!rec.anchor || typeof rec.anchor !== 'object') return fail('E_SCHEMA', 'anchor 必填')
  if (!ANCHOR_TYPES.includes(rec.anchor.type)) return fail('E_SCHEMA', 'anchor.type 未知')
  if (rec.strength !== undefined && !STRENGTHS.includes(rec.strength)) {
    return fail('E_SCHEMA', 'strength 非法')
  }
  if (rec.scope !== undefined && !SCOPES.includes(rec.scope)) {
    return fail('E_SCHEMA', 'scope 非法')
  }
  if (rec.suspect !== undefined && !Array.isArray(rec.suspect)) return fail('E_SCHEMA', 'suspect 必须是数组')

  const rules = KIND_RULES[rec.kind]

  // ---- E_BODY ----
  // 默认为 500 字单行；档案（profile）走自己的通道，可传更大的 maxBody 与 allowNewlines。
  const maxBody = Number.isInteger(ctx.maxBody) ? ctx.maxBody : BODY_MAX_CHARS
  if (rec.body.length > maxBody) return fail('E_BODY', 'body 超过 ' + maxBody + ' 字')
  if (!ctx.allowNewlines && /[\r\n]/.test(rec.body)) return fail('E_BODY', 'body 必须是单行')

  // ---- E_SCOPE（§2.1：只有 rule 允许进 global）----
  const scope = rec.scope || 'workspace'
  if (scope === 'global' && rec.kind !== 'rule') {
    return fail('E_SCOPE', '只有 rule 能进 global；工作区记录不能进全局库')
  }

  // ---- E_TOPIC ----
  // state 只认 topic_id（写入路径会把 new_topic 铸造成 topic_id 再送来）；格式不对就是没给。
  if (rec.kind === 'state') {
    if (!TOPIC_ID_RE.test(String(rec.topic_id || ''))) {
      return fail('E_TOPIC', 'state 必须写 topic_id（tp_xxxxxx，从 [交接] 或召回结果里抄）或 new_topic（确实是新线才给名字）')
    }
  }

  // ---- E_NEXT ----
  // state 的 next 必填但允许空串：空串 = 本线已闭环，不进交接，只在工作线分区里可查。
  if (rules.next && typeof rec.next !== 'string') return fail('E_NEXT', 'state 必须写 next（本线闭环就写空串）')
  if (!rules.next && rec.next !== undefined && rec.next !== '') {
    return fail('E_NEXT', '只有 state 能写 next')
  }

  // ---- criteria / quote 必需性（同样缺字段时归 E_SCHEMA）----
  if (rules.criteria && !isStr(rec.criteria)) return fail('E_SCHEMA', rec.kind + ' 必须写 criteria')
  const quote = rec.source && typeof rec.source === 'object' ? rec.source.quote : undefined
  if (rules.quote && !isStr(quote)) return fail('E_SCHEMA', rec.kind + ' 必须写 source.quote')

  // ---- E_ANCHOR_MISSING ----
  if (!rules.anchor.includes(rec.anchor.type)) {
    return fail('E_ANCHOR_MISSING', rec.kind + ' 的锚点必须是 ' + rules.anchor.join(' 或 '))
  }
  const a = rec.anchor
  if (a.type === 'file') {
    if (!isStr(a.path) || !Number.isInteger(a.line) || a.line < 1) {
      return fail('E_ANCHOR_MISSING', 'file 锚点需要 path + line')
    }
    if (!isStr(a.quote) || !isStr(a.sha256)) {
      return fail('E_ANCHOR_MISSING', 'file 锚点需要 quote + sha256')
    }
  } else if (a.type === 'turn') {
    if (!isStr(a.sid) || !Number.isInteger(a.turn) || !isStr(a.quote)) {
      return fail('E_ANCHOR_MISSING', 'turn 锚点需要 sid + turn + quote')
    }
  } else if (a.type === 'url') {
    if (!isStr(a.url) || !isStr(a.fetched_at) || !isStr(a.sha256)) {
      return fail('E_ANCHOR_MISSING', 'url 锚点需要 url + fetched_at + sha256')
    }
  }

  // ---- E_ANCHOR_BAD（file 型要真能指回原文；url 型只验本地指纹）----
  if (a.type === 'file' && ctx.probe) {
    let sha
    try {
      sha = ctx.probe.lineSha256(a.path, a.line)
    } catch {
      sha = undefined
    }
    if (!sha) return fail('E_ANCHOR_BAD', '文件或行号不存在：' + a.path + ':' + a.line)
    if (sha !== a.sha256) return fail('E_ANCHOR_BAD', '该行内容指纹不匹配（原文已变）')
  }

  // ---- E_QUOTE（只对 rule/guide：规约看用户原话；conclusion/deadend 的 quote 是据以推断的依据原文）----
  if ((rec.kind === 'rule' || rec.kind === 'guide') && Array.isArray(ctx.userMessages)) {
    const hay = ctx.userMessages.join('\n')
    if (!hay.includes(quote)) return fail('E_QUOTE', 'quote 不在本会话用户消息中')
  }

  return { ok: true }
}

/** 按 (ts, sid, id) 稳定排序，供四态计算与渲染复用。 */
function sortRecords(records) {
  return [...records].sort((x, y) => {
    const tx = Date.parse(x.ts) || 0
    const ty = Date.parse(y.ts) || 0
    if (tx !== ty) return tx - ty
    const sx = String(x.sid || '')
    const sy = String(y.sid || '')
    if (sx !== sy) return sx < sy ? -1 : 1
    return String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0
  })
}

/**
 * 四态计算（不落盘，V5 §2.2）：active（进行中）/ closed（已完成）/ superseded（已取代）/ expired（已过期）。
 *
 * 前三种由记录间关系决定；`closed` 是 state 专有：同 topic 最新一条 active state 的 `next` 为空串
 * = 这条线做完了。闭环不是过期（记录仍算数、仍可召回），也不是取代（旧步骤才是已取代）。
 * @returns {Map<string,'active'|'closed'|'superseded'|'expired'>}
 */
export function computeStatus(records) {
  const sorted = sortRecords(records)
  const status = new Map()
  for (const r of sorted) status.set(r.id, 'active')
  for (const r of sorted) {
    if (r.supersedes && status.has(r.supersedes)) status.set(r.supersedes, 'superseded')
    // retracts 收单 id 或 id 数组：一次撤回多条，避免"撤一条写一条"的噪音记录
    for (const t of [].concat(r.retracts || [])) if (status.has(t)) status.set(t, 'expired')
    if (r.kind === INTERNAL_KIND && r.target && status.has(r.target)) status.set(r.target, 'expired')
  }
  // 第二遍：同一 topic 内只有最新那条 state 能保持 active/closed，更早的旧的统一论为 superseded。
  // （写入时序可能漏链：例如旧记录当时算 closed、新记录写进来没把它记成 supersedes）
  const latestOfTopic = new Map()
  for (const r of sorted) {
    if (r.kind !== 'state') continue
    const key = topicIdOf(r)
    if (!key || status.get(r.id) === 'expired') continue
    latestOfTopic.set(key, r) // sorted 升序：后写覆盖前面的 = 最新
  }
  for (const [key, keep] of latestOfTopic) {
    for (const r of sorted) {
      if (r.kind !== 'state' || r.id === keep.id || topicIdOf(r) !== key) continue
      if (status.get(r.id) === 'active') status.set(r.id, 'superseded')
    }
  }
  // 第三遍：该 topic 最新一条 next 为空串 → 这条线已完成（closed）
  for (const r of latestOfTopic.values()) {
    if (status.get(r.id) === 'active' && !r.next) status.set(r.id, 'closed')
  }
  return status
}

/**
 * 从模型输出里取出第一个完整 JSON 对象（判官/整理官/档案三处共用）。
 * 剥 ``` 围栏、取首尾花括号、断言是对象；`label` 只用于报错文案。
 */
export function parseJsonObject(text, label) {
  const s = String(text || '').replace(/^```(?:json)?/gm, '').replace(/```$/gm, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(label + '输出不是 JSON')
  const obj = JSON.parse(s.slice(start, end + 1))
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(label + '输出不是对象')
  return obj
}

/**
 * 配额淘汰（V5 §4.3）：规则条数 > rulesMax 时给出「最久未命中 + 最低强度」的那条 id。
 * 新条目恒可进 —— 返回被淘汰者，由写入方追加一条 expire 记录。
 * @param {object[]} activeRules 当前 active 的 rule（同作用域）
 * @param {number} rulesMax
 * @param {(id:string)=>number} lastSeenAt 注入渲染时的命中时间（缺省 0）
 */
export function quotaVictim(activeRules, rulesMax, lastSeenAt = () => 0) {
  if (activeRules.length <= rulesMax) return null
  const ranked = [...activeRules].sort((x, y) => {
    const lx = lastSeenAt(x.id) || 0
    const ly = lastSeenAt(y.id) || 0
    if (lx !== ly) return lx - ly
    const sx = strengthRank(x.kind, x.strength)
    const sy = strengthRank(y.kind, y.strength)
    if (sx !== sy) return sx - sy
    const tx = Date.parse(x.ts) || 0
    const ty = Date.parse(y.ts) || 0
    return tx - ty
  })
  return ranked[0] ? ranked[0].id : null
}

/**
 * 事实入库闸（2026-11-06）。本插件里「事实」只有一个口径：**长期不变、与代码实现无关的断言**。
 * 下面两类内容不许当 fact —— 拒收不等于丢弃，返回建议 kind 让写入方改写成 conclusion/state：
 *
 *   L1 变更叙事：「由 X 改为 Y / 已落地 / 已废 / 尚未 / 本轮」——那是 state（做到哪）或 conclusion（决策）。
 *   L2 代码坐标与构建产物：文件:行号、版本号、包大小、文件数、测试计数、默认值/阈值/并发数/超时值。
 *      这些东西能在源码里 grep 到，改一次代码就错一次，属于 conclusion（机制与参数）。
 *
 * 刻意**不做** L3（文件锚点 + sha 复验）与时间保鲜：事实不必映射到某个文件（源码已由 git 管控），
 * 也不按时间过期 —— 用户 2026-11-06 明确否决。闸门只在入库这一道。
 *
 * 判据保守：宁可把一条判断降级成 conclusion（recall 仍可取回），也不让易腐内容进 [项目档案]。
 */
const FACT_GATE_RULES = [
  {
    code: 'L1', suggest: 'state',
    reason: '写的是「变更叙事」（由谁改成谁/已落地/已废/尚未/本轮），不是长期不变的断言',
    re: /改为|改成|已落地|已实现|已实施|已废弃|已废|已删|已完成|尚未|未落进|没落进|刚改|本轮|上一轮/,
  },
  {
    code: 'L2', suggest: 'conclusion',
    reason: '含代码坐标或构建产物（文件:行号/版本号/包大小/文件数/测试计数/默认值/阈值/并发数/超时）',
    re: new RegExp([
      /[\w./\\-]+\.(?:js|mjs|cjs|ts|mts|json|ya?ml|md|toml):\d+/.source,          // 文件:行号
      /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?![\d.])/.source,                   // 版本号（放过 IPv4）
      /\bv\d+(?:\.\d+)+/.source,                                                    // v1.2
      /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/.source,                                    // 包大小
      /\b\d+\s*(?:files?|个文件|行代码|行)\b/.source,                                 // 文件数/行数
      // 测试计数（须有「测试/用例」上下文）：裸 N/M 会把 DSC-04..09/14 这类规范编号误判成计数
      /(?:测试|用例|tests?)[^\n。；]{0,12}\d+\s*\/\s*\d+/.source,
      /默认(?:值)?\s*(?:为|是)?\s*\d/.source,                                        // 默认 60
      /(?:上限|阈值|并发数?|超时|批量)\s*(?:为|是)?\s*\d/.source,                       // 并发上限 6
    ].join('|'), 'i'),
  },
]

/**
 * 判断一条正文能不能记为 fact。
 * @returns {{ok:true} | {ok:false, code:string, suggest:'conclusion'|'state', reason:string, message:string}}
 */
export function factGate(body) {
  const text = String(body || '')
  for (const rule of FACT_GATE_RULES) {
    if (!rule.re.test(text)) continue
    return {
      ok: false,
      code: rule.code,
      suggest: rule.suggest,
      reason: rule.reason,
      message: '不能记为 fact（' + rule.code + '）：' + rule.reason + '；改写成 ' + rule.suggest
        + ' 再写——fact 只收长期不变、与代码实现无关的断言',
    }
  }
  return { ok: true }
}


// ───────────────────── 写入闸门（2026-11-26 定稿，三轮团队评审） ─────────────────────

/**
 * 显式作用域词：只有用户**明说**跨项目范围，才允许 rule 升进全局库。
 *
 * 刻意不含「以后都 / 永远 / 一律」——那些词说的是"长期"，不是"范围"，实测是把本工作区
 * 规则误升成全局规则的主因（两条 rule 误进 global 库那次，原话只有「整段都删掉吧」）。
 * 方向也刻意单向：判不准一律留在 workspace（fail-safe），升格永远需要正向证据。
 */
export const SCOPE_MARKERS = [
  '所有项目', '每个项目', '各个项目', '所有仓库', '全部项目', '全部仓库',
  '每台机器', '所有机器', '所有会话', '全局规则', '全局生效',
  'all projects', 'every project', 'every repo', 'across projects', 'globally', 'all machines', 'all sessions',
]

/** 非连续写法（「所有 … 项目」中间可以夹定语）。 */
const SCOPE_PATTERNS = [
  /所有[^，。；！？,.;!?\n]{0,8}(项目|仓库)/,
  /每(个|一)?[^，。；！？,.;!?\n]{0,4}(项目|仓库|机器)/,
  /全部(的)?[^，。；！？,.;!?\n]{0,4}(项目|仓库)/,
  /(all|every)\s+[a-z]*\s*(projects?|repos?|repositories|machines?|sessions?)/i,
  /across\s+(all\s+)?(my\s+)?(projects?|repos?)/i,
  /\bglobally\b/i,
]

const LOCAL_LIMIT_RE = /只(这|此|本)|仅(这|此|本)|这一个|这一台|本(仓库|项目|机|工作区)|这个(项目|仓库)|这台机器/
const NEG_RE = /不要|别|勿|禁止|不用|无需|不准|不必|不是|并非|不适用/
const NEG_EXEMPT_RE = /都|一律|均|全部/
const META_NEG_RE = /(不要|别|勿|禁止|不准|不必|无需)(把|将)?[^，。；！？,.;!?\n]{0,4}(加|写|记|录|存|放|塞|升格|升级|动|删|改|碰|管)/
const PAST_RE = /以前|之前|过去|曾经|原先|原来/
const NARROW_RE = /但|不过|现在|这次/
const QUESTION_RE = /是不是|要不要|会不会|为什么|如何/
const CLAUSE_SPLIT_RE = /[。！？；，、：,.;:!?\n]/

/** 给工具描述 / 判官提示词 / 契约文本共用的一句话（三处不同源就是"教一套罚一套"）。 */
export const SCOPE_RULE_TEXT = 'global 只有 rule 能进，且仅当用户明说跨项目范围（如「所有项目/每个仓库/每台机器/全局规则」，英文 all projects / every repo / across projects）；「以后都/永远/一律/禁止」这类长期词不构成跨项目证据。升格还要求 source.quote 是本轮用户原话里句读边界起止的完整分句。没有明说一律留空（workspace）：系统会静默降级并标 scope_downgraded，不会拒写'

/** 按句读切片段（对齐检查与「marker 所在分句」都靠它）。 */
function clauses(text) {
  return String(text || '').split(CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
}

/** quote 是否落在句读边界上：等于某条的整句，或等于其中某个完整分句。 */
export function alignedQuote(quote, messages = []) {
  const q = String(quote || '').trim()
  if (!q) return false
  for (const m of messages) {
    if (String(m || '').trim() === q) return true
    if (clauses(m).includes(q)) return true
  }
  return false
}

/** 显式作用域证据：返回命中的 marker（没命中返回空串）。 */
export function scopeMarkerOf(text) {
  const s = String(text || '')
  for (const m of SCOPE_MARKERS) if (s.includes(m)) return m
  for (const re of SCOPE_PATTERNS) {
    const hit = s.match(re)
    if (hit) return hit[0]
  }
  return ''
}

/**
 * 升 global 的确定性裁决（不拒写：只把 scope 降回 workspace）。
 *
 * 四道证据全过才升：本轮窗口 → 分句对齐 → 显式作用域词 → 无削弱语境。
 * @param {{kind?:string, scope?:string, anchor?:object, source?:object}} rec
 * @param {{messages?:string[], turns?:number[], lastTurn?:number}} ctx
 * @returns {{scope:string, downgraded:boolean, reason:string}}
 */
export function judgeScope(rec, ctx = {}) {
  const wanted = (rec && rec.scope) || 'workspace'
  if (!rec || rec.kind !== 'rule' || wanted !== 'global') return { scope: wanted, downgraded: false, reason: '' }
  const down = (reason) => ({ scope: 'workspace', downgraded: true, reason })
  const quote = rec.source && typeof rec.source.quote === 'string' ? rec.source.quote.trim() : ''
  if (!quote) return down('scope：global 规则必须带 source.quote')

  const messages = Array.isArray(ctx.messages) ? ctx.messages : []
  const turns = Array.isArray(ctx.turns) ? ctx.turns : null
  const lastTurn = Number.isInteger(ctx.lastTurn) ? ctx.lastTurn : null
  if (turns && lastTurn !== null) {
    // 只有本轮原话算证据：历史上说过的「所有项目」不能拿到今天复用（模型自选 turn 也不算）
    const aTurn = rec.anchor && Number.isInteger(rec.anchor.turn) ? rec.anchor.turn : lastTurn
    if (aTurn !== lastTurn) return down('scope：引文不是本轮用户原话（anchor.turn 落后于当前轮）')
    const win = messages.filter((_, i) => turns[i] === lastTurn)
    if (!win.length) return down('scope：本轮没有用户原话')
    if (!alignedQuote(quote, win)) return down('scope：引文必须是本轮原话里句读边界起止的完整分句')
  } else if (messages.length && !alignedQuote(quote, messages)) {
    return down('scope：引文必须是用户原话里句读边界起止的完整分句')
  }

  const marker = scopeMarkerOf(quote)
  if (!marker) return down('scope：原话没有明说跨项目范围（「以后都/永远」不算）')
  if (LOCAL_LIMIT_RE.test(quote)) return down('scope：原话带局部限定（只这个仓库/本机/这一台）')
  if (META_NEG_RE.test(quote)) return down('scope：原话说的是「别把这条升成全局」')
  const head = quote.slice(0, quote.indexOf(marker))
  const seg = clauses(head).pop() || ''
  if (PAST_RE.test(seg)) return down('scope：原话是历史叙述（以前/过去…）')
  if (NARROW_RE.test(seg)) return down('scope：原话在收窄范围（但/现在/这次…）')
  if (QUESTION_RE.test(quote)) return down('scope：原话是疑问句')
  const neg = quote.match(NEG_RE)
  if (neg) {
    // 「所有项目都别用 pnpm」里的「都」把否定变成断言，不能当"否定升格"
    const before = quote.slice(0, neg.index || 0)
    if (!NEG_EXEMPT_RE.test(before)) return down('scope：原话否定了这条要求')
  }
  return { scope: 'global', downgraded: false, reason: '' }
}

/** ASCII 记号序列（保序）：路径、文件名、版本号、命令、§n 都在里面。 */
export function entSeq(text) {
  const hits = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_.\-\/#§%:+]*/g) || []
  return hits.filter((t) => t.length > 1)
}

/**
 * 同引文更新：同一句用户原话下的同 kind 同 scope 记录，新条取代旧条。
 *
 * 判据全是精确等（零相似度、零阈值）：一条规则的证据是「哪句原话 + 哪些实体」，
 * 两者都对上就是同一件事的新写法。实测本案两条（同 sid 同 turn 同 quote，
 * 只差措辞、相隔 6 秒）正是这个形态。
 */
export function pickQuoteTwin(rec, active = []) {
  if (!rec || (rec.kind !== 'rule' && rec.kind !== 'guide')) return null
  if (rec.supersedes) return null
  const quote = rec.source && typeof rec.source.quote === 'string' ? rec.source.quote : ''
  if (!quote) return null
  const seq = entSeq(rec.body)
  if (!seq.length) return null
  const want = JSON.stringify(seq)
  const hits = active.filter((r) => r && r.id !== rec.id
    && r.kind === rec.kind
    && r._scope === rec.scope
    && r.source && r.source.quote === quote
    && JSON.stringify(entSeq(r.body)) === want)
  if (!hits.length) return null
  hits.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0) || (String(a.id) < String(b.id) ? 1 : -1))
  return hits[0]
}

/** 同轴候选的确定性选择（原来取 twins[0]，那是分片 readdir 顺序）。 */
export function pickTwin(twins, kind) {
  const list = [...(twins || [])]
  if (!list.length) return null
  if (kind === 'state') {
    // 状态是快照：桶内永远取最新那条，不按强度
    list.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0) || (String(a.id) < String(b.id) ? 1 : -1))
  } else {
    list.sort((a, b) => (-cmpStrength(kind, a.strength, b.strength))
      || ((Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
      || (String(a.id) < String(b.id) ? 1 : -1))
  }
  return list[0]
}

/**
 * 显式边（supersedes / retracts）的越权校验。
 *
 * 读面 computeStatus 只看 id 存在、不看 scope/kind，所以写面必须自己收口：
 * 一条工作区结论带 supersedes=<全局规则 id> 就能把全局规约静默移出注入面（实测可复现）。
 * 返回空串表示放行，否则返回原因。
 */
export function edgeAllowed({ recKind, recScope, edge, reason, target } = {}) {
  if (!target) return 'missing'
  if (target.kind === TOPIC_KIND || target.kind === INTERNAL_KIND) return 'struct'
  // 取代必须同 kind（一条结论不能顶掉一条规约）；撤回是"某条记录说另一条错了"，
  // kind 天然不同 —— 现网清掉误写全局规则的那条正是 conclusion 撤回 rule。
  if (edge === 'supersedes' && target.kind !== recKind) return 'kind'
  const targetScope = target._scope || 'workspace'
  if (recScope === 'workspace' && targetScope === 'global') {
    if (edge === 'supersedes') return 'cross_scope'
    // 显式撤回是唯一能清掉误写全局记录的通道（现网 as_026455 就是这条路），
    // 只要求写清理由、不禁止；compact 造的 retracts 恒为同库，不受影响。
    if (!String(reason || '').trim()) return 'cross_scope_reason'
  }
  return ''
}
