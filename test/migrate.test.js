/**
 * 数据根迁移脚本的自检：复制、并集去重、--merge 守卫、--prune 删源。
 * 只碰 mkdtemp 出来的临时根，不接近真实数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate } from '../scripts/migrate-data-root.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'waystone-migrate-'))
const rec = (id, body = 'x') => JSON.stringify({ v: 1, id, ts: '2026-11-04T10:00:00Z', sid: 's-1', kind: 'fact', scope: 'workspace', body })

/** 造一个旧根：ws/<key>/v1/assertions/<sid>.jsonl */
function seed(root, lines) {
  const dir = path.join(root, 'ws', 'demo-1234abcd', 'v1', 'assertions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 's-1.jsonl'), lines.join('\n') + '\n', 'utf8')
  return path.join(dir, 's-1.jsonl')
}

test('迁移：空目标=复制 + 校验通过；源保留', () => {
  const from = tmp()
  const to = tmp()
  const srcFile = seed(from, [rec('as_1'), rec('as_2')])
  const s = migrate({ from, to })
  assert.equal(s.copied, 1)
  assert.equal(s.lines, 2)
  const dstFile = path.join(to, 'ws', 'demo-1234abcd', 'v1', 'assertions', 's-1.jsonl')
  assert.equal(fs.readFileSync(dstFile, 'utf8'), fs.readFileSync(srcFile, 'utf8'))
  assert.ok(fs.existsSync(srcFile), '默认不删源')
})

test('迁移：目标已有部分行 + --merge 按 id 去重，只补缺的', () => {
  const from = tmp()
  const to = tmp()
  seed(from, [rec('as_1'), rec('as_2'), rec('as_3')])
  seed(to, [rec('as_2'), rec('as_9')])
  const s = migrate({ from, to, merge: true })
  assert.equal(s.merged, 1)
  assert.equal(s.lines, 2, '只搬 as_1 / as_3')
  const dstFile = path.join(to, 'ws', 'demo-1234abcd', 'v1', 'assertions', 's-1.jsonl')
  const ids = fs.readFileSync(dstFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id)
  assert.deepEqual(ids.sort(), ['as_1', 'as_2', 'as_3', 'as_9'])
})

test('迁移：目标有新增行却没给 --merge → 响亮失败且不写盘', () => {
  const from = tmp()
  const to = tmp()
  seed(from, [rec('as_1')])
  const dstFile = seed(to, [rec('as_9')])
  const before = fs.readFileSync(dstFile, 'utf8')
  assert.throws(() => migrate({ from, to }), /--merge/)
  assert.equal(fs.readFileSync(dstFile, 'utf8'), before)
})

test('迁移：--dry-run 不动盘；--prune 校验后删源', () => {
  const from = tmp()
  const to = tmp()
  const srcFile = seed(from, [rec('as_1')])
  const dry = migrate({ from, to, dryRun: true })
  assert.equal(dry.copied, 1)
  assert.ok(!fs.existsSync(path.join(to, 'ws')), 'dry-run 不建目标')

  const s = migrate({ from, to, prune: true })
  assert.equal(s.copied, 1)
  assert.ok(!fs.existsSync(srcFile), 'prune 后源文件删掉')
  assert.ok(fs.existsSync(path.join(to, 'ws', 'demo-1234abcd', 'v1', 'assertions', 's-1.jsonl')))
})

test('迁移：源与目标同一个根时不动', () => {
  const root = tmp()
  seed(root, [rec('as_1')])
  const s = migrate({ from: root, to: root })
  assert.equal(s.files, 0)
})
