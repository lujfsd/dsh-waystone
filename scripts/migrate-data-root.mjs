#!/usr/bin/env node
/**
 * waystone 数据根迁移（命令行入口，LEV-2）。
 *
 * 实现与查看页「诊断 → 旧数据根」的迁移按钮共用 `lib/migrate.js`：
 * 复制 + 按 `id` 并集（不重算、不覆盖既有行）。默认**只读源**：`--prune` 才删源。
 *
 * 用法：
 *   node scripts/migrate-data-root.mjs --to <新根> [--from <旧根>] [--merge] [--prune] [--dry-run]
 *
 *   旧根默认 ~/.dsh/waystone/data；新根用 `waystone_status` 的 dataDir 抄（别猜）。
 *   --dry-run 只打印计划；--merge 允许目标已有内容时按 id 并集；--prune 校验通过后删源。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/migrate.js'

export { migrate }

function main(argv) {
  const args = { from: path.join(os.homedir(), '.dsh', 'waystone', 'data'), to: '', merge: false, prune: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--from') args.from = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--merge') args.merge = true
    else if (a === '--prune') args.prune = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/migrate-data-root.mjs --to <新根> [--from <旧根>] [--merge] [--prune] [--dry-run]')
      return 0
    } else {
      console.error('未知参数：' + a)
      return 2
    }
  }
  if (!args.to) {
    console.error('缺 --to <新根>：用 `waystone_status` 的 dataDir 抄（默认旧根 ~/.dsh/waystone/data）')
    return 2
  }
  try {
    const s = migrate({ ...args, log: (m) => console.log('  ' + m) })
    console.log('')
    console.log(`源: ${s.src}`)
    console.log(`目标: ${s.dst}`)
    console.log(`文件 ${s.files} 个｜复制 ${s.copied}｜并集 ${s.merged}｜跳过 ${s.skipped}｜共搬运 ${s.lines} 行${s.pruned ? `｜已删源 ${s.pruned} 个` : ''}${s.dryRun ? '（dry-run，未动盘）' : ''}`)
    if (!s.pruned && !s.dryRun) console.log('源保留原样；确认无误后加 --prune 重跑可删源。')
    return 0
  } catch (e) {
    console.error('迁移失败：' + (e && e.message))
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
