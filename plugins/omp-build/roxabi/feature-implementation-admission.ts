import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { type CommandRun, commandOutputSchema } from '../engine/criterion-evidence-schema.ts'
import { type ImplementationOutput, implementationOutputSchema } from '../engine/workflow-output-schema.ts'
import type { HostEffectAdmission } from '../engine/workflow-receipt-schema.ts'
import type { Json, NativeProofBashCall } from '../omp/review-runtime/contracts.ts'
import { ticketOfSubject } from '../skills/feature/epic-claims.ts'
import { titleType } from '../skills/feature/epic-naming.ts'
import type { FeatureGit } from './feature-contract.ts'
import { hostCompletedStructured } from './feature-implementation-receipt.ts'

const execGit = promisify(execFile)

type ImplementationChild = {
  structured: Json | null
  bashCalls?: readonly NativeProofBashCall[]
  commandRuns?: readonly CommandRun[]
}

type ImplementationClaim = ImplementationOutput
type ParsedImplementationClaim =
  | { ok: true; claim: ImplementationClaim }
  | { ok: false; reason: 'implementation-claim-missing' | 'implementation-command-unidentified' }

function hostAdmission(
  reason: string,
  admitted = false,
  commands: HostEffectAdmission['commands'] = [],
  commits: string[] = [],
  paths: string[] = [],
): HostEffectAdmission {
  return { admitted, commits, paths, commands, remoteBranch: null, remoteTip: null, published: false, reason }
}

export async function admitImplementationEvidence(input: {
  cwd: string
  startHead: string
  ticket: number
  children: readonly ImplementationChild[]
  git?: FeatureGit
}): Promise<HostEffectAdmission> {
  const git = input.git ?? defaultFeatureGit
  const parsed = implementationClaims(hostCompletedStructured(claimSourceChild(input.children)))
  if (!parsed.ok) return hostAdmission('')
  const claim = parsed.claim
  if (claim.outcome !== 'implemented' || claim.commitSHAs.length === 0) return hostAdmission(claim.reason)
  if (!declaredCriteria(claim.criteria)) return hostAdmission('implementation-criterion-missing')
  const commits = await verifyOwnedLineage(input.cwd, input.startHead, claim.commitSHAs, git)
  if (!commits.ok) return hostAdmission(claim.reason)
  const owned = commits.commits.map((commit) => commit.sha)
  const paths = [...new Set(commits.commits.flatMap((commit) => commit.paths))]
  const calls = input.children.flatMap((child) => child.bashCalls ?? [])
  const binding = bindClaimedCommands(claim, calls, input.cwd)
  if (!binding.ok) return hostAdmission(claim.reason, false, binding.commands, owned, paths)
  const runs = input.children.flatMap((child) => child.commandRuns ?? [])
  if (!conservedDeclarations(claim, runs)) {
    return hostAdmission('implementation-evidence-unconserved', false, binding.commands, owned, paths)
  }
  if (!Number.isSafeInteger(input.ticket) || input.ticket <= 0) {
    return hostAdmission(claim.reason, false, binding.commands, owned, paths)
  }
  if (!(await verifyTaskOwnedCommitSubjects(input.cwd, commits.commits, input.ticket, git))) {
    return hostAdmission(claim.reason, false, binding.commands, owned, paths)
  }
  return hostAdmission(claim.reason, true, binding.commands, owned, paths)
}

function runConserved(
  expected: { toolCallId: string; command: string; exitCode: number },
  runs: readonly CommandRun[],
): boolean {
  const run = runs.find((item) => item.toolCallId === expected.toolCallId)
  return (
    run !== undefined &&
    run.command === expected.command &&
    run.exitCode === expected.exitCode &&
    commandOutputSchema.safeParse(run.output).success
  )
}

function declaredCriteria(criteria: ImplementationOutput['criteria']): boolean {
  if (criteria.length === 0) return false
  const ids = criteria.map((item) => item.target.id)
  return new Set(ids).size === ids.length
}

function conservedDeclarations(claim: ImplementationOutput, runs: readonly CommandRun[]): boolean {
  return claim.criteria.every(
    (item) =>
      item.verification !== 'evidence' ||
      item.evidence.every((evidence) => evidence.method !== 'test' || runConserved(evidence.after.run, runs)),
  )
}

function bindClaimedCommands(
  claim: ImplementationClaim,
  calls: readonly NativeProofBashCall[],
  cwd: string,
): { ok: true; commands: HostEffectAdmission['commands'] } | { ok: false; commands: HostEffectAdmission['commands'] } {
  const commands: HostEffectAdmission['commands'] = []
  const seen = new Set<string>()
  for (const command of claim.commands) {
    if (seen.has(command.toolCallId)) return { ok: false, commands }
    seen.add(command.toolCallId)
    const match = bindClaimedCommand(command, calls, cwd)
    if (!match.ok) return { ok: false, commands }
    commands.push(match.command)
  }
  return { ok: true, commands }
}

function claimSourceChild(children: readonly ImplementationChild[]): ImplementationChild | null {
  const structured = children.filter((child) => child.structured !== null)
  return structured.length === 1 ? structured[0] : null
}

function implementationClaims(value: unknown): ParsedImplementationClaim {
  const parsed = implementationOutputSchema.safeParse(value)
  return parsed.success ? { ok: true, claim: parsed.data } : { ok: false, reason: 'implementation-claim-missing' }
}

function bindClaimedCommand(
  claim: { command: string; exitCode: number; toolCallId: string },
  calls: readonly NativeProofBashCall[],
  cwd: string,
): { ok: true; command: HostEffectAdmission['commands'][number] } | { ok: false; reason: string } {
  const matches = calls.filter((call) => call.toolCallId === claim.toolCallId)
  if (matches.length === 0) return { ok: false, reason: 'implementation-command-uncaptured' }
  if (matches.length !== 1) return { ok: false, reason: 'implementation-command-ambiguous' }
  const call = matches[0]
  if (call === undefined || !objectRecord(call.input) || typeof call.input.command !== 'string') {
    return { ok: false, reason: 'implementation-command-uncaptured' }
  }
  if (call.input.command !== claim.command) return { ok: false, reason: 'implementation-command-text-mismatch' }
  if (call.result === null || call.exitCode === null || captureStillRunning(call.result)) {
    return { ok: false, reason: 'implementation-command-exit-unobserved' }
  }
  if (call.exitCode !== claim.exitCode) return { ok: false, reason: 'implementation-command-exit-mismatch' }
  if (call.effectiveCwd === null || !sameRealpath(call.effectiveCwd, cwd)) {
    return { ok: false, reason: 'implementation-command-cwd-unobserved' }
  }
  return {
    ok: true,
    command: { toolCallId: call.toolCallId, command: claim.command, exitCode: call.exitCode, cwd: call.effectiveCwd },
  }
}

async function verifyOwnedLineage(
  cwd: string,
  startHead: string,
  commitSHAs: readonly string[],
  git: FeatureGit,
): Promise<{ ok: true; commits: { sha: string; parent: string; paths: string[] }[] } | { ok: false; reason: string }> {
  const head = await git(['rev-parse', 'HEAD'], cwd)
  const status = await git(['status', '--porcelain'], cwd)
  const observedHead = head.stdout.trim()
  if (head.exitCode !== 0 || status.exitCode !== 0) return { ok: false, reason: 'implementation-git-unobserved' }
  if (status.stdout.trim() !== '') return { ok: false, reason: 'implementation-worktree-dirty' }
  if (commitSHAs.length === 0) {
    return observedHead === startHead
      ? { ok: true, commits: [] }
      : { ok: false, reason: 'implementation-unowned-commit' }
  }
  const commits = []
  let parent = startHead
  for (const sha of commitSHAs) {
    const verified = await git(['rev-parse', '--verify', `${sha}^{commit}`], cwd)
    const parents = await git(['rev-list', '--parents', '-n1', sha], cwd)
    const changed = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], cwd)
    if (verified.exitCode !== 0 || parents.exitCode !== 0 || changed.exitCode !== 0) {
      return { ok: false, reason: 'implementation-git-unobserved' }
    }
    const tokens = parents.stdout.trim().split(/\s+/)
    const paths = changed.stdout.split('\n').filter(Boolean)
    if (
      verified.stdout.trim() !== sha ||
      tokens.length !== 2 ||
      tokens[0] !== sha ||
      tokens[1] !== parent ||
      paths.length === 0
    ) {
      return { ok: false, reason: 'implementation-lineage-unverified' }
    }
    commits.push({ sha, parent, paths })
    parent = sha
  }
  return observedHead === parent ? { ok: true, commits } : { ok: false, reason: 'implementation-unowned-commit' }
}

async function verifyTaskOwnedCommitSubjects(
  cwd: string,
  commits: readonly { sha: string }[],
  ticket: number,
  git: FeatureGit,
): Promise<boolean> {
  for (const commit of commits) {
    const subject = await git(['show', '-s', '--format=%s', commit.sha], cwd)
    const title = subject.stdout.trim()
    if (subject.exitCode !== 0 || titleType(title) === null || ticketOfSubject(title) !== ticket) return false
  }
  return true
}

async function defaultFeatureGit(args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execGit('git', [...args], { cwd, encoding: 'utf8' })
    return { stdout: String(stdout), exitCode: 0 }
  } catch (error) {
    const failed = error as { stdout?: string; code?: number }
    return { stdout: String(failed.stdout ?? ''), exitCode: typeof failed.code === 'number' ? failed.code : 1 }
  }
}

function sameRealpath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function captureStillRunning(result: Json): boolean {
  if (!objectRecord(result) || !('details' in result) || !objectRecord(result.details)) return false
  const pending = result.details.async
  return objectRecord(pending) && pending.state === 'running'
}
