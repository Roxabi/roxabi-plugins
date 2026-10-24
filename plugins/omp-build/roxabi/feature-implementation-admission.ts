import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import type { HostEffectAdmission } from '../engine/workflow-receipt-schema.ts'
import type { Json, NativeProofBashCall } from '../omp/review-runtime/contracts.ts'
import { ticketOfSubject } from '../skills/feature/epic-claims.ts'
import { titleType } from '../skills/feature/epic-naming.ts'
import type { FeatureGit } from './feature-contract.ts'

const execGit = promisify(execFile)

type ImplementationChild = {
  structured: Json | null
  bashCalls?: readonly NativeProofBashCall[]
}

type ImplementationClaim = {
  outcome: 'implemented' | 'blocked'
  commitSHAs: string[]
  commands: { command: string; exitCode: number; toolCallId: string }[]
  proofToolCallId: string | null
  proofUnavailableReason: string | null
  reason: string
}
type ParsedImplementationClaim =
  | { ok: true; claim: ImplementationClaim }
  | { ok: false; reason: 'implementation-claim-missing' | 'implementation-command-unidentified' }
type ImplementationClaimFailureReason = Extract<ParsedImplementationClaim, { ok: false }>['reason']
type ImplementationClaimJson = Extract<Json, Record<string, Json>> & {
  outcome: 'implemented' | 'blocked'
  commitSHAs: string[]
  commands: Json[]
  proofToolCallId: string | null
  proofUnavailableReason: string | null
  reason: string
}

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
  const parsed = implementationClaims(claimSource(input.children))
  if (!parsed.ok) return hostAdmission('')
  const claim = parsed.claim
  if (
    claim.outcome !== 'implemented' ||
    claim.commitSHAs.length === 0 ||
    claim.commands.length === 0 ||
    claim.proofToolCallId === null ||
    claim.proofUnavailableReason !== null
  )
    return hostAdmission(claim.reason)
  const calls = input.children.flatMap((child) => child.bashCalls ?? [])
  const binding = bindClaimedCommands(claim, calls, input.cwd)
  if (!binding.ok) return hostAdmission(claim.reason, false, binding.commands)
  if (!hasSuccessfulForegroundProof(claim, binding.commands, calls))
    return hostAdmission(claim.reason, false, binding.commands)
  const commits = await verifyOwnedLineage(input.cwd, input.startHead, claim.commitSHAs, git)
  if (!commits.ok) return hostAdmission(claim.reason, false, binding.commands)
  if (!Number.isSafeInteger(input.ticket) || input.ticket <= 0)
    return hostAdmission(claim.reason, false, binding.commands)
  if (!(await verifyTaskOwnedCommitSubjects(input.cwd, commits.commits, input.ticket, git))) {
    return hostAdmission(claim.reason, false, binding.commands)
  }
  return hostAdmission(
    claim.reason,
    true,
    binding.commands,
    commits.commits.map((commit) => commit.sha),
    [...new Set(commits.commits.flatMap((commit) => commit.paths))],
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

function hasSuccessfulForegroundProof(
  claim: ImplementationClaim,
  commands: HostEffectAdmission['commands'],
  calls: readonly NativeProofBashCall[],
): boolean {
  const proof = commands.find((command) => command.toolCallId === claim.proofToolCallId)
  const proofCall = calls.find((call) => call.toolCallId === claim.proofToolCallId)
  return proof !== undefined && proof.exitCode === 0 && proofCall !== undefined && foregroundCompletion(proofCall)
}

function claimSource(children: readonly ImplementationChild[]): Json | null {
  const structured = children.flatMap((child) => (child.structured === null ? [] : [child.structured]))
  return structured.length === 1 ? structured[0] : null
}

function implementationClaims(value: Json | null): ParsedImplementationClaim {
  if (!hasImplementationClaimShape(value)) return { ok: false, reason: 'implementation-claim-missing' }
  const commands = implementationCommandClaims(value.commands)
  if (!commands.ok) return commands
  return {
    ok: true,
    claim: {
      outcome: value.outcome,
      commitSHAs: value.commitSHAs,
      commands: commands.commands,
      proofToolCallId: value.proofToolCallId,
      proofUnavailableReason: value.proofUnavailableReason,
      reason: value.reason,
    },
  }
}

function hasImplementationClaimShape(value: Json | null): value is ImplementationClaimJson {
  return (
    objectRecord(value) &&
    (value.outcome === 'implemented' || value.outcome === 'blocked') &&
    Array.isArray(value.commitSHAs) &&
    value.commitSHAs.every((sha) => typeof sha === 'string') &&
    Array.isArray(value.commands) &&
    typeof value.reason === 'string' &&
    nullableString(value.proofToolCallId) &&
    nullableString(value.proofUnavailableReason)
  )
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function implementationCommandClaims(
  rawCommands: readonly unknown[],
): { ok: true; commands: ImplementationClaim['commands'] } | { ok: false; reason: ImplementationClaimFailureReason } {
  const commands: ImplementationClaim['commands'] = []
  for (const rawCommand of rawCommands) {
    const command = implementationCommand(rawCommand)
    if (!command.ok) return command
    commands.push(command.command)
  }
  return { ok: true, commands }
}

function implementationCommand(
  value: unknown,
):
  | { ok: true; command: ImplementationClaim['commands'][number] }
  | { ok: false; reason: ImplementationClaimFailureReason } {
  if (
    !objectRecord(value) ||
    typeof value.command !== 'string' ||
    typeof value.exitCode !== 'number' ||
    !Number.isInteger(value.exitCode)
  ) {
    return { ok: false, reason: 'implementation-claim-missing' }
  }
  if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0) {
    return { ok: false, reason: 'implementation-command-unidentified' }
  }
  return { ok: true, command: { command: value.command, exitCode: value.exitCode, toolCallId: value.toolCallId } }
}

function foregroundCompletion(call: NativeProofBashCall): boolean {
  if (call.exitCode === null || call.result === null || !objectRecord(call.result)) return false
  if (!objectRecord(call.result.details)) return false
  const details = call.result.details
  if (details.async !== undefined || details.service !== undefined || details.terminalId !== undefined) return false
  if (details.timedOut === true) return false
  return true
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
  if (call.result === null || call.exitCode === null) {
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
