/**
 * 记忆整理官（合并）：conclusion / fact 超限时，把讲同一件事的多条压成一条。
 *
 * 为什么不是子代理：这件事是「读 N 条 JSON → 写 M 条 JSON」，不需要任何工具能力。
 * 走判官同一条通道（llm.stream 一次调用 + 严格 JSON + 确定性校验），比开一整个
 * agent 会话小一个数量级，也不会顺手改文件。
 *
 * 边界：只处理 conclusion/fact；旧记录靠 retracts 变 expired（append-only，原文仍在盘上，
 * include_expired 能取回），不物理删除。
 */

import { topicIdOf, parseJsonObject } from './schema.js'
import { formatMinute } from './profile.js'

/**
 * 合并记录的正文上限：合并 5-10 条长事实时，正文天然超过普通记录的 500 字。
 * 固定 800（单条、不随轮次增长）——合并是「提炼」不是拼接，压不进去就少合/拆组。
 */
export const MERGE_BODY_MAX_CHARS = 800
/**
 * 每组按来源条数摊销的预算（2026-11-06）：只有绝对上限 800 时，模型会把 5 条合成 974 字
 * （每条约 195 字 ≈ 原文长度，等于没压）。按成员数给预算，成员越多越要揉成一句，
 * 而不是等比例变长。超出预算的组按「超长」丢弃（来源不 retract，下一轮重试）。
 */
export const MERGE_BODY_PER_MEMBER = 120
/** 一组合并后的正文预算：成员数 × 120，但不超过 800。 */
export function mergeBodyBudget(members) {
  return Math.min(MERGE_BODY_MAX_CHARS, Math.max(2, Number(members) || 2) * MERGE_BODY_PER_MEMBER)
}

/**
 * 触发阈值（2026-11-06 合并为单一阈值）：池内（conclusion + fact，不含项目档案）有效记录
 * 总数达到 MAX_POOL 就整理一次。没有冷却——池子落回阈值以下自然就停。
 * 缺省值只是兜底：线上由配置 `compactPoolMax` 覆盖（store.CONFIG_FIELDS 是默认值真源，
 * test/compact.test.js 有断言守着）。分成「结论 60 / 事实 40」两档已废止：一次调用同时处理
 * 两类记录，两个阈值之间没有可调的含义，只剩推算配额的副作用。
 */
export const MAX_POOL = 60
/** 单次最多产出几组合并结果。5 组时容量只比 40% 目标多 1-2 条，丢一组就不够本；8 组留出冗余。 */
export const MAX_GROUPS = 8
/** 单次送入模型的条数由配置 `compactBatch` 决定（取最新的 N 条，默认 60）。
 *  不做全量：切批的代价是尾批之外的记录看不到，但如果一次全送，pool 涨到几百条时输入会失控。
 *  收敛靠「不冷却 + 每轮重跑」：合并后 pool 仍超阈值，下一轮再取最新 N 条，直到 pool 落回阈值以下。 */
/** 单次整理至少要砍掉的条目比例：提示词里的目标（护栏另有一条更低的硬底线）。 */
export const MIN_SHRINK = 0.4
/**
 * 落盘硬底线：只砍到目标的 20% 也收。
 * 原来把 40% 当硬门槛，模型少砍 3-6 条就整批作废（实测 turn 9/11/12 全因一组超长连坐丢掉 7 条），
 * 白烧一次调用且池子一点没降。现在「够本」按 20% 判，40% 仍是提示词目标，靠多轮收敛。
 */
export const HARD_MIN_SHRINK = 0.2
/** 送入 n 条时，合并后的总数上限（提示词目标）。 */
export const shrinkTarget = (n) => Math.ceil(n * (1 - MIN_SHRINK))
/** 护栏：合并后的总数不能超过这条线，否则整批作废。 */
export const hardTarget = (n) => Math.ceil(n * (1 - HARD_MIN_SHRINK))
/** 这批合并够不够本：连硬底线都砍不到就整批作废，别让一次模型调用只换来省 1 条。 */
export const meetsShrink = ({ before = 0, retracted = 0, added = 0 } = {}) =>
  before - retracted + added <= hardTarget(before)

/** 该不该整理（纯函数，方便直接测阈值）。阈值可被配置覆盖（V5 §8）。 */
export function shouldCompact(total = 0, max = MAX_POOL) {
  return Number(total) >= Number(max)
}

/**
 * 挑本批送进整理官的记录：按池内实际构成分配批次（2026-11-06）。
 *
 * 早期按固定比例（阈值 60:40 ⇒ 结论 36 / 事实 24）切批，某一类不够时会出现空位；
 * 现在比例跟着池子走：事实占池子 20% 就给 20% 的位子，**每类只要有记录至少给 1 个位子**
 * （否则事实刚超限也可能一条都进不了批次，白跑一轮），某类不够则余量补满。
 * 仍只取每类「最新 N 条」：更老的记录进不了窗口，靠多轮收敛（已知代价）。
 */
export function pickBatch(pool = [], { batch = 60 } = {}) {
  const limit = Math.max(2, Number(batch) || 60)
  const cons = pool.filter((r) => r.kind === 'conclusion')
  const facts = pool.filter((r) => r.kind === 'fact')
  const all = cons.length + facts.length
  if (!all) return []
  const n = Math.min(limit, all)
  let nc = cons.length ? Math.round(n * (cons.length / all)) : 0
  let nf = facts.length ? n - nc : 0
  // 每类至少 1 个位子（该类存在时），再从另一类匀
  if (cons.length && nc < 1) { nc = 1; nf = n - nc }
  if (facts.length && nf < 1) { nf = 1; nc = n - nf }
  nc = Math.min(nc, cons.length)
  nf = Math.min(nf, facts.length)
  // 某类不够 → 余量给另一类，批次仍装满
  const spare = n - nc - nf
  if (spare > 0) {
    const addC = Math.min(spare, cons.length - nc)
    nc += addC
    nf = Math.min(facts.length, nf + (spare - addC))
  }
  return [...cons.slice(-nc), ...facts.slice(-nf)]
}

const strongOrder = ['measured', 'user_said', 'inferred']
const strongest = (recs) => strongOrder.find((s) => recs.some((r) => r.strength === s)) || 'inferred'

export function buildCompactInput({ records = [] } = {}) {
  const lines = records.map((r) => [
    r.id,
    r.kind + (Array.isArray(r.suspect) && r.suspect.includes('vetoed') ? '（已否决）' : ''),
    r.topic ? '[' + r.topic + ']' : '[]',
    formatMinute(r.ts) || '—',
    String(r.body || '').replace(/\s+/g, ' '),
    r.source && r.source.quote ? '｜依据：' + String(r.source.quote).replace(/\s+/g, ' ') : '',
  ].join(' | '))
  const nC = records.filter((r) => r.kind === 'conclusion').length
  const nF = records.filter((r) => r.kind === 'fact').length
  const system = [
    '你是 dsh 的「记忆整理官」。下面是同一个项目里积累的 conclusion（判断）与 fact（环境事实）记录。',
    '把讲同一件事的几条压成一条更短、更结实、更适合被检索的记录。',
    '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
    '{"groups":[{"kind":"conclusion|fact","body":"…","topic":"…","quote":"…","merge":["as_xxx","as_yyy"]}]}',
    '铁律：',
    '1) merge 至少 2 个 id，逐字来自输入；同一 id 只许出现在一组；没把握就别输出这一组。',
    '2) 合并是**提炼**不是摘抄：读完所有成员，用你自己的话写一条，让人一眼判断「以后要不要查它」。',
    '   ✗ 反例：把成员的路径、版本、实测过程连成一长串，用分号隔开——那是复制，不是合并。',
    '   ✓ 正例：一句写结论，一句写边界或为什么；最容易忘的那一条命令才留。',
    '3) 硬预算：一组正文 ≤' + MERGE_BODY_MAX_CHARS + ' 字，且尽量 ≤ 成员数 × ' + MERGE_BODY_PER_MEMBER + ' 字'
      + '（5 条 → 约 ' + 5 * MERGE_BODY_PER_MEMBER + ' 字）；超出预算的组直接作废（不是截断），来源原样留到下一轮。'
      + '压不进就少合几条或拆成更多组——宁可不合，也别写长。',
    '4) 该留：会改变下一次行为的——路径/命令/端口/阈值/字段名/约束条件/「为什么这么定」。'
      + '该删：过程与时间线（改了什么、测了什么、第几轮）、重跑一遍就能拿到的细节、同义重复、语气词。'
      + '删了也查得回来：被 retract 的原记录仍在库里，加 include_expired 可取回；这里只写「够用来判断要不要 recall」的摘要。',
    '5) 不许第一人称与叙述口吻：不写「本轮/我/我们/实测发现/然后」；名词短语＋分号即可。',
    '6) 一条只讲一件事：成员横跨两件事就拆成两组，别写成「既是 A 又是 B」的杂烩。',
    '7) quote 从成员的依据里逐字挑一句（没有就抄该组正文里最关键的一句）。',
    '8) topic 写最贴切的一个组名；跨 topic 的同一件事可以并成一组。',
    '9) 最多 ' + MAX_GROUPS + ' 组；没有可合并的就是 {"groups":[]}。',
    '10) 本次送入 ' + records.length + ' 条（结论 ' + nC + ' / 事实 ' + nF + '）：目标 ≤ ' + shrinkTarget(records.length)
      + ' 条（砍 ' + Math.round(MIN_SHRINK * 100) + '%）；硬底线 ≤ ' + hardTarget(records.length)
      + ' 条（砍 ' + Math.round(HARD_MIN_SHRINK * 100) + '%）。低于底线只记警告、照样落盘；'
      + '但超长的组比不合并更糟——先保证每组在预算内，再谈覆盖多少条。',
    '11) 标了「已否决」的只能与同为「已否决」、且同一条线（topic 相同）的记录合并；合并后的正文必须写出否掉了哪个方案、为什么否，绝不能和普通结论混成一条。',
    '12) 一组只能有一种 kind：merge 里的每个 id 必须与该组的 kind 全部一致。事实和判断讲同一件事也不能合——'
      + '被混进结论的事实会被判成"已被取代"而从库里消失。同一件事两边各有一面（事实=是什么/入口，判断=为什么/取舍）时，'
      + '让它们各自留一条；结论里别复述事实的具体命令与路径。',
    '13) fact 只留当前值：同一事实轴（同一参数/路径/开关/机制）在不同成员里给出了不同值，按写入时间**只保留最新那个值**，'
      + '旧值直接丢弃——不许并列两个值，也不许写「曾为 / 改为 / 已废弃」。fact 不写历史、不写为什么；时间只用于判断谁新，不要写进正文。',
    '14) 分不清就不合：判断不出两条 fact 是否同一事实轴、或判断不出谁更新时，别把它们合成一组——来源留着，下一轮再判。'
      + '把两个值糊进一条正文，比不合并更糟。',
  ].join('\n')
  const user = ['【待整理的记录】', lines.join('\n') || '（无）'].join('\n')
  return { system, user }
}

/** 从模型输出里取出整理结果对象。 */
export function parseCompactOutput(text) {
  const obj = parseJsonObject(text, '整理官')
  return { groups: Array.isArray(obj.groups) ? obj.groups : [] }
}

const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim()

/**
 * 确定性校验整理官的输出（纯函数）。任何一条不达标就丢掉整组，绝不"尽力修补"——
 * 合并是有损操作，宁可少合，也不能合出一条来源不明的结论。
 *
 * @param {object[]} groups 模型给的 groups
 * @param {object[]} pool   送进去的记录（用来核对 id 与取依据）
 * @param {object[]} [dropped] 可选收集器：把「因正文超长被丢」的组记进来（group 级信息，不含正文），
 *   供调用方写审计。丢掉的组不 retract 任何来源，原记录保持 active，下一轮仍是候选。
 * @returns {{kind:string,body:string,topic:string,quote:string,strength:string,retracts:string[],suspect?:string[],topicId?:string}[]}
 */
export function pickMerges(groups, pool, dropped) {
  const byId = new Map((pool || []).map((r) => [r.id, r]))
  const used = new Set()
  const out = []
  for (const g of groups || []) {
    if (out.length >= MAX_GROUPS) break
    if (!g || typeof g !== 'object') continue
    const kind = g.kind
    if (kind !== 'conclusion' && kind !== 'fact') continue
    const ids = Array.isArray(g.merge) ? g.merge.filter((id) => typeof id === 'string') : []
    if (ids.length < 2) continue
    // id 必须全在 pool 里、不许重复、不许跨组复用
    if (new Set(ids).size !== ids.length) continue
    if (!ids.every((id) => byId.has(id) && !used.has(id))) continue
    const members = ids.map((id) => byId.get(id))
    // 组内必须同 kind：把 fact 混进 conclusion 组会让那条 fact 被 retract 成"已过期"，事实凭空消失。
    if (!members.every((r) => r.kind === kind)) {
      if (Array.isArray(dropped)) dropped.push({ code: 'E_KIND_MIX', kind, merges: ids.length })
      continue
    }
    // 被否决的方案只和「同为已否决、且同一条线」的记录合并：
    // 混组会把「否掉 A」糊到普通结论上；跨线合并后挂不回任何一条线，交接里的 ✗ 子行就没了。
    const vetoes = members.filter((r) => Array.isArray(r.suspect) && r.suspect.includes('vetoed'))
    const vetoKey = vetoes.length ? new Set(vetoes.map((r) => topicIdOf(r))) : null
    if (vetoKey && (vetoes.length !== members.length || vetoKey.size !== 1)) continue
    const body = oneLine(g.body)
    // 预算 = min(800, 成员数 × 120)：绝对上限挡不住「5 条写成 974 字」，按成员数摊销才逼出取舍。
    const budget = mergeBodyBudget(members.length)
    if (!body || [...body].length > budget) {
      // 只丢这一组，不丢整批：其余组照常合并，这一组的来源不动 → 下一轮还会进窗口重试。
      if (Array.isArray(dropped)) {
        dropped.push({ code: 'E_BODY_GROUP', kind, merges: ids.length, chars: body ? [...body].length : 0, max: budget })
      }
      continue
    }
    const quote = oneLine(g.quote) || oneLine((members.find((r) => r.source && r.source.quote) || {}).source?.quote) || oneLine(members[0].body).slice(0, 200)
    const topic = vetoes.length ? (vetoes[0].topic || '') : (oneLine(g.topic) || members.map((r) => r.topic).find(Boolean) || '')
    for (const id of ids) used.add(id)
    const op = { kind, body, topic, quote, strength: strongest(members), retracts: ids }
    if (vetoes.length) {
      op.suspect = ['vetoed']
      const tid = [...vetoKey][0]
      if (tid) op.topicId = tid
    }
    out.push(op)
  }
  return out
}
