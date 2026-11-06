/**
 * 项目档案（profile）：把工作区里的 fact 汇总成一段「这个项目怎么构建/测试/运行」的摘要，
 * 注入到对话尾部（[项目档案] 段），让环境信息不靠 recall 也能被看见。
 *
 * 只在 fact 集合内容变化时重生成（profile.json 存 hash）；产物是一条 fact 记录，
 * 用 suspect:['profile'] 标记，旧档案通过 retracts 撤回（append-only，原文仍可取回）。
 */

import { createHash } from 'node:crypto'
import { parseJsonObject } from './schema.js'

/** 档案正文上限：环境信息比单条事实长得多，单独放宽；普通 fact 仍是 500 字。 */
export const PROFILE_MAX_CHARS = 3000
/**
 * 提示词/格式版本：参与生成指纹，改了档案格式就该重生成一次。
 * 否则事实没变 ⇒ hash 不变 ⇒ 旧格式档案永远留着。
 */
export const PROFILE_PROMPT_VERSION = 'v5'

/**
 * 事实的写入时间，精确到分钟（本地墙钟）。
 * 判官/档案整理官靠它分辨「同一事实轴上的新旧」——没时间就只能在新旧两条 fact 里随机挑。
 * 兼容旧的 UTC Z 记录：Date 解析后按本机时区格式化。
 */
export function formatMinute(ts) {
  const d = new Date(String(ts || ''))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 事实集合的内容指纹：顺序无关，任一 body 变化都会触发重生成。 */
export function profileHash(facts = []) {
  const src = [...facts]
    .map((r) => String(r.id || '') + '\u0000' + String(r.body || ''))
    .sort()
    .join('\n')
  return createHash('sha256').update(src).digest('hex')
}

export function buildProfileInput({ facts = [], project = '' } = {}) {
  const lines = facts.map((r) => {
    const at = formatMinute(r.ts)
    return '- ' + r.id + (at ? '（' + at + '）' : '') + (r.topic ? ' [' + r.topic + ']' : '') + ' ' + String(r.body || '')
  })
  const system = [
    '你是 dsh 的「项目档案整理官」。把同一个项目积累的环境事实（fact）汇总成一段「项目档案」。',
    '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：{"body":"…"} 或 {"skip":true}',
    '规则：',
    '1) 只能用输入 fact 里已有的信息，不得推断、补全或写"通常/一般"；没把握就不写，宁可少写。',
    '2) 按主题分节，每节一行、行首用 1) 2) 3) 编号（构建/编译 → 测试 → 运行/部署 → 工具链/容器 → 平台与环境限制）；不要按输入顺序罗列。',
    '3) 正文用换行分行（JSON 字符串里写 \\n），≤' + PROFILE_MAX_CHARS + ' 字；同一件事只写一次；任务流水账、进度、计划不入档。',
    '4) 保留命令、路径、约束这些"下次要用的入口"；档案是摘要，细节仍靠 recall 原始 fact。',
    '5) 没有可汇总的就返回 {"skip":true}。',
    // 档案最常见的失败形态：把 fact 原文按主题串起来，读起来像拼接。这一条把它压成提炼。
    '6) 提炼不是拼接：同一主题的多条 fact 要合并成一条**结论性**条目（命令/路径/约束/平台限制优先），'
      + '删掉过程、历史、日期、重复与理由铺陈；每条尽量一句话，能写命令就不写描述；'
      + '总量尽量 ≤1500 字，超了继续压。允许丢细节——原文仍能 recall 取回。',
    // 输入每条带写入时间（分钟级）。档案里不许出现时间，但**必须用时间来裁决冲突**，
    // 否则「并发上限 2」和「并发上限 6」会被并列写进档案（实测踩过）。
    '8) 冲突取新：同一事实轴（同一参数/路径/开关/机制）给出了不同值时，**只写最新的那一条**（按输入里的写入时间判断；'
      + '没有时间的按输入顺序靠后视为更新），旧值当作已过期，不许并列、不许写"曾为/改为"；'
      + '时间只用于这个判断，不要出现在档案正文里。',
    // 档案是「入口」不是「全集」：概括到能判断该不该 recall 即可；插件会自动在末尾附上来源 fact id。
    '7) 档案是入口不是全集：只写"是什么、用什么命令/路径、有什么限制"，具体细节交给来源 fact；'
      + '不要试图把每条 fact 都塞进来。',
  ].join('\n')
  const user = ['【项目】' + (project || '（未命名）'), '', '【现有 fact】', lines.join('\n') || '（无）'].join('\n')
  return { system, user }
}

/** 从模型输出里取出档案结果对象。 */
export function parseProfileOutput(text) {
  const obj = parseJsonObject(text, '档案')
  return {
    body: typeof obj.body === 'string' ? obj.body : '',
    quote: typeof obj.quote === 'string' ? obj.quote : '',
    skip: obj.skip === true,
  }
}

/**
 * 确定性校验：非空、不超上限；保留换行（档案是按主题分行的多行文本）。
 * 不合格返回 null——档案是可选产物，宁可这一轮不落盘，也不能把空白/超长档案塞进 tail。
 */
export function pickProfile(out) {
  if (!out || out.skip) return null
  const body = String(out.body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!body || [...body].length > PROFILE_MAX_CHARS) return null
  return { body, quote: String(out.quote || '').replace(/[\r\n]+/g, ' ').trim() }
}

/**
 * 在档案末尾附上来源 fact id（「来源：as_xxx as_yyy …」）。
 * 由插件确定性拼接、不经过模型，所以不会指错；模型只写概括，细节靠这些 id recall
 * （合并过的旧 fact 可能是 expired，取原文要带 include_expired:true）。
 */
export function attachSources(body, facts = []) {
  const ids = [...new Set((facts || []).map((r) => String((r && r.id) || '')).filter(Boolean))]
  if (!ids.length) return body
  const line = '来源：' + ids.join(' ')
  const room = PROFILE_MAX_CHARS - line.length - 1
  if (room <= 0) return body
  const text = [...String(body || '')].slice(0, room).join('')
  return text + '\n' + line
}
