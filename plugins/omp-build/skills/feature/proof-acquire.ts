#!/usr/bin/env bun
/**
 * Producer run for the landing admission (#768) — the normal verification
 * workflow, never admission. Run in the checkout of the PR head after it is
 * pushed:
 *
 *   bun proof-acquire.ts --pr <N> [--assertledger-manifest <manifest.json>]
 *
 * For each applicable producer it first re-reads the latest record the
 * automation login conserved on the PR for the current head; one that still
 * binds is reused and no producer runs. Otherwise:
 *
 * - Semctx: a private `--shared` clone of the repository is checked out at the
 *   candidate, then `index`, `status`, `semantic check`, `change inspect` and
 *   `change verify --base <merge-base> --head <candidate>` for each change
 *   contract the PR changes, then `status` again. The clone must stay clean.
 *   Semctx runs under the configuration `candidateFacts` decides: the committed
 *   one, else the operator's uncommitted `.semctx/config.json`, copied into the
 *   clone (where the candidate's `.gitignore` must ignore it). The record binds
 *   that configuration's source and sha256.
 * - assertledger: the operator's manifest is replayed (`assertledger replay`).
 *
 * The result is posted as one PR comment per producer, or a run of parts above GitHub's ceiling (`renderRecord`), with the
 * invocation facts and the native output as printed. A run that breaks the
 * protocol — an unexpected exit, an unclean clone, a result that does not bind
 * to the candidate — posts nothing and exits 1. Producer verdicts (PARTIAL,
 * BLOCKED, WEAK_ORACLE, a miss) are posted as they are: admission refuses them.
 *
 * stdout: one JSON line `{ pr, candidate, semctx, assertledger }`, each
 * `not-applicable` | `reused` | `posted`. Exit 0 when every applicable producer
 * has a record for the candidate; 1 on a protocol failure or a missing input;
 * 2 on usage.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type AssertledgerRecord,
  assertledgerApplies,
  type CandidateFacts,
  type ChangeResult,
  candidateFacts,
  findRecord,
  type Gh,
  isMap,
  type PrComment,
  type Refusal,
  readAssertledgerRecord,
  readSemctxRecord,
  refreshSelectedBase,
  renderRecord,
  repositoryOf,
  type SemctxExpected,
  type SemctxRecord,
  type Step,
  semctxInputs,
  semctxSteps,
  stepExitAllowed,
} from './proof'
import { gitResult, readComments } from './workflow.js'

class ProtocolError extends Error {}

type Outcome = 'not-applicable' | 'reused' | 'posted'
type Context = {
  cwd: string
  pr: number
  candidate: string
  base: string
  baseTip: string
  repository: string
  me: string
  comments: PrComment[]
  facts: CandidateFacts
}

async function run(
  argv: string[],
  options: { cwd?: string; input?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined ? 'ignore' : new Blob([options.input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stdout, stderr }
}

const gh: Gh = async (cwd, args) => {
  const result = await run(['gh', ...args], { cwd })
  if (result.code !== 0)
    throw new Error(`gh ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/** The environment a producer runs in: no git redirection from a calling hook. */
function producerEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

function refusalText(refusal: Refusal): string {
  return `${refusal.producer} ${refusal.reason}: ${refusal.error}`
}

/** No reuse, absence report or publication switches the attempt's native coordinates. */
async function assertCurrent(ctx: Context): Promise<void> {
  const current: unknown = JSON.parse(
    await gh(ctx.cwd, ['pr', 'view', String(ctx.pr), '--json', 'headRefOid,baseRefName,baseRefOid,state']),
  )
  if (
    !isMap(current) ||
    current.state !== 'OPEN' ||
    current.headRefOid !== ctx.candidate ||
    current.baseRefName !== ctx.base ||
    current.baseRefOid !== ctx.baseTip
  ) {
    throw new ProtocolError(
      `PR #${ctx.pr} coordinates changed during acquisition; re-enter with the current head and base`,
    )
  }
}

/** One comment per part, in order: a part that fails leaves the run incomplete, which reads as missing. */
async function post(ctx: Context, parts: string[]): Promise<void> {
  for (const body of parts) {
    await assertCurrent(ctx)
    const args = ['pr', 'comment', String(ctx.pr), '--body-file', '-']
    const result = await run(['gh', ...args], { cwd: ctx.cwd, input: body })
    if (result.code !== 0)
      throw new Error(`gh ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`)
    await assertCurrent(ctx)
  }
}

async function tool(name: string, local: string | null): Promise<{ path: string; version: string }> {
  const found = local ?? Bun.which(name)
  if (!found) throw new ProtocolError(`${name} is not installed: no ${name} on PATH`)
  const path = realpathSync(found)
  const version = await run([path, '--version'], { env: producerEnv() })
  if (version.code !== 0)
    throw new ProtocolError(`${path} --version failed (${version.code}): ${version.stderr.trim()}`)
  return { path, version: version.stdout.trim() }
}

function semctxSummary(results: ChangeResult[] | Refusal): string[] {
  if ('ok' in results) return [`- Admission would refuse: ${refusalText(results)}`]
  return results.map(
    (result) =>
      `- \`${result.id}\` — **${result.verdict}**${result.gaps.length ? ` (gaps: ${result.gaps.map((gap) => `\`${gap}\``).join(', ')})` : ''}`,
  )
}

/** A refusal saying the record does not bind or cannot be read — never a producer verdict. */
function isUnbound(outcome: unknown): outcome is Refusal {
  return isMap(outcome) && outcome.ok === false && (outcome.reason === 'unbound' || outcome.reason === 'unreadable')
}

async function acquireSemctx(ctx: Context): Promise<Outcome> {
  const inputs = await semctxInputs(ctx.facts, gitResult)
  if ('ok' in inputs) throw new ProtocolError(refusalText(inputs))
  const expected: SemctxExpected = {
    repository: ctx.repository,
    pr: ctx.pr,
    candidate: ctx.candidate,
    ...inputs,
    changeFiles: ctx.facts.changeFiles,
  }
  const found = findRecord(ctx.comments, ctx.me, 'semctx', ctx.candidate)
  if ('record' in found && !isUnbound(readSemctxRecord(found.record, expected))) return 'reused'
  const semctx = await tool('semctx', null)
  const work = mkdtempSync(join(tmpdir(), 'omp-proof-'))
  try {
    const root = join(work, 'repo')
    for (const [cwd, args] of [
      [work, ['clone', '-q', '--shared', '--no-checkout', '--', ctx.facts.toplevel, root]],
      [root, ['checkout', '-q', '--detach', ctx.candidate]],
    ] as const) {
      const result = await gitResult(cwd, [...args])
      if (result.code !== 0)
        throw new ProtocolError(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
    }
    const config = ctx.facts.config
    if (config?.source === 'ignored') {
      mkdirSync(join(root, '.semctx'), { recursive: true })
      writeFileSync(join(root, '.semctx', 'config.json'), config.text)
    }
    const statusArgs = ['status', '--porcelain', '-z', '--untracked-files=all']
    const before = await gitResult(root, statusArgs)
    if (before.code !== 0 || before.stdout)
      throw new ProtocolError(`the private checkout is not clean before the run: ${before.stderr || before.stdout}`)
    const native: Step[] = []
    for (const argv of semctxSteps(root, inputs.contracts, inputs.mergeBase, ctx.candidate)) {
      const result = await run([semctx.path, ...argv], { cwd: work, env: producerEnv() })
      if (!stepExitAllowed(argv).includes(result.code)) {
        throw new ProtocolError(
          `semctx ${argv.slice(2).join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
        )
      }
      native.push({ argv, exit: result.code, stdout: result.stdout })
    }
    const after = await gitResult(root, statusArgs)
    if (after.code !== 0) throw new ProtocolError(`git status failed after the run: ${after.stderr.trim()}`)
    const ignoredRun = await gitResult(root, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all'])
    if (ignoredRun.code !== 0) throw new ProtocolError(`git status --ignored failed: ${ignoredRun.stderr.trim()}`)
    const ignored = ignoredRun.stdout
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .map((entry) => entry.slice(3))
    const record: SemctxRecord = {
      producer: 'semctx',
      invocation: {
        repository: ctx.repository,
        pr: ctx.pr,
        candidate: ctx.candidate,
        base: ctx.base,
        mergeBase: inputs.mergeBase,
        contracts: inputs.contracts,
        root,
        config: inputs.config,
        tool: semctx,
        status: { before: before.stdout, after: after.stdout },
        ignored,
      },
      native,
    }
    const read = readSemctxRecord(record, expected)
    if (isUnbound(read)) throw new ProtocolError(`the run does not bind to the candidate — ${refusalText(read)}`)
    await post(ctx, renderRecord('semctx', ctx.candidate, semctxSummary(read), record))
    return 'posted'
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function acquireAssertledger(ctx: Context, manifestPath: string | undefined): Promise<Outcome> {
  const treeArgs = ['rev-parse', `${ctx.candidate}^{tree}`]
  const treeRun = await gitResult(ctx.facts.toplevel, treeArgs)
  if (treeRun.code !== 0) throw new ProtocolError(`git ${treeArgs.join(' ')} failed: ${treeRun.stderr.trim()}`)
  const expected = { repository: ctx.repository, pr: ctx.pr, candidate: ctx.candidate, tree: treeRun.stdout.trim() }
  const found = findRecord(ctx.comments, ctx.me, 'assertledger', ctx.candidate)
  if (manifestPath === undefined) {
    if ('record' in found && !isUnbound(readAssertledgerRecord(found.record, expected))) return 'reused'
    throw new ProtocolError(
      `assertledger applies to PR #${ctx.pr} (fix ticket with an adapter) and no record binds ${ctx.candidate}: run \`assertledger check . --after ${ctx.candidate} …\` and pass its manifest with --assertledger-manifest`,
    )
  }
  const path = resolve(manifestPath)
  const manifest = readFileSync(path, 'utf8')
  const local = join(ctx.facts.toplevel, 'node_modules', '.bin', 'assertledger')
  const assertledger = await tool('assertledger', existsSync(local) ? local : null)
  const argv = ['replay', path, '--json']
  const replay = await run([assertledger.path, ...argv], { cwd: ctx.facts.toplevel, env: producerEnv() })
  const record: AssertledgerRecord = {
    producer: 'assertledger',
    invocation: {
      repository: ctx.repository,
      pr: ctx.pr,
      candidate: ctx.candidate,
      manifest: path,
      tool: assertledger,
    },
    native: { manifest, replay: { argv, exit: replay.code, stdout: replay.stdout } },
  }
  const read = readAssertledgerRecord(record, expected)
  if (isUnbound(read)) throw new ProtocolError(`the manifest does not bind to the candidate — ${refusalText(read)}`)
  const summary = read === 'detection' ? ['- **detection**'] : [`- Admission would refuse: ${refusalText(read)}`]
  await post(ctx, renderRecord('assertledger', ctx.candidate, summary, record))
  return 'posted'
}

function parseArgs(argv: string[]): { pr: number; manifest?: string } | null {
  let pr: number | undefined
  let manifest: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) return null
    if (flag === '--pr' && /^[1-9]\d*$/.test(value)) pr = Number(value)
    else if (flag === '--assertledger-manifest' && value) manifest = value
    else return null
    i++
  }
  return pr === undefined ? null : { pr, manifest }
}

export async function main(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs(argv)
  if (!args) {
    console.error('usage: bun proof-acquire.ts --pr <N> [--assertledger-manifest <manifest.json>]')
    return 2
  }
  try {
    const view: unknown = JSON.parse(
      await gh(cwd, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid,state']),
    )
    const candidate = isMap(view) ? view.headRefOid : undefined
    const base = isMap(view) ? view.baseRefName : undefined
    const baseTip = isMap(view) ? view.baseRefOid : undefined
    const state = isMap(view) ? view.state : undefined
    if (typeof candidate !== 'string' || typeof base !== 'string' || typeof baseTip !== 'string' || state !== 'OPEN') {
      throw new ProtocolError(`PR #${args.pr} is not an open PR with a head and a base`)
    }
    const refused = await refreshSelectedBase(cwd, base, baseTip, gitResult)
    if (refused) throw new ProtocolError(refusalText(refused))
    const facts = await candidateFacts(cwd, candidate, base, baseTip, gitResult)
    if ('ok' in facts) throw new ProtocolError(refusalText(facts))
    const repository = await repositoryOf(gh, cwd)
    const ledger = await assertledgerApplies(cwd, facts, { pr: args.pr }, { gh, git: gitResult }, repository)
    if (typeof ledger === 'object') throw new ProtocolError(refusalText(ledger))
    const { me, comments } = await readComments(cwd, args.pr, { gh })
    const ctx: Context = { cwd, pr: args.pr, candidate, base, baseTip, repository, me, comments, facts }
    await assertCurrent(ctx)
    const report: Record<string, unknown> = {
      pr: args.pr,
      candidate,
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    }
    if (facts.semctx === 'configured') report.semctx = await acquireSemctx(ctx)
    if (ledger) report.assertledger = await acquireAssertledger(ctx, args.manifest)
    else if (args.manifest !== undefined)
      console.error(`assertledger does not apply to PR #${args.pr}: the manifest was not posted`)
    await assertCurrent(ctx)
    console.log(JSON.stringify(report))
    return 0
  } catch (error) {
    console.error(`proof-acquire: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd()))
