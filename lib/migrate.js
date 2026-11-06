/**
 * 数据根迁移：复制 + 按 `id` 并集 + 逐行校验（可选删源）。
 *
 * 背景：宿主 `baseDir` 生效后默认根从 `~/.dsh/waystone/data` 变成 `<baseDir>/waystone/data`。
 * 数据是 append-only JSONL、按会话分片，所以迁移 = 复制（不重算、不覆盖既有行）。
 *
 * 两个入口共用这一份实现：
 *   - `scripts/migrate-data-root.mjs`（命令行，全功能：--merge / --prune / --dry-run）
 *   - 查看页「诊断 → 旧数据根」的迁移按钮（POST /api/waystone/migrate，只允许
 *     「新根为空 + 源是本插件列出的旧根」，不合并、不删源）
 */
import fs from 'node:fs'
import path from 'node:path'
import { expandHome } from './store.js'

const linesOf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
}

/** 并集去重键：记录用 `id`（唯一）；没有 id 的行按整行比较。 */
export const migrationKeyOf = (line) => {
  try {
    const j = JSON.parse(line)
    if (j && typeof j.id === 'string' && j.id) return 'id:' + j.id
  } catch {
    /* 非 JSON 行按原文比 */
  }
  return 'ln:' + line
}

/** 源根下所有 .jsonl 的相对路径。 */
export function jsonlUnder(root) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name.endsWith('.jsonl')) out.push(path.relative(root, abs))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 执行迁移。
 * @param {object} opts
 * @param {string} opts.from 旧根
 * @param {string} opts.to 新根
 * @param {boolean} [opts.merge] 目标已有内容时按 id 并集
 * @param {boolean} [opts.prune] 校验通过后删源
 * @param {boolean} [opts.dryRun] 只算不动盘
 * @param {(msg:string)=>void} [opts.log]
 */
export function migrate({ from, to, merge = false, prune = false, dryRun = false, log = () => {} } = {}) {
  const src = path.resolve(expandHome(from))
  const dst = path.resolve(expandHome(to))
  const summary = { src, dst, files: 0, copied: 0, merged: 0, skipped: 0, lines: 0, pruned: 0, dryRun }
  if (!dst) throw new Error('必须给目标根')
  if (src === dst) {
    log('源与目标是同一个根，无需迁移：' + src)
    return summary
  }
  if (!fs.existsSync(src)) throw new Error('源根不存在：' + src)

  const files = jsonlUnder(src)
  summary.files = files.length
  for (const rel of files) {
    const s = path.join(src, rel)
    const d = path.join(dst, rel)
    const srcLines = linesOf(s)
    if (!fs.existsSync(d)) {
      summary.copied += 1
      summary.lines += srcLines.length
      log(`复制 ${rel}（${srcLines.length} 行）`)
      if (!dryRun) {
        fs.mkdirSync(path.dirname(d), { recursive: true })
        fs.copyFileSync(s, d)
      }
      continue
    }
    const dstLines = linesOf(d)
    const seen = new Set(dstLines.map(migrationKeyOf))
    const add = srcLines.filter((l) => !seen.has(migrationKeyOf(l)))
    if (add.length === 0) {
      summary.skipped += 1
      log(`跳过 ${rel}（目标已含全部 ${srcLines.length} 行）`)
      continue
    }
    if (!merge) {
      throw new Error(`目标已存在且会新增 ${add.length} 行：${d}\n  确认要并集就加 --merge（按 id 去重，源在前）`)
    }
    summary.merged += 1
    summary.lines += add.length
    log(`并集 ${rel}（新增 ${add.length} 行 / 目标原有 ${dstLines.length} 行）`)
    if (!dryRun) {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.writeFileSync(d, [...add, ...dstLines].join('\n') + '\n', 'utf8')
    }
  }

  if (!dryRun) {
    // 校验：源里每一行的键都得在目标里找到，缺一行就不许删源
    for (const rel of files) {
      const have = new Set(linesOf(path.join(dst, rel)).map(migrationKeyOf))
      const missing = linesOf(path.join(src, rel)).filter((l) => !have.has(migrationKeyOf(l)))
      if (missing.length) throw new Error(`校验失败：${rel} 有 ${missing.length} 行没进目标，已中止（源未删）`)
    }
    if (prune) {
      for (const rel of files) fs.rmSync(path.join(src, rel), { force: true })
      // 自底向上删空目录，最后连源根一起删（非空就留着，别误删别人的文件）
      const dirs = new Set()
      for (const rel of files) {
        let d = path.dirname(path.join(src, rel))
        while (d.startsWith(src)) {
          dirs.add(d)
          if (d === src) break
          d = path.dirname(d)
        }
      }
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
        try {
          if (fs.readdirSync(d).length === 0) fs.rmdirSync(d)
        } catch {
          /* 目录里还有别的东西就留着 */
        }
      }
      summary.pruned = files.length
      log(`已删除源文件 ${files.length} 个（配置 errors.log 等非 .jsonl 残留不在迁移范围，需自己确认）`)
    }
  }
  return summary
}
