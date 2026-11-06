/**
 * 注入渲染（V5 §5.2 / §5.3）：三段模板 + 预算截断。
 *
 * 渲染禁令（V5 约束 4，写在这里防止后人加回去）：
 * 禁止输出当前时间、轮次号、会话 id、"更新于"、随机/哈希排序。
 * 排序键固定为 (强度, id)——纯函数，不含 lastSeen/时钟；条目只能带**自己**的日期。
 */
import { strengthRank } from './schema.js'

/** token 估算：CJK≈1 字 1 token、ASCII≈3 字 1 token，取中间值 2 字/token。 */
export const estimateTokens = (text) => Math.ceil([...(text || '')].length / 2)

const mmdd = (ts) => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function ruleLine(rec) {
  const weak = Array.isArray(rec.suspect) && rec.suspect.includes('criteria_weak')
  const quote = rec.source && rec.source.quote ? '——"' + rec.source.quote + '"' : ''
  const when = rec.ts ? '(' + mmdd(rec.ts) + ')' : ''
  return '- ' + (weak ? '[未复核] ' : '') + rec.body + quote + when
}

/**
 * 规约段（section order 9010）：[规约 · 全局] 在前，[规约 · 本工作区] 在后。
 * 统一排序 + 统一截断（不按作用域偏袒）；预算由调用方给（插件传 injectBudgetTokens，默认 1500）。
 *
 * ★ 排序键必须是**纯函数**：只允许 `(强度, id)`。
 *   这一段进系统提示、是 provider 缓存前缀的一部分；一旦把运行期时钟/命中索引放进
 *   排序键，就会出现"一条记忆都没写、只读了一遍，前缀字节就变"——缓存白丢。
 *   `lastSeen` 只服务召回排序与配额淘汰，**不参与注入顺序**（V5 §5.2 约束 4）。
 */
export function renderRules({ global = [], workspace = [], budgetTokens = 1500 } = {}) {
  const all = [...global.map((r) => ({ r, scope: 'global' })), ...workspace.map((r) => ({ r, scope: 'workspace' }))]
  const ranked = all.sort((x, y) => {
    const sx = strengthRank(x.r.kind, x.r.strength)
    const sy = strengthRank(y.r.kind, y.r.strength)
    if (sx !== sy) return sy - sx
    return String(x.r.id) < String(y.r.id) ? -1 : 1
  })

  const picked = []
  let used = 0
  for (const item of ranked) {
    const line = ruleLine(item.r)
    const cost = estimateTokens(line) + 1
    if (used + cost > budgetTokens) break
    picked.push({ ...item, line })
    used += cost
  }
  const g = picked.filter((x) => x.scope === 'global')
  const w = picked.filter((x) => x.scope === 'workspace')
  const blocks = []
  if (g.length) blocks.push('[规约 · 全局]\n' + g.map((x) => x.line).join('\n'))
  if (w.length) blocks.push('[规约 · 本工作区]\n' + w.map((x) => x.line).join('\n'))
  return blocks.join('\n\n')
}

/** 指南命中：用本轮用户文本做子串命中（无 embedding，V5 §6.2）。
 *  中文没有空格，按 2 字滑窗切 bigram 才能命中；英文仍按空白切词。 */
export function hitGuides(guides, recentUserText, limit = 8) {
  const text = String(recentUserText || '')
  const words = new Set()
  for (const w of text.split(/[\s,，。、;；:：!！?？()（）"'`]+/)) {
    const t = w.trim().toLowerCase()
    if (t.length < 2) continue
    if (/[\u4e00-\u9fff]/.test(t)) {
      for (let i = 0; i + 2 <= t.length; i++) words.add(t.slice(i, i + 2))
    } else {
      words.add(t)
    }
  }
  if (!words.size) return []
  const scored = []
  for (const g of guides) {
    // 只拿 body 匹配：criteria 是"怎么算跑通"的判据文本，纳入会凭空放大命中面。
    // 阈值 ≥2：中文按 2 字滑窗切片，单个二字词撞上正文只是巧合，不足以说明"这条指南和本轮有关"。
    const hay = String(g.body || '').toLowerCase()
    let hits = 0
    for (const w of words) if (hay.includes(w)) hits++
    if (hits >= 2) scored.push({ g, hits })
  }
  scored.sort((x, y) => (y.hits - x.hits) || (String(x.g.id) < String(y.g.id) ? -1 : 1))
  return scored.slice(0, limit).map((x) => x.g)
}

/** 单行截断：只影响「交接」行的长度，不参与规约段（保证前缀字节稳定）。 */
function clipText(text, max) {
  const s = String(text || '')
  return [...s].length > max ? [...s].slice(0, max).join('') + '…' : s
}

/**
 * 交接段（V5 §5.2）：state 按 topic 平铺，一行一条线，不再有「目标/在做」这套分类。
 *
 * 为什么不分：交接没有自己的信息源，它的每一行都来自一条 state；把空 topic 那条抬成
 * 「目标」、其余压成「在做」，既让 body/next 各渲染一次（与「工作线」分区重复），又暗示
 * "一件事为主、几件附属"——与"同一工作区并行几件事、谁都不许顶掉谁"直接冲突。
 * 真实模型只有一句：每个 topic 一条当前状态，topic 必填、各行地位相同，没有特权桶。
 *
 * 闭环：桶的 next 为空串 = 本线已闭环，不进交接（工作线分区里仍可查）。
 *
 * ★ 不再有「[记忆目录] 只在边界轮出现」这一行：宿主每步渲染两次 context（preStep 的
 *   assemble → step 的 refreshContext），落地的是第二次，第一次就把边界标志吃掉 ⇒
 *   该行永远到不了模型（实测 21 份快照 0 份含它）。与其留个假分支，不如删掉。
 */
/**
 * 交接段里**完整展示**（带 body）的线数。
 * 超出的线不丢弃：降级成一行「名称 (tp_id)：下一步」，让模型知道还有哪几条线、
 * 能直接接着做（要细节再按 id recall）。上限之外只报总数——那是最后一档防爆。
 */
export const HANDOFF_LINES = 3
/** 降级行最多列几条；再多只报总数，细节交给 waystone_recall。 */
const HANDOFF_MORE_MAX = 6

export function renderTail({
  stateBuckets = [],
  activeDeadends = [],
  activeGuides = [],
  profile = '',
  recentUserText = '',
  budgetTokens = 500,
  rotate = 0,
} = {}) {
  const parts = []
  const guides = hitGuides(activeGuides, recentUserText)
  if (guides.length) {
    // 带 id：模型拿到 as_xxxxxx 就能直接 waystone_recall({query:'as_xxxxxx'}) 取全文，不用再猜关键词。
    const names = guides.map((g) => (g.id ? g.id + ' ' : '') + (g.body.length > 40 ? g.body.slice(0, 40) + '…' : g.body))
    let line = '[指南索引] ' + guides.length + ' 条命中：' + names.join(' / ') + ' —— 把 id 传给 waystone_recall 取全文'
    // 超预算时降级成只留 id：id 是取全文的唯一钥匙，正文摘要才是可牺牲的那部分
    if (estimateTokens(line) > 200) {
      const ids = guides.map((g) => g.id).filter(Boolean)
      line = '[指南索引] ' + guides.length + ' 条命中：' + ids.join(' / ') + ' —— 把 id 传给 waystone_recall 取全文'
    }
    parts.push(line)
  }

  // 项目档案：fact 的汇总摘要。放在交接前、**不参与 over() 裁剪**——档案一大，
  // 死路与线就会被连带丢光；长度上限由生成侧控制（PROFILE_MAX_CHARS）。
  const profileBlock = profile ? '[项目档案]\n' + profile : ''

  // 并行多线：一条线一行，按 ts 倒序（V5 §5.2）。行首带 topic_id：模型直写 state 时要拿它认线。
  // 该线被否决过的方案（bucket.vetoes）缩进两格挂在线下面：否决属于这条线，不是跨线教训。
  const topics = [...stateBuckets]
    .filter((b) => !b.closed && b.topicName)
    .sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
    .map((b) => ({
      main: '- ' + (b.id ? b.id + ' ' : '') + b.topicName + (b.topicId ? ' (' + b.topicId + ')' : '') + '：' + clipText(b.body, 120)
        + (b.next ? '；下一步：' + clipText(b.next, 60) : ''),
      // 降级行：不带宽 body，但保留「名称 + topic_id + 下一步」——这三样就够模型
      // 认出是哪条线、并直接接着做（要前因后果再按 id recall）。
      brief: '- ' + b.topicName + (b.topicId ? ' (' + b.topicId + ')' : '')
        + (b.next ? '：下一步：' + clipText(b.next, 40) : ''),
      // 否决子行同样带自己的 as_ 记录 id：模型要判"这次是不是重提了被否的方案"，得能直取原文。
      subs: (Array.isArray(b.vetoes) ? b.vetoes : []).map((v) => {
        const vid = typeof v === 'string' ? '' : String((v && v.id) || '')
        const vbody = typeof v === 'string' ? v : String((v && v.body) || '')
        return '  ✗ 已否决' + (vid ? ' ' + vid : '') + '：' + clipText(vbody, 60)
      }),
    }))
  const flatten = (list, withSubs) => list.flatMap((t) => (withSubs ? [t.main, ...t.subs] : [t.main]))
  // 第 4 条起的线降级成一行（不再整条丢掉——丢掉等于模型永远不知道它还开着）。
  // 降级行也封顶 HANDOFF_MORE_MAX 条：几十条并行时不能靠一行行堆进预算，只报总数。
  const briefs = topics.slice(HANDOFF_LINES, HANDOFF_LINES + HANDOFF_MORE_MAX).map((t) => t.brief)
  const restCount = Math.max(0, topics.length - HANDOFF_LINES - briefs.length)
  // 死路窗口按轮转取，不再是「永远最新 3 条」：集合不变时最老的几条永远排不到。
  // 步长 = 窗口宽（3）：每轮跳 3 条，相邻两轮不重叠，只在回绕那一轮重叠；
  // 步长 1 会让窗口只平移一条，每条死路连着 3 轮出现，等于没轮转。
  // 3 个位置装 N 条，重复本身消不掉（N 不是 3 的倍数时回绕必重叠），这已是同条数下的最小值。
  const sortedDead = [...activeDeadends].sort((x, y) => (Date.parse(y.ts) || 0) - (Date.parse(x.ts) || 0))
  const nDead = sortedDead.length
  const start = nDead ? (((rotate * 3) % nDead) + nDead) % nDead : 0
  const blocked = [...sortedDead.slice(start), ...sortedDead.slice(0, start)]
    .slice(0, 3)
    .map((d) => (d.id ? d.id + ' ' : '') + clipText(d.body, 100))

  // 空库不注入：没有线、没有死路、没有指南命中时整段返回空串。
  // 没有线但还有死路/指南命中时也照样不补占位行——占位行只是每步白烧几十字，
  // 且会让模型以为交接段"应该有内容却丢失了"。
  // 空库不注入：没有线、没有死路、没有指南命中、也没有项目档案时整段返回空串。
  if (!parts.length && !profileBlock && !topics.length && !blocked.length) return ''

  const head = '[交接]'
  const deadHead = '[死路 · 别重试]'
  // 段尾原放「状态可能滞后 ≤5 轮」免责声明；滞后信息由契约一.3 承担，段尾（注意力最强处）
  // 改放行动指令：没有这句，模型读完只当参考资料，不会把 next 当待办去做。
  // 不加列表符号：它不是一个「条目」，是整段的执行要求；用粗体独立成行，避免被读成第 N 条待办。
  const handoffLine = '**接手：上面的「下一步」是待办 —— 能做的先做，做完就把那条线的下一步更新掉。**'

  // 死路独立成段（B）：它不是任何一条线的附属，混在交接里既挤掉线本体、又分不清先读哪个。
  // 有正文才出段头；两者都没有时返回空串，不留 [交接] 空壳。
  const build = (shown, dead, more, rest) => {
    const out = []
    if (shown.length || more.length || rest > 0) {
      const lines = [head, ...shown, ...more]
      // 最后一档：超出降级行上限的只报总数——模型知道还有 N 条、并知道怎么列出来
      if (rest > 0) lines.push('…另有 ' + rest + ' 条线未展开（waystone_recall({kind:"state"}) 看全部）')
      // 粗体行前留一个空行：它自成一段（Markdown 里紧跟列表的粗体会被并进最后一个条目）。
      lines.push('', handoffLine)
      out.push(lines.join('\n'))
    }
    if (dead.length) out.push([deadHead, ...dead.map((d) => '- ' + d)].join('\n'))
    return out.join('\n\n')
  }

  // 预算收紧顺序（V5 §5.3）：先丢跨线教训（死路）→ 再丢各线的否决子行 → 完整线砍到 1 条
  // → 再丢降级行（只留总数）→ 最后丢整段。
  // 依据：线本体是当前工作 > 本线的否决（防重提同一方案）> 跨线教训（可能与本线无关）。
  // 降级行排在「完整线砍到 1 条」之后才丢：宁可少一条带 body 的线，也别让模型以为只有这一条线开着。
  const over = (b) => estimateTokens(parts.join('\n\n') + '\n\n' + b) > budgetTokens
  let block = build(flatten(topics.slice(0, HANDOFF_LINES), true), blocked, briefs, restCount)
  if (over(block)) block = build(flatten(topics.slice(0, HANDOFF_LINES), true), [], briefs, restCount)
  if (over(block)) block = build(flatten(topics.slice(0, HANDOFF_LINES), false), [], briefs, restCount)
  if (over(block)) block = build(flatten(topics.slice(0, 1), false), [], briefs, restCount)
  if (over(block)) block = build(flatten(topics.slice(0, 1), false), [], [], restCount)
  if (over(block)) block = '' // 最后丢整段：只剩 head + 接手行纯属噪声

  const out = [...parts, profileBlock, block].filter(Boolean).join('\n\n')
  return out
}

/**
 * 失败可见（V5 §5.4）：组装/读取/配置异常 → 单行，会话不阻塞。
 * `detail` 给"改哪个字段"，模型与用户都能照着修（J3：注入面不能只给码）。
 */
export function renderUnavailable(code, detail) {
  return '[记忆不可用：' + code + (detail ? ' ' + detail : '') + ']'
}

/** 从配置错误里取出首个字段路径（`config.rulesMax` 之类），给注入面用。 */
export function firstFieldPath(error) {
  const m = /config\.[A-Za-z_][A-Za-z0-9_]*/.exec(String(error || ''))
  return m ? m[0] : ''
}
