#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  acquire,
  type Captured,
  type Detected,
  detect,
  modifiedNative,
  replayCounterparts,
  which,
} from './capture-native'
import { LEDGER_CASES, ledgerSpec } from './sandbox-assertledger'
import { BOTH_CASE, bothSpec } from './sandbox-both'
import { git, sandbox, worktree } from './sandbox-repository'
import { SEMCTX_CASES, semctxSpec } from './sandbox-semctx-spec'

const OUT = path.join(import.meta.dirname, 'records.json')

const assertledger = process.env.ASSERTLEDGER
if (!assertledger) throw new Error('ASSERTLEDGER=<path of assertledger dist/cli.js> is required')
const tools = mkdtempSync(path.join(tmpdir(), 'omp-proof-tools-'))
const bin = path.join(tools, 'bin')
mkdirSync(bin)
// semctx's dist/index.js is a self-contained bundle: its package directory is two levels up.
cpSync(path.dirname(path.dirname(which('semctx'))), path.join(tools, 'semctx'), { recursive: true })
symlinkSync(path.join(tools, 'semctx', 'dist', 'index.js'), path.join(bin, 'semctx'))
copyFileSync(which('node'), path.join(bin, 'node'))
chmodSync(path.join(bin, 'node'), 0o755)
// assertledger's dist/cli.js resolves its dependencies from the node_modules three levels up.
const modules = path.join(tools, 'assertledger', 'node_modules')
cpSync(path.dirname(path.dirname(path.dirname(realpathSync(assertledger)))), modules, { recursive: true })
symlinkSync(path.join(modules, 'assertledger', 'dist', 'cli.js'), path.join(bin, 'assertledger'))

const records: Record<string, unknown> = {}
const roots: string[] = [tools]
try {
  const semctx = sandbox(semctxSpec({ path: [bin] }))
  roots.push(semctx.root)
  const semctxRecords: Record<string, Captured> = {}
  for (const [name, { pr, branch }] of Object.entries(SEMCTX_CASES)) {
    const sha = semctx.sha[branch] as string
    semctxRecords[name] = acquire(semctx, worktree(semctx, name, sha), pr)
  }
  semctxRecords.modifiedNative = await modifiedNative(semctx)
  records.semctx = { sha: semctx.sha, records: semctxRecords }

  const ledger = sandbox(ledgerSpec({ path: [bin] }))
  roots.push(ledger.root)
  const ledgerRecords: Record<string, Detected> = {}
  for (const [name, spec] of Object.entries(LEDGER_CASES)) ledgerRecords[name] = detect(ledger, name, spec)
  if (!ledgerRecords.detection) throw new Error('no native detection capture')
  records.assertledger = {
    sha: ledger.sha,
    records: ledgerRecords,
    replays: replayCounterparts(ledger, ledgerRecords.detection),
  }

  const both = sandbox(bothSpec({ path: [bin] }))
  roots.push(both.root)
  records.both = { sha: both.sha, records: { both: detect(both, 'both', BOTH_CASE) } }
  records.tools = {
    semctx: spawnSync(path.join(bin, 'semctx'), ['--version'], { encoding: 'utf8' }).stdout.trim(),
    assertledger: spawnSync(path.join(bin, 'assertledger'), ['--version'], {
      env: ledger.env,
      encoding: 'utf8',
    }).stdout.trim(),
    node: spawnSync(path.join(bin, 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(),
    git: git(semctx, semctx.root, ['--version']),
  }
  writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`)
  console.log(JSON.stringify(records, (key, value) => (key === 'data' ? '<retained native proof data>' : value), 2))
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
