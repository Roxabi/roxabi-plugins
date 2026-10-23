#!/usr/bin/env bun
/**
 * Captures only the retained-historical Semctx records. Unlike capture.ts this
 * has no assertledger dependency and never rewrites records.json.
 *
 *   bun plugins/omp-build/skills/feature/__fixtures__/proof/historical.capture.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
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
import { decodeHistory, githubScope, type History } from '../../../../dist/contracts.js'
import { HISTORICAL_CASES, type HistoricalCase, historicalSpec } from './historical'
import { ACQUIRE, type Box, git, readSim, sandbox, worktree } from './sandbox'

const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const OUT = path.join(import.meta.dirname, 'historical.records.json')
type Captured = { code: number | null; stdout: string; stderr: string; data?: unknown }
const CAPTURED_CASES = ['valid', 'partial', 'blocked', 'ownSuperseded', 'borrowedProvenance'] as const
type CapturedCase = (typeof CAPTURED_CASES)[number]
const CAPTURED_REFS = [
  'main',
  'history-partial-base',
  'history-blocked-base',
  'fix/813-valid',
  'fix/813-partial',
  'fix/813-blocked',
  'fix/813-own-superseded',
  HISTORICAL_CASES.borrowedProvenance.base,
  HISTORICAL_CASES.borrowedProvenance.branch,
] as const
type HistoricalCapture = {
  sha: Record<string, string>
  records: Record<CapturedCase, Captured>
  tools: { semctx: string; node: string; git: string }
}

function which(name: string): string {
  const found = Bun.which(name)
  if (!found) throw new Error(`${name} is not on PATH`)
  return realpathSync(found)
}

/** Captures raw native proof data from the confirmed common proof operation. */
function capture(box: Box, name: HistoricalCase): Captured {
  const { pr, branch } = HISTORICAL_CASES[name]
  const candidate = box.sha[branch]
  if (!candidate) throw new Error(`missing ${name} candidate`)
  const root = worktree(box, `historical-${name}`, candidate)
  const before = readSim(box).prs[String(pr)]?.comments.length ?? 0
  const run = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], {
    cwd: root,
    env: box.env,
    encoding: 'utf8',
  })
  const comments = readSim(box).prs[String(pr)]?.comments.slice(before) ?? []
  const history: History = {
    scope: githubScope('acme/app', pr),
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `acme/app#${pr}:fixture:${index}`,
      nativeId: comment.id === undefined ? null : String(comment.id),
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
    diagnostics: [],
  }
  const data = decodeHistory(history).operations.find(
    (operation) => operation.status === 'complete' && operation.record?.kind === 'proof',
  )?.record
  return {
    code: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    ...(data?.kind === 'proof' && { data: data.payload.data }),
  }
}

const tools = mkdtempSync(path.join(tmpdir(), 'omp-historical-tools-'))
const bin = path.join(tools, 'bin')
mkdirSync(bin)
cpSync(path.dirname(path.dirname(which('semctx'))), path.join(tools, 'semctx'), { recursive: true })
symlinkSync(path.join(tools, 'semctx', 'dist', 'index.js'), path.join(bin, 'semctx'))
copyFileSync(which('node'), path.join(bin, 'node'))
chmodSync(path.join(bin, 'node'), 0o755)

let box: Box | undefined
try {
  box = sandbox({ ...historicalSpec(), path: [bin] })
  const sha = box.sha
  const executable = path.join(bin, 'semctx')
  const capturedSha = Object.fromEntries(
    CAPTURED_REFS.map((ref) => {
      const value = sha[ref]
      if (!value) throw new Error(`missing captured ref ${ref}`)
      return [ref, value]
    }),
  )
  const records: HistoricalCapture = {
    sha: capturedSha,
    records: {
      valid: capture(box, 'valid'),
      partial: capture(box, 'partial'),
      blocked: capture(box, 'blocked'),
      ownSuperseded: capture(box, 'ownSuperseded'),
      borrowedProvenance: capture(box, 'borrowedProvenance'),
    },
    tools: {
      semctx: spawnSync(executable, ['--version'], { env: box.env, encoding: 'utf8' }).stdout.trim(),
      node: spawnSync(path.join(bin, 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(),
      git: git(box, box.root, ['--version']),
    },
  }
  for (const [name, captured] of Object.entries(records.records)) {
    if (captured.code !== 0 || captured.data === undefined) {
      throw new Error(`${name} did not publish a successful Semctx record: ${captured.stderr || captured.stdout}`)
    }
  }
  writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`)
} finally {
  if (box) rmSync(box.root, { recursive: true, force: true })
  rmSync(tools, { recursive: true, force: true })
}
