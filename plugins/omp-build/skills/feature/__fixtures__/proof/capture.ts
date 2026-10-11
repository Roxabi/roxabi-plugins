#!/usr/bin/env bun
/**
 * Regenerates `records.json`: runs the real producers through `proof-acquire.ts`
 * against the `sandbox.ts` repositories and keeps each conserved PR comment.
 * Needs `semctx` and `node` on PATH and `ASSERTLEDGER=<path of assertledger's dist/cli.js>`.
 *
 *   ASSERTLEDGER=/path/to/assertledger/dist/cli.js bun capture.ts
 *
 * Semctx's package, assertledger's node_modules and the node binary are copied
 * under a temporary directory first: records carry their real paths, which must
 * name neither the capturing home nor a directory that outlives the capture.
 * Re-run it when a producer's native output changes; the integration test
 * fails while a rebuilt sandbox's shas differ from the recorded ones.
 */
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
  ACQUIRE,
  type Box,
  git,
  IGNORED_CASE,
  ignoredSpec,
  LEDGER_CASES,
  ledgerSpec,
  readSim,
  SEMCTX_CASES,
  sandbox,
  semctxSpec,
  worktree,
} from './sandbox'

const OUT = path.join(import.meta.dirname, 'records.json')
type Captured = { code: number | null; stdout: string; stderr: string; record?: string }

function acquire(box: Box, cwd: string, pr: number, extra: string[] = []): Captured {
  const run = spawnSync(process.execPath, [ACQUIRE, '--pr', String(pr), ...extra], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  const posted = readSim(box)
    .prs[String(pr)]?.comments.filter((comment) => comment.body.startsWith('<!-- omp-build:proof producer='))
    .at(-1)?.body
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, ...(posted !== undefined && { record: posted }) }
}

function which(name: string): string {
  const found = Bun.which(name)
  if (!found) throw new Error(`${name} is not on PATH`)
  return realpathSync(found)
}

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
  records.semctx = { sha: semctx.sha, records: semctxRecords }

  const ignored = sandbox(ignoredSpec({ path: [bin] }))
  roots.push(ignored.root)
  const ignoredWt = worktree(ignored, 'ignored', ignored.sha[IGNORED_CASE.branch] as string)
  records.ignored = { sha: ignored.sha, records: { verified: acquire(ignored, ignoredWt, IGNORED_CASE.pr) } }

  const ledger = sandbox(ledgerSpec({ path: [bin] }))
  roots.push(ledger.root)
  const ledgerRecords: Record<string, Captured & { check?: { code: number | null; stderr: string } }> = {}
  for (const [name, { pr, branch, test }] of Object.entries(LEDGER_CASES)) {
    const sha = ledger.sha[branch] as string
    const wt = worktree(ledger, name, sha)
    const out = `.al/${name}`
    const check = spawnSync(
      'assertledger',
      [
        'check',
        '.',
        '--before',
        ledger.sha.main as string,
        '--after',
        sha,
        '--neutral',
        ledger.sha[`${branch}-neutral`] as string,
        '--neutral-reason',
        'comment-only change on the fixed tree',
        '--test',
        `test/${test}.test.js`,
        '--base-test',
        'test/base.test.js',
        '--out',
        out,
        '--allow-unsafe-execution',
        '--json',
      ],
      { cwd: wt, env: ledger.env, encoding: 'utf8' },
    )
    ledgerRecords[name] = {
      ...acquire(ledger, wt, pr, ['--assertledger-manifest', path.join(wt, out, 'manifest.json')]),
      check: { code: check.status, stderr: check.stderr },
    }
  }
  records.assertledger = { sha: ledger.sha, records: ledgerRecords }
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
  console.log(JSON.stringify(records, (key, value) => (key === 'record' ? `${String(value).length} chars` : value), 2))
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
