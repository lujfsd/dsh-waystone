/**
 * 存储层（V5 §2.1 / §8）：统一存储根 + 两级作用域 + JSONL 分片追加 + 读时合并。
 *
 * 不变量：
 *  - append-only：本文件只有 appendFileSync，没有任何 rename/truncate/删除；
 *  - 单写者：一个会话只写自己的 <sid>.jsonl，跨分片在读取时合并（无锁）；
 *  - 切换 dataDir 不迁移：改根即指向新库，旧根原样留着（doctor 负责回显残留）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/**
 * 六个可配置字段的唯一定义（类型 / 范围 / 默认值），报错文案也共用——
 * 都带 `config.<字段名>`，注入面据此给出字段路径（J3）。
 */
const CONFIG_FIELDS = {
  rulesMax: { type: 'int', min: 1, max: 200, fallback: 30 },
  injectBudgetTokens: { type: 'int', min: 200, max: 8000, fallback: 1500 },
  compactConclusionMax: { type: 'int', min: 1, max: 500, fallback: 60 },
  compactFactMax: { type: 'int', min: 1, max: 500, fallback: 40 },
  compactBatch: { type: 'int', min: 10, max: 200, fallback: 60 },
  dataDir: { type: 'string', fallback: '' },
}
export const CONFIG_DEFAULTS = Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([key, spec]) => [key, spec.fallback]),
)

/**
 * 统一时间戳：**本地时间 + 偏移**（`2026-11-05T23:25:54.123+08:00`）。
 *
 * 为什么不用 `toISOString()`（UTC）：人会把它读成本地时间——`15:25:54Z` 其实是本地
 * `23:25:54`，同一轮里拿它和 `ls --time-style=full-iso` / `find -newermt` / 面板显示
 * （全是本地 +08）比先后，必然差 8 小时、结论直接反。
 * 为什么仍带偏移而不是裸本地时间：裸时间没有时区信息，机器解析会按当前系统时区猜，
 * 换机器/DST/搬家后排序与“哪条更新”都会错。带偏移两者兼得。
 * 兼容：老数据是 UTC `Z`，`Date.parse` 两种都认，append-only 不迁移。
 */
export function nowIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const abs = Math.abs(off)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + '.' + p(d.getMilliseconds(), 3)
    + (off >= 0 ? '+' : '-') + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
}

/** 宿主不给 pluginDataDir 时的回落根（V5 §2.1 优先级 4）。 */
export function fallbackHome() {
  return path.join(os.homedir(), '.dsh')
}

/**
 * 插件数据根：宿主给的 `baseDir` → `~/.dsh`（V5 §2.1）。
 * ★ `ctx.baseDir` 在 Cordis 里是 reflect 属性，未在 `inject` 里声明时**读取即抛**
 *   （实测：`cannot get property "baseDir" without inject`）。所以正确姿势是在 `apply`
 *   里 `ctx.inject(['baseDir'], …)` 解一次、用 `setHostBaseDir()` 交进来（LEV-2）；
 *   这里的反射读取只是兜底，永远置空就回落 `~/.dsh`。
 */
let hostBaseDir = null

/** apply 里 `ctx.inject(['baseDir'], sctx => setHostBaseDir(sctx.baseDir))`；卸载时传 null。 */
export function setHostBaseDir(dir) {
  hostBaseDir = typeof dir === 'string' && dir.trim() ? dir.trim() : null
}

export function baseDirOf(ctx) {
  if (hostBaseDir) return hostBaseDir
  try {
    const base = ctx && ctx.baseDir
    if (typeof base === 'string' && base) return base
  } catch {
    /* 未注入 baseDir：按 V5 的回落根处理 */
  }
  return fallbackHome()
}

/** volatile 字段的值是「活格子」（`{ get() }`，宿主可原地热改），读之前必须解包。 */
export const unwrapValue = (v) => (v && typeof v.get === 'function' ? v.get() : v)

/**
 * 读配置：**唯一来源是插件行配置**（`cordis.patch.yml` 的 config —— 设置页写的就是它），
 * 缺键=默认值；非法=回落默认 + 报 E_CONFIG（会话不阻塞，J3 要求带字段名）。
 *
 * 不再有第二份配置文件：多一个来源就多一条「我改了设置页为什么没生效」。
 * 机器级覆盖只剩 `WAYSTONE_DATA_DIR`，且只影响 dataDir。
 */
const given = (v) => v !== undefined && v !== null && v !== ''

/**
 * 把一个字段并入 config。
 * - volatile 字段到手是 `{ get }` 而不是值，调用方先 `unwrapValue` 再交进来；
 * - 非法值不静默：一律记一条带 `config.<字段名>` 的问题（J3：用户要知道改哪一行）。
 */
function applyConfigField(config, key, raw, problems) {
  if (!given(raw)) return
  const spec = CONFIG_FIELDS[key]
  if (spec.type === 'string') {
    if (typeof raw !== 'string') {
      problems.push('config.' + key + ' 必须是字符串（已忽略）')
      return
    }
    if (raw.trim()) config[key] = raw.trim()
    return
  }
  if (!Number.isInteger(raw) || raw < spec.min || raw > spec.max) {
    problems.push('config.' + key + ' 必须是 ' + spec.min + '..' + spec.max
      + ' 的整数（已忽略，回落默认 ' + spec.fallback + '）')
    return
  }
  config[key] = raw
}

export function readConfig(defaults = {}) {
  const config = { ...CONFIG_DEFAULTS }
  const problems = []
  if (defaults && typeof defaults === 'object') {
    for (const key of Object.keys(CONFIG_FIELDS)) applyConfigField(config, key, unwrapValue(defaults[key]), problems)
  }
  return { config, error: problems.length ? problems.join('；') : null }
}

/** `~` / `~/x` / `~\x` 展开；非字符串按空串（迁移脚本会直接传命令行值）。 */
export function expandHome(p) {
  const s = String(p || '')
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析统一存储根（V5 §2.1 解析顺序），返回根 + 是谁定的 + 错误。
 * 不可写不静默降级：报 E_CONFIG 并回落到默认根，注入块显示 [记忆不可用：E_CONFIG]。
 */
export function resolveDataDir(ctx, config, cwd) {
  const envDir = process.env.WAYSTONE_DATA_DIR
  const defaultDir = path.join(baseDirOf(ctx), 'waystone', 'data')
  const fallbackDir = path.join(fallbackHome(), 'waystone', 'data')

  const candidates = []
  if (envDir && envDir.trim()) candidates.push({ dir: path.resolve(expandHome(envDir.trim())), source: 'env' })
  // volatile 字段是活格子：先解包再判字符串
  const configured = unwrapValue(config && config.dataDir)
  const configuredDir = typeof configured === 'string' ? configured.trim() : ''
  if (configuredDir) candidates.push({ dir: path.resolve(cwd || process.cwd(), expandHome(configuredDir)), source: 'config' })
  candidates.push({ dir: defaultDir, source: 'default' })

  for (const c of candidates) {
    if (writable(c.dir)) return { dataDir: c.dir, source: c.source, error: null }
  }
  // 默认根与回落根都不可写（极端情况）：仍返回路径，让上层报 E_STORE，而不是假装写成功
  return {
    dataDir: fallbackDir,
    source: 'fallback',
    error: 'config.dataDir 不可写：请确认目录存在且可写，或把它清空/改成可写目录',
  }
}

/** 工作区键：<slug>-<hash8>（V5 §2.1 目录命名；仓库搬家 = 新库，不静默合并）。 */
export function workspaceKey(cwd) {
  const abs = path.resolve(cwd || process.cwd())
  // 工作区目录名直接取真实 basename：它本来就来自一个合法存在的目录，中文/日文/韩文在
  // NTFS/APFS/ext4 上都合法。只剥**文件名非法**的字符（Windows 保留字符 + 控制字符）和结尾的点/空格。
  // 以前只保留 [A-Za-z0-9_-]，中文项目名会被整段吃掉（D:\SR\项目\上汽\大众联合招标TBOX → "TBOX"），
  // 查看页的工作区选择器就只剩个 TBOX，认不出是哪个项目。
  let slug = path.basename(abs)
    .replace(/[:*?"<>|\\/\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
  if ([...slug].length > 24) slug = [...slug].slice(0, 24).join('')
  if (!slug) slug = 'ws'
  const hash8 = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 8)
  return slug + '-' + hash8
}

export function scopeDirs(dataDir, cwd) {
  return scopeDirsForKey(dataDir, workspaceKey(cwd))
}

function shardPath(dir, sid) {
  return path.join(dir, 'assertions', String(sid || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl')
}

/** 追加一条记录（append-only）。失败抛 E_STORE，由调用方转成可见错误。 */
export function appendRecord(dir, sid, record) {
  const file = shardPath(dir, sid)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    shardCache.clear()
    return file
  } catch (e) {
    const err = new Error('E_STORE: 写入失败（' + file + '）：' + (e && e.message))
    err.code = 'E_STORE'
    throw err
  }
}

const shardCache = new Map()

function readShard(file, errors = []) {
  let st
  try {
    st = fs.statSync(file)
  } catch (e) {
    if (e && e.code !== 'ENOENT') errors.push('stat ' + path.basename(file) + ': ' + (e.code || e.message))
    return []
  }
  const hit = shardCache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records
  const records = []
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec === 'object' && rec.id) records.push(rec)
      } catch {
        /* 单行坏数据不拖垮整库：跳过，doctor 的 records 计数会少于行数 */
      }
    }
  } catch (e) {
    errors.push('read ' + path.basename(file) + ': ' + (e && e.code ? e.code : e && e.message))
    return []
  }
  shardCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, records })
  return records
}

/**
 * 读时合并一个作用域的全部会话分片。
 *
 * ★ `error` 非空 = **真的读不出来**（EIO/EACCES/EPERM…），与「目录还没有记录」
 *   （ENOENT，正常新建工作区）必须分开：前者若被当成空库，注入的规约段会静默变空，
 *   等于把整条历史的前缀作废，还顺手把 lastGoodRulesText 冲掉。
 */
export function loadScope(dir) {
  const shardDir = path.join(dir, 'assertions')
  const errors = []
  let names = []
  try {
    names = fs.readdirSync(shardDir).filter((n) => n.endsWith('.jsonl'))
  } catch (e) {
    if (e && e.code !== 'ENOENT') errors.push('readdir: ' + (e && e.code ? e.code : e && e.message))
    return { records: [], sessions: 0, shardDir, error: errors.join('; ') }
  }
  const records = []
  for (const n of names) records.push(...readShard(path.join(shardDir, n), errors))
  return { records, sessions: names.length, shardDir, error: errors.join('; ') }
}

/** 递归遍历普通文件；目录读不到就跳过。诊断/统计共用这一份 walk。 */
function walkFiles(dir, visit) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(f, visit)
    else visit(f)
  }
}

/** doctor 用的体积/最后写入时间。 */
export function scopeStats(dir) {
  const out = { sizeBytes: 0, lastWriteAt: null }
  walkFiles(dir, (f) => {
    try {
      const st = fs.statSync(f)
      out.sizeBytes += st.size
      if (!out.lastWriteAt || st.mtimeMs > Date.parse(out.lastWriteAt)) out.lastWriteAt = nowIso(st.mtime)
    } catch {
      /* 单文件不可读不影响统计 */
    }
  })
  return out
}

/** 判官审计（V5 §3.2 落盘审计：输入哈希 + 输出 + 采纳结果，可复算）。 */
export function appendJudgeAudit(dir, sid, entry) {
  const file = path.join(dir, 'judge', String(sid || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* 审计写失败不阻塞会话（失败可见由 doctor 的 judge 计数体现） */
  }
}

/** 锚点校验探针（V5 §9：只读锚点所需的项目文件，不做网络请求）。 */
export function makeProbe() {
  const cache = new Map()
  const linesOf = (p) => {
    const abs = path.resolve(p)
    const hit = cache.get(abs)
    if (hit) return hit
    let lines = null
    try {
      lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    } catch {
      lines = null
    }
    if (cache.size > 200) cache.clear()
    cache.set(abs, lines)
    return lines
  }
  return {
    lineSha256(p, line) {
      const lines = linesOf(p)
      if (!lines || !Number.isInteger(line) || line < 1 || line > lines.length) return undefined
      return crypto.createHash('sha256').update(lines[line - 1]).digest('hex')
    },
  }
}

/** 按工作区键直接定位作用域（Web 查看页/doctor 用，无需 cwd）。 */
export function scopeDirsForKey(dataDir, key) {
  return {
    workspaceKey: key,
    globalDir: path.join(dataDir, 'global', 'v1'),
    workspaceDir: path.join(dataDir, 'ws', key, 'v1'),
  }
}

/** 列出根下所有工作区（查看页的工作区选择器；最近写入的排前面）。 */
export function listWorkspaces(dataDir) {
  const wsRoot = path.join(dataDir, 'ws')
  let names = []
  try {
    names = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out = []
  for (const key of names) {
    const dirs = scopeDirsForKey(dataDir, key)
    const stats = scopeStats(dirs.workspaceDir)
    const scope = loadScope(dirs.workspaceDir)
    out.push({ key, records: scope.records.length, sessions: scope.sessions, lastWriteAt: stats.lastWriteAt, sizeBytes: stats.sizeBytes })
  }
  out.sort((a, b) => String(b.lastWriteAt || '').localeCompare(String(a.lastWriteAt || '')))
  return out
}

/** 目录创建（诊断/审计等旁路用途）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 旁路诊断日志：只追加，失败不外抛。 */
export function appendText(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, text, 'utf8')
  } catch {
    /* 诊断写失败不影响会话 */
  }
}

/**
 * 旧根残留（换数据根后 doctor 告警 / 迁移前核对用）。
 * 候选 = 宿主 baseDir 与 `~/.dsh`（两者都试，去重），排除当前根。
 * 迁移前的数据在 `~/.dsh/waystone/data`：一旦宿主 baseDir 生效，它会作为"旧根"被列出，
 * 这一步就是提示跑 `scripts/migrate-data-root.mjs`。
 */
/**
 * 根目录下所有 `.jsonl` 的行数（= 记录条数）。
 * 两处用：旧根残留计数（doctor / 查看页的「旧数据根」），以及迁移前确认「新根是空库」。
 */
export function recordCountUnder(root) {
  let records = 0
  for (const sub of ['global', 'ws']) {
    const d = path.join(root, sub)
    if (!fs.existsSync(d)) continue
    walkFiles(d, (f) => {
      if (!f.endsWith('.jsonl')) return
      try {
        records += fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length
      } catch {
        /* 忽略 */
      }
    })
  }
  return records
}

export function legacyRoots(ctx, currentDataDir) {
  const candidates = [path.join(baseDirOf(ctx), 'waystone', 'data'), path.join(fallbackHome(), 'waystone', 'data')]
  const seen = new Set([path.resolve(currentDataDir)])
  const roots = []
  for (const c of candidates) {
    const abs = path.resolve(c)
    if (seen.has(abs)) continue
    seen.add(abs)
    roots.push(c)
  }
  const out = []
  for (const root of roots) {
    const records = recordCountUnder(root)
    if (records > 0) out.push({ path: root, records })
  }
  return out
}

/** 会话 id：宿主给不到时用进程启动时间 + 随机 6 hex（仅保证本机唯一）。 */
export function sessionIdOf(agent) {
  const s = agent && agent.session
  const id = (s && (s.id || (s.header && s.header.id))) || (agent && agent.id)
  return id ? String(id) : 's-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
}

/** 会话工作目录：优先 header.cwd，退到进程 cwd。 */
export function cwdOf(agent) {
  const s = agent && agent.session
  const cwd = s && s.header && s.header.cwd
  return typeof cwd === 'string' && cwd ? cwd : process.cwd()
}
