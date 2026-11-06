/**
 * 回合末判官（V5 §3）：四类触发 → 一次 LLM 调用 → 严格 JSON → 调用方做确定性校验后落盘。
 *
 * 边界：判官**不在回合关键路径**（turn-stopping 后 fire-and-forget），失败不阻塞会话；
 * 连续 3 次失败由调用方关闭本会话判官并降级为模型主动写（V5 §3.2）。
 */

import { BODY_MAX_CHARS, parseJsonObject } from './schema.js'
import { formatMinute } from './profile.js'

/** 四类触发（V5 §3.1）：只有这四类轮次进入判官，寒暄/纯问答/纯检索 0 调用。 */
const CORRECTION_RE = /(不要|别用|不准|禁止|不许|不能|错了|不对|不是[^，。]{0,6}是|应该|必须|以后都|永远|记住|改成|纠正)/

export function shouldJudge(obs = {}) {
  const reasons = []
  if (obs.filesTouched && obs.filesTouched.size) reasons.push('file-change')
  if (obs.sawError) reasons.push('command-failed')
  const userText = (obs.userMessages || []).join('\n')
  if (CORRECTION_RE.test(userText)) reasons.push('user-correction')
  if (obs.topicWrite) reasons.push('topic-progress')
  return reasons
}

/**
 * 按预算裁剪。用户消息必须保留**尾部**：真实指令是最后说的那句，
 * 从头截断会把最新（也是唯一有用）的话整段砍掉。
 */
function clip(text, max, from = 'head') {
  const s = String(text || '')
  if (s.length <= max) return s
  return from === 'tail' ? '…' + s.slice(-max) : s.slice(0, max) + '…'
}

/** 判官输出契约（V5 §3.2）：单个对象，records 元素不含 v/ts/sid/turn。 */
export function buildJudgeInput({ userMessages = [], assistantText = '', rules = [], topics = [], deadends = [], facts = [], stateNext = '', currentTopic = '' }) {
  const ruleLines = rules.slice(0, 30).map((r) => '- ' + r.id + ' ' + r.body).join('\n') || '（无）'
  const deadendLines = deadends.slice(0, 8)
    .map((d) => '- ' + d.id + ' ' + clip(String(d.body || ''), 80))
    .join('\n') || '（无）'
  // 判官看不到已有 fact 就只能新写一条，旧 fact 永远留着（实测：24h 冷却早删了，事实还在复读）。
  // 把最新的 20 条摆进输入，让它自己判断是不是「同一件事的新结论」。
  const factLines = facts.slice(0, 20)
    .map((f) => {
      const at = formatMinute(f.ts)
      return '- ' + f.id + (at ? '（' + at + '）' : '') + ' ' + clip(String(f.body || ''), 80)
    })
    .join('\n') || '（无）'
  const topicLines = topics.slice(0, 20)
    .map((t) => '- ' + t.id + ' · ' + t.name + '；下一步：' + (t.next || '（已闭环）'))
    .join('\n') || '（无）'
  const system = [
    '你是 dsh 的「工作记忆判官」。读一轮对话，抽出**上下文一丢就再也找不回来**的记录。',
    '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：',
    '{"records":[...],"skip":false,"why":"一句话"}',
    'records 元素字段：kind(state|rule|conclusion|guide|fact|deadend)、body(≤' + BODY_MAX_CHARS + '字单行)、',
    'kind 判据：state=做到哪了；rule=用户下的硬要求；guide=下次能照着跑的有序步骤（含命令/路径/检查点）；约束、原则、一次性改动记录不算 guide；deadend=踩过的坑/犯过的错（真试过、真错了；只收外部世界——工具/API/环境/平台——不按预期的教训；已修复的代码缺陷、关于记忆系统自身写法的反思都不写 deadend）；',
    'fact=**长期不变、与代码实现无关**的断言（它们会汇总进 [项目档案]，是唯一自动注入的记忆）：本机限制（未装 docker 用 wslc）、路径与目录约定、外部服务/凭据位置、网络约束（必须走代理）。',
    '★ 不许写进 fact：①变更叙事（由 X 改为 Y / 已落地 / 已废 / 尚未 / 本轮）——那是 state 或 conclusion；②代码坐标与构建产物（文件:行号 / 版本号 / 包大小 / 文件数 / 测试计数 / 默认值·阈值·并发数·超时值）——那是 conclusion。这两类会被确定性闸门拒收（E_FACT_GATE），别白写。',
    'conclusion=机制/决策/为什么（换个实现就可能变的，如「compact 不再有冷却」「为什么选 8 组」）+ 带依据的判断；必须写 source.quote 记下据以推断的那段原文（命令输出/文件行/用户原话）。',
    '★ conclusion 只收「会改变下一次决策的判断」：改了什么、测了什么、跑过几个测试、讨论经过、本轮进度——一律不写（那是 state 的事）。',
    '★ 同一个判断库里已经有（【现有规约】【现有 topic】或本会话上文里能找到）就不要再写一条；确实要更新就 supersedes 指向旧 id。',
    '★ 写 fact 前对照【现有 fact】（编号 as_xxx 就是那条 id，括号里是写入时间）：同一事实轴且旧内容被本轮推翻 → 新 fact 带 supersedes 指向旧 id；只是补充/细化 → 不动；拿不准就不动。',
    '  括号里的时间就是判断新旧的全部依据：同一参数/路径/开关有新旧两值时，只有最新的那条算当前值，遇到必须 supersedes 旧的，别让两个值并排留着。',
    '★ 每轮 conclusion、fact 各最多 1 条；凑不出一条真正要留的判断，就一条都别写。',
    '★ 某条线的 next 已经完成（本轮自己验证通过，或用户确认）→ 写一条同 topic_id、next 空串的 state 闭环；交接里不该继续挂着已做完的线。',
    '★ deadend 必须对照【现有死路】（编号 as_xxx 就是那条的 id）：',
    '  · 讲同一件事**且没有新情况** → 一条都别写（换个措辞、换个型号名都算同一件）；',
    '  · 讲同一件事**但有新情况**（又试了一条路、结论变了、只剩什么办法）→ 写一条**完整**的新记录：',
    '    旧信息 + 新信息写全，不要只写增量、不要写"同上"，body 要能单独读懂；然后 supersedes 指向那条旧 id。',
    '    旧记录会被取代（不进注入，但留在库里，recall 加 include_expired 仍能查到）；不 supersedes 就会变成两条并排显示。',
    '承诺强度：rule 只收「以后都这么办」的约束（原话含 以后都/永远/禁止/不准/必须，或明确的通用规范）。',
    '原话必须是命令/要求句；疑问句（是不是…？能不能…？）、评价句（我觉得/我认为…）、单次纠正（不只是 X）一律不写 rule。',
    '用户只是让你改这一版（"把 X 删掉 / 换成 Y / 这个不要"）→ 那是决策，已体现在代码里，不要写 rule；',
    '若这次决策有防回退价值，写 conclusion，body 带上"为什么当初不这么做"。',
    '★ 用户否决掉的方案**不是坑**：写 conclusion + topic_id（挂在那条线上，从【现有 topic】抄）+ suspect:["vetoed"]，',
    '  它会缩进显示在该线下面；完全没对应 topic 时不要写 deadend 顶替，宁可写成普通 conclusion。',
    '约束对象：rule 只收约束「我干活方式」的要求（怎么交付/怎么验证/怎么沟通/怎么改这个插件）；',
    '约束「产品做成什么样」的需求已由代码与测试承载，不写 rule——能在测试或代码里被拦住的约束不需要记忆。',
    '锚点：环境事实与判断优先用 turn（本轮对话，可只写 {"type":"turn"}，sid/turn/quote 由系统补），',
    '不要为凑 file 锚点去指一个不相关的文件；只有结论就直接来自某文件某行时才用 file。',
    'criteria(rule/guide 必填：怎么算违规/怎么算跑通)、next(仅 state：下一步必须能照着做——动词开头+完成判据，例「跑 node --test 确认 X 通过」；「顺手确认/关注一下/看情况」不合格；',
    '空串=该线已完成、不再进交接)、',
    'anchor({type:"turn",sid,turn,quote} 或 {type:"file",path,line,quote,sha256} 或 {type:"url",url,fetched_at,sha256})、',
    'source({author:"user"|"model"|"tool",quote:"用户原话片段"})、strength(user_said|measured|inferred)、',
    'scope("workspace"|"global"，缺省 workspace)、topic_id(state 必填：从下面的【现有 topic】清单里逐字抄)、',
    'new_topic(仅当确实是新线时给名字)、topic(其它 kind 的同轴判同用，可空)、supersedes、retracts、reason、confidence(0~1)、suspect(数组)。',
    '铁律：',
    '1) 不要写文件内容/目录结构/版本号等能随时重新读到的东西；事实只留指针（例外：构建/测试/运行命令与工具链入口可以写，只写入口）。',
    '2) 不要写计划。state 只写"已经发生"的事实 + 下一步。',
    '3) rule 的 source.quote 必须逐字来自该轮用户消息；抽不出原话就不要写这条 rule。',
    '4) scope 判据：话里带具体项目/目录/文件/命令/工具链 → workspace（默认）；用户说「以后都/所有项目/每台机器/禁止/不准」这类跨项目要求 → global（只收 rule）。',
    '   global 必须在 why 里原样复述那句用户原话，复述不出或拿不准一律 workspace。',
    '5) 每条 state 必须二选一：topic_id（从【现有 topic】里逐字抄，意思相同就沿用，不要因为措辞更准就起新名）',
    '   或 new_topic（确实是新线）。拿不准是不是同一条线，就沿用清单里最接近的那个 topic_id。',
    '6) 没有值得记的就返回 {"records":[],"skip":true,"why":"..."}。',
    '7) 判据写不实（criteria 只是把 body 复述一遍、说不出怎么算违规/跑通）就填 suspect:["criteria_weak"]，注入时会标 [未复核]。',
  ].join('\n')

  const user = [
    '【本轮用户消息】',
    clip(userMessages.join('\n---\n'), 1500, 'tail'),
    '',
    '【本轮助手结论摘要】',
    clip(assistantText, 1500),
    '',
    '【现有规约（id body）】',
    ruleLines,
    '',
    '【现有 topic（写 state 必须逐字沿用 topic_id；只有确实是新线才写 new_topic）】',
    topicLines,
    '',
    '【现有死路（讲同一件事的就不要再写一条）】',
    deadendLines,
    '',
    '【现有 fact（写 fact 前对照；同一件事有新结论就 supersedes 指向旧 id）】',
    factLines,
    '',
    '【当前 state.next】' + (stateNext || '（无）'),
    '【当前 topic】' + (currentTopic || '（无）'),
    '',
    '【本会话标识】sid=__SID__ turn=__TURN__',
  ].join('\n')
  return { system, user }
}

/** 从模型输出里取出判官结果对象。 */
export function parseJudgeOutput(text) {
  const obj = parseJsonObject(text, '判官')
  if (!Array.isArray(obj.records)) throw new Error('判官输出缺 records 数组')
  return { records: obj.records, skip: obj.skip === true, why: typeof obj.why === 'string' ? obj.why : '' }
}

/**
 * 调用宿主 llm 服务跑一次判官。
 * @param {object} deps { llm, selection, signal, input }
 * @returns {Promise<string>} 纯文本输出（交给 parseJudgeOutput）
 */
export async function callJudge({ llm, selection, input, signal, maxTokens = 1200 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主未提供 llm 服务')
  const provider = selection && selection.provider
  const model = selection && selection.model
  if (!provider || !model) throw new Error('取不到当前模型（provider/model）')
  let text = ''
  let failure = null
  for await (const chunk of llm.stream({
    provider,
    model,
    system: input.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure
  }
  if (failure) throw new Error('判官调用失败：' + (failure.message || failure.code))
  return text
}

/**
 * 结论/事实每轮各至多 max 条（确定性闸门）。
 *
 * 判官没有条数上限时会把"本轮改了什么、讨论了什么"也写成 conclusion：实测一天 47 条、
 * 平均 107 字，成了流水账，而 conclusion/fact 又从不进上下文 ⇒ 只写不读。按顺序保留最前的，
 * 多出的直接在写盘前丢掉（不靠模型自觉，也不额外落盘）。
 */
export function capNarrative(records, max = 1) {
  const seen = { conclusion: 0, fact: 0 }
  const kept = []
  for (const r of records || []) {
    const kind = r && r.kind
    if (kind === 'conclusion' || kind === 'fact') {
      if (seen[kind] >= max) continue
      seen[kind] += 1
    }
    kept.push(r)
  }
  return kept
}

/** 判官给 global 却没在 why 里写出用户原话依据 → 强制降级 workspace（V5 §3.2）。 */export function enforceScope(record, why, userMessages) {
  if (!record || record.scope !== 'global') return record
  const quote = record.source && record.source.quote
  const inUser = typeof quote === 'string' && quote && (userMessages || []).join('\n').includes(quote)
  const whyBacked = typeof why === 'string' && typeof quote === 'string' && quote && why.includes(quote)
  if (inUser && whyBacked) return record
  return { ...record, scope: 'workspace', suspect: [...(record.suspect || []), 'scope_downgraded'] }
}
