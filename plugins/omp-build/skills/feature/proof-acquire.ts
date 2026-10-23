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
 *   contract the PR changes, then `status` again. The candidate's committed
 *   Semctx configuration is the only portable configuration; required Semctx
 *   state without it refuses before acquisition. The record retains its
 *   committed configuration identity and the clone's ignored-path observation.
 * - assertledger: the operator's manifest is replayed (`assertledger replay`).
 *
 * The result is published as a confirmed common proof record. The shared codec
 * owns ordered multipart publication above GitHub's ceiling and read-back
 * reconciliation. A run that breaks the protocol — an unexpected exit, an
 * unclean clone, a result that does not bind to the candidate, or an uncertain
 * publication — posts no successful result and exits 1. Native verdicts remain
 * native data. BLOCKED/STALE, WEAK_ORACLE and a miss refuse admission; a
 * meaningful PARTIAL can admit with policy/form/chronology checks and
 * review-judged gaps, never as VERIFIED or independent observation/reason-truth certification.
 *
 * stdout: one JSON line `{ pr, candidate, semctx, assertledger }`, each
 * `not-applicable` | `reused` | `posted`. Exit 0 when every applicable producer
 * has a record for the candidate; 1 on a protocol failure or a missing input;
 * 2 on usage.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type DecodedHistory,
  decodeHistory,
  githubScope,
  publishGitHubRecord,
  readGitHubHistory,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import {
  type AssertledgerRecord,
  assertledgerApplies,
  type CandidateFacts,
  type ChangeResult,
  candidateFacts,
  compareApplicableProofPins,
  findProofRecord,
  type Gh,
  isMap,
  newProofRecord,
  type Producer,
  pinsFromApplicableMandate,
  type Refusal,
  readAssertledgerRecord,
  readSemctxRecord,
  recordIntegrity,
  refreshSelectedBase,
  repositoryOf,
  type SemctxExpected,
  type SemctxRecord,
  type Step,
  semctxInputs,
  semctxSteps,
  stepExitAllowed,
} from './proof'
import { gitResult } from './workflow.js'

class ProtocolError extends Error {}

type Outcome = 'not-applicable' | 'reused' | 'posted'
type SemctxAcquisition = { outcome: 'reused' | 'posted'; assessment: ChangeResult[] | Refusal }
type Context = {
  cwd: string
  pr: number
  candidate: string
  base: string
  baseTip: string
  repository: string
  history: DecodedHistory
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

/**
 * No reuse, absence report or publication switches the attempt's native coordinates:
 * the head, base name and OPEN state GitHub reports, and the base tip a fresh fetch
 * reads (`baseRefOid` does not follow the branch).
 */
async function assertCurrent(ctx: Context): Promise<void> {
  const current: unknown = JSON.parse(
    await gh(ctx.cwd, ['pr', 'view', String(ctx.pr), '--json', 'headRefOid,baseRefName,state']),
  )
  const changed = `PR #${ctx.pr} coordinates changed during acquisition; re-enter with the current head and base`
  if (
    !isMap(current) ||
    current.state !== 'OPEN' ||
    current.headRefOid !== ctx.candidate ||
    current.baseRefName !== ctx.base
  ) {
    throw new ProtocolError(changed)
  }
  const fetched = await refreshSelectedBase(ctx.cwd, ctx.base, gitResult, gh)
  if (!fetched.ok) throw new ProtocolError(refusalText(fetched))
  if (fetched.tip !== ctx.baseTip) throw new ProtocolError(`${changed} (${ctx.base}@${ctx.baseTip} → ${fetched.tip})`)
}

/** The shared publisher owns multipart framing, acknowledgement and read-back. */
async function post(ctx: Context, producer: Producer, data: unknown): Promise<void> {
  await assertCurrent(ctx)
  const published = await publishGitHubRecord(
    newProofRecord(ctx.repository, ctx.pr, producer, ctx.candidate, data),
    ctx.history,
    withRoxabiGitHubPolicy({ cwd: ctx.cwd, gh }),
    null,
  )
  if (published.status !== 'confirmed')
    throw new ProtocolError(
      `the ${producer} proof publication was ${published.status}: ${published.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
    )
  await assertCurrent(ctx)
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

/** A refusal saying the record does not bind or cannot be read — never a producer verdict. */
function isUnbound(outcome: unknown): outcome is Refusal {
  return isMap(outcome) && outcome.ok === false && (outcome.reason === 'unbound' || outcome.reason === 'unreadable')
}

async function acquireSemctx(ctx: Context): Promise<SemctxAcquisition> {
  const inputs = await semctxInputs(ctx.facts, gitResult)
  if ('ok' in inputs) throw new ProtocolError(refusalText(inputs))
  const expected: SemctxExpected = {
    repository: ctx.repository,
    pr: ctx.pr,
    candidate: ctx.candidate,
    ...inputs,
    changeFiles: ctx.facts.changeFiles,
  }
  const found = findProofRecord(ctx.history, 'semctx', ctx.candidate)
  if ('record' in found && !recordIntegrity(found.parts, 'semctx')) {
    const assessment = readSemctxRecord(found.record, expected)
    if (!isUnbound(assessment)) return { outcome: 'reused', assessment }
  }
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
    await post(ctx, 'semctx', record)
    return { outcome: 'posted', assessment: read }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function acquireAssertledger(ctx: Context, manifestPath: string | undefined): Promise<Outcome> {
  const treeArgs = ['rev-parse', `${ctx.candidate}^{tree}`]
  const treeRun = await gitResult(ctx.facts.toplevel, treeArgs)
  if (treeRun.code !== 0) throw new ProtocolError(`git ${treeArgs.join(' ')} failed: ${treeRun.stderr.trim()}`)
  const expected = { repository: ctx.repository, pr: ctx.pr, candidate: ctx.candidate, tree: treeRun.stdout.trim() }
  const found = findProofRecord(ctx.history, 'assertledger', ctx.candidate)
  if (manifestPath === undefined) {
    if (
      'record' in found &&
      !recordIntegrity(found.parts, 'assertledger') &&
      !isUnbound(readAssertledgerRecord(found.record, expected))
    )
      return 'reused'
    throw new ProtocolError(
      `assertledger applies to PR #${ctx.pr} (fix ticket with an adapter) and no record binds ${ctx.candidate}: run \`assertledger check . --after ${ctx.candidate} …\` and pass its manifest with --assertledger-manifest`,
    )
  }
  // Capture before the first producer await. The exporter is not the replay input.
  const bytes = readFileSync(resolve(manifestPath))
  const manifest = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const work = mkdtempSync(join(tmpdir(), 'omp-proof-manifest-'))
  try {
    const path = join(work, 'manifest.json')
    writeFileSync(path, bytes, { mode: 0o400 })
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
    await post(ctx, 'assertledger', record)
    return 'posted'
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

type BindingMandate = {
  scope: { repository: string; target: string }
  recordId: string
  kind: 'mandate'
  branch: string
  base: string
}

function bindingOf(record: { kind: string; payload: unknown }): BindingMandate | 'malformed' | null {
  if (record.kind !== 'workflow-binding') return null
  const payload = record.payload
  if (!isMap(payload)) return 'malformed'
  const mandate = payload.mandate
  if (
    !isMap(mandate) ||
    mandate.kind !== 'mandate' ||
    typeof mandate.recordId !== 'string' ||
    !isMap(mandate.scope) ||
    typeof mandate.scope.repository !== 'string' ||
    typeof mandate.scope.target !== 'string' ||
    typeof payload.branch !== 'string' ||
    payload.branch.length === 0 ||
    typeof payload.base !== 'string' ||
    payload.base.length === 0
  ) {
    return 'malformed'
  }
  return {
    scope: { repository: mandate.scope.repository, target: mandate.scope.target },
    recordId: mandate.recordId,
    kind: 'mandate',
    branch: payload.branch,
    base: payload.base,
  }
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
      await gh(cwd, ['pr', 'view', String(args.pr), '--json', 'headRefOid,headRefName,baseRefName,state']),
    )
    const candidate = isMap(view) ? view.headRefOid : undefined
    const branch = isMap(view) ? view.headRefName : undefined
    const base = isMap(view) ? view.baseRefName : undefined
    const state = isMap(view) ? view.state : undefined
    if (typeof candidate !== 'string' || typeof branch !== 'string' || typeof base !== 'string' || state !== 'OPEN') {
      throw new ProtocolError(`PR #${args.pr} is not an open PR with a head and a base`)
    }
    const selected = await refreshSelectedBase(cwd, base, gitResult, gh)
    if (!selected.ok) throw new ProtocolError(refusalText(selected))
    const baseTip = selected.tip
    const facts = await candidateFacts(cwd, candidate, base, baseTip, gitResult)
    if ('ok' in facts) throw new ProtocolError(refusalText(facts))
    const repository = await repositoryOf(gh, cwd)
    const policy = withRoxabiGitHubPolicy({ cwd, gh })
    const prScope = githubScope(repository, args.pr)
    const history = decodeHistory(await readGitHubHistory(prScope, policy))
    if (!history.source.complete)
      throw new ProtocolError(`the complete common record history for PR #${args.pr} could not be read`)
    const bindings: BindingMandate[] = []
    for (const operation of history.operations) {
      const claimsBinding = operation.claimedKinds.includes('workflow-binding')
      const record = operation.record
      if (claimsBinding && (operation.status !== 'complete' || record === null || operation.authority === 'foreign')) {
        throw new ProtocolError('workflow binding is incomplete')
      }
      if (record?.kind !== 'workflow-binding') continue
      if (operation.status !== 'complete' || operation.authority === 'foreign') {
        throw new ProtocolError('workflow binding is incomplete')
      }
      if (record.repository !== prScope.repository || record.target !== prScope.target) {
        throw new ProtocolError('workflow binding scope is not this pull request')
      }
      const parsed = bindingOf(record)
      if (parsed === null || parsed === 'malformed')
        throw new ProtocolError('workflow binding payload is not a mandate ref')
      bindings.push(parsed)
    }
    if (bindings.length > 1) throw new ProtocolError('workflow binding conflicts')
    // Standalone proof only. A missing binding does not authorize a Feature run.
    // A present invalid, partial, foreign, or conflicting binding already refused.
    const binding = bindings[0]
    if (binding) {
      if (binding.branch !== branch || binding.base !== base) {
        throw new ProtocolError('workflow binding branch or base does not match the pull request')
      }
      const mandateHistory = decodeHistory(await readGitHubHistory(binding.scope, policy))
      if (!mandateHistory.source.complete) throw new ProtocolError('bound mandate history is incomplete')
      const mandateRecord = mandateHistory.operations.find(
        (operation) =>
          operation.status === 'complete' &&
          operation.authority !== 'foreign' &&
          operation.record?.recordId === binding.recordId,
      )?.record
      if (mandateRecord?.kind !== 'mandate') {
        throw new ProtocolError('bound mandate record is not confirmed')
      }
      const parentRef = mandateRecord.payload.parent
      const external = parentRef === null ? [] : [decodeHistory(await readGitHubHistory(parentRef.scope, policy))]
      if (external.some((item) => !item.source.complete))
        throw new ProtocolError('parent mandate history is incomplete')
      const pins = pinsFromApplicableMandate(mandateHistory, external)
      if (pins !== null) {
        if (!Array.isArray(pins)) throw new ProtocolError(pins.error)
        const drifted = await compareApplicableProofPins(gitResult, facts, pins)
        if (!drifted.ok) throw new ProtocolError(drifted.error)
      }
    }
    const ledger = await assertledgerApplies(cwd, facts, { pr: args.pr }, { gh, git: gitResult }, repository)
    if (typeof ledger === 'object') throw new ProtocolError(refusalText(ledger))
    const ctx: Context = { cwd, pr: args.pr, candidate, base, baseTip, repository, history, facts }
    await assertCurrent(ctx)
    const report: Record<string, unknown> = {
      pr: args.pr,
      candidate,
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    }
    if (facts.semctx === 'configured') {
      const acquired = await acquireSemctx(ctx)
      report.semctx = acquired.outcome
      report.semctxAssessment = acquired.assessment
    }
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
