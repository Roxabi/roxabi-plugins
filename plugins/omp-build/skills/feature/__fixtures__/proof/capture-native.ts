#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeHistory, githubScope, type History } from '../../../../dist/contracts.js'
import type { Git } from '../../proof-base'
import { candidateFacts, refreshSelectedBase } from '../../proof-candidate'
import { changedContracts, mergeBaseOf, type SemctxRecord, semctxSteps } from '../../proof-semctx-protocol'
import { readSemctxRecord } from '../../proof-semctx-validation'
import { ACQUIRE, git, readSim, worktree } from './sandbox-repository'
import { SEMCTX_CASES } from './sandbox-semctx-spec'
import type { Box } from './sandbox-types'
/** Raw native proof data is retained independently from common-codec comment framing. */
export type Captured = { code: number | null; stdout: string; stderr: string; data?: unknown | unknown[] }

export function acquire(box: Box, cwd: string, pr: number, extra: string[] = []): Captured {
  const before = readSim(box).prs[String(pr)]?.comments.length ?? 0
  const run = spawnSync(process.execPath, [ACQUIRE, '--pr', String(pr), ...extra], {
    cwd,
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
  const data = decodeHistory(history)
    .operations.filter((operation) => operation.status === 'complete' && operation.record?.kind === 'proof')
    .map((operation) => (operation.record?.kind === 'proof' ? operation.record.payload.data : null))
    .filter((record): record is NonNullable<typeof record> => record !== null)
  return {
    code: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    ...(data.length > 0 && { data: data.length === 1 ? data[0] : data }),
  }
}

/**
 * A negative fixture from the public native steps, not proof-acquire: Semctx
 * really verifies the older contract the candidate only modifies, but that
 * VERIFIED result must never stand in for this ticket's own added contract.
 * Keep its genuine record to prove admission refuses it, not just missing data.
 */
export async function modifiedNative(box: Box): Promise<Captured> {
  const { pr, branch, base } = SEMCTX_CASES.modified
  const candidate = box.sha[branch] as string
  const root = worktree(box, 'modified-native', candidate)
  const runner: Git = async (cwd, args) => {
    const out = spawnSync('git', args, { cwd, env: box.env, encoding: 'utf8' })
    return { code: out.status ?? 1, stdout: out.stdout, stderr: out.stderr }
  }
  const selected = await refreshSelectedBase(root, base, runner, async (cwd, args) => {
    const out = spawnSync('gh', args, { cwd, env: box.env, encoding: 'utf8' })
    if (out.status !== 0) throw new Error(out.stderr)
    return out.stdout
  })
  if (!selected.ok) throw new Error(selected.error)
  const baseTip = selected.tip
  const facts = await candidateFacts(root, candidate, base, baseTip, runner)
  if ('ok' in facts || !facts.config) throw new Error('the native modified-contract fixture is not configured')
  const mergeBase = await mergeBaseOf(runner, root, baseTip, candidate)
  if (mergeBase instanceof Error) throw mergeBase
  const changed = await changedContracts(runner, root, mergeBase, candidate)
  if (changed instanceof Error) throw changed
  const contracts = changed.map((entry) => entry.path)
  const config = { source: facts.config.source, sha256: facts.config.sha256 }
  const executable = realpathSync(Bun.which('semctx', { PATH: box.env.PATH }) ?? which('semctx'))
  const version = spawnSync(executable, ['--version'], { env: box.env, encoding: 'utf8' })
  if (version.status !== 0) throw new Error(version.stderr)
  const statusArgs = ['status', '--porcelain', '-z', '--untracked-files=all']
  const before = git(box, root, statusArgs)
  const native = []
  for (const argv of semctxSteps(root, contracts, mergeBase, candidate)) {
    const run = spawnSync(executable, argv, { cwd: root, env: box.env, encoding: 'utf8' })
    if (run.status !== 0) throw new Error(run.stderr || run.stdout)
    native.push({ argv, exit: run.status, stdout: run.stdout })
  }
  const after = git(box, root, statusArgs)
  const ignored = git(box, root, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all'])
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
  const record: SemctxRecord = {
    producer: 'semctx',
    invocation: {
      repository: 'acme/app',
      pr,
      candidate,
      base,
      mergeBase,
      contracts,
      root,
      config,
      tool: { path: executable, version: version.stdout.trim() },
      status: { before, after },
      ignored,
    },
    native,
  }
  const results = readSemctxRecord(record, {
    repository: 'acme/app',
    pr,
    candidate,
    base,
    mergeBase,
    contracts,
    config,
    changeFiles: facts.changeFiles,
    historicalContracts: new Map(),
  })
  if ('ok' in results || results.some((result) => result.verdict !== 'VERIFIED'))
    throw new Error(`the older contract is not natively VERIFIED: ${JSON.stringify(results)}`)
  return {
    code: native.at(-1)?.exit ?? null,
    stdout: JSON.stringify(results),
    stderr: '',
    data: record,
  }
}

export type Detected = Captured & { check: { code: number | null; stderr: string } }

/**
 * The operator's `assertledger check` of a candidate against its buggy world (the
 * `-buggy` branch when the sandbox has one, else `main`) and its `-neutral`
 * branch, then the acquisition that replays the manifest and posts every record
 * that applies.
 */
export function detect(
  box: Box,
  name: string,
  { pr, branch, test }: { pr: number; branch: string; test: string },
): Detected {
  const sha = box.sha[branch] as string
  const wt = worktree(box, name, sha)
  const out = `.al/${name}`
  const check = spawnSync(
    'assertledger',
    [
      'check',
      '.',
      '--before',
      box.sha[`${branch}-buggy`] ?? (box.sha.main as string),
      '--after',
      sha,
      '--neutral',
      box.sha[`${branch}-neutral`] as string,
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
    { cwd: wt, env: box.env, encoding: 'utf8' },
  )
  return {
    ...acquire(box, wt, pr, ['--assertledger-manifest', path.join(wt, out, 'manifest.json')]),
    check: { code: check.status, stderr: check.stderr },
  }
}

/** Native counterparts: duration changes the artifact digest, not the decision digest. */
function assertledgerManifest(capture: Captured): string {
  const values = Array.isArray(capture.data) ? capture.data : [capture.data]
  for (const value of values) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('producer' in value) ||
      value.producer !== 'assertledger' ||
      !('native' in value) ||
      value.native === null ||
      typeof value.native !== 'object' ||
      Array.isArray(value.native) ||
      !('manifest' in value.native) ||
      typeof value.native.manifest !== 'string'
    )
      continue
    return value.native.manifest
  }
  throw new Error('the native detection record is unavailable')
}

/** Native counterparts: duration changes the artifact digest, not the decision digest. */
export function replayCounterparts(box: Box, detection: Captured) {
  const valid = assertledgerManifest(detection)
  const match = valid.match(/"durationMs"\s*:\s*(\d+),/)
  if (!match?.[1]) throw new Error('the native manifest has no duration observation')
  const from = match[0]
  const duration = Number(match[1])
  const to = from.replace(match[1], String(duration === 0 ? 1 : duration - 1))
  const capture = (args: string[]): Captured => {
    const result = spawnSync('assertledger', args, { cwd: box.root, env: box.env, encoding: 'utf8' })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  const replay = (name: string, bytes: string) => {
    const file = path.join(box.root, `${name}.json`)
    writeFileSync(file, bytes)
    return capture(['replay', file, '--json'])
  }
  return {
    token: { from, to },
    version: capture(['--version']),
    invalid: replay('invalid-artifact', valid.replace(from, to)),
    valid: replay('valid-artifact', valid),
  }
}

export function which(name: string): string {
  const found = Bun.which(name)
  if (!found) throw new Error(`${name} is not on PATH`)
  return realpathSync(found)
}
