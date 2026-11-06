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
