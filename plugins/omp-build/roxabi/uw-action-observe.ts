import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  canonicalValueDigest,
  decodeHistory,
  readGitHubHistory,
  recordIntegrity,
  recordOperation,
  recordsOf,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { ActionInputManifest, RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure, isGitSha, jsonPointer } from './uw-action-result.ts'
import { type CorrectionActionCode, correctionObservation } from './uw-correction-observation.ts'
import { correctionAnchorsValid, correctionWorktreeValid } from './uw-correction-observe-check.ts'
import { checkoutRepository } from './uw-git-bytes.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { readEffectiveFixConfig } from './workflow-config.ts'

const execFileAsync = promisify(execFile)
const BASE_PURPOSE: Record<string, true> = { plan: true, 'plan-review': true }

export type ActionFactSource = { cwd: string; gh: Gh; readAuthor?: string }

function sameRecord(record: CanonicalRecord, ref: ExternalRecordRef): boolean {
  return (
    record.recordId === ref.recordId &&
    record.kind === ref.kind &&
    record.repository === ref.scope.repository &&
    record.target === ref.scope.target
  )
}

export async function readHistories(
  scopes: readonly Scope[],
  source: ActionFactSource,
): Promise<Result<DecodedHistory[]>> {
  const options: GitHubOptions = { cwd: source.cwd, gh: source.gh, readAuthor: source.readAuthor }
  const decoded: DecodedHistory[] = []
  for (const scope of scopes) {
    try {
      decoded.push(decodeHistory(await readGitHubHistory(scope, options)))
    } catch (error) {
      return actionFailure(
        'record-unreadable',
        `${scope.repository} ${scope.target} history is unreadable: ${error instanceof Error ? error.message : 'GitHub read failed'}`,
      )
    }
  }
  return { ok: true, value: decoded }
}

export function authenticate(record: CanonicalRecord, home: readonly DecodedHistory[]): Result<CanonicalRecord> {
  const operation = recordOperation(home, record)
  if (operation === null)
    return actionFailure('record-unreadable', `${record.kind} ${record.recordId} has no native operation`)
  const refusal = recordIntegrity(operation.parts, record)
  if (refusal !== null) return actionFailure(refusal.reason, refusal.detail)
  if (operation.authority === 'foreign')
    return actionFailure('record-unreadable', `${record.kind} ${record.recordId} is not authenticated`)
  return { ok: true, value: record }
}

export function sourceRef(home: readonly DecodedHistory[], ref: ExternalRecordRef): Result<RecordInputRef> {
  for (const history of home) {
    for (const record of recordsOf(history)) {
      if (!sameRecord(record, ref)) continue
      const authenticated = authenticate(record, home)
      if (!authenticated.ok) return authenticated
      const selected = jsonPointer({ payload: record.payload }, '/payload')
      if (!selected.ok) return selected
      return {
        ok: true,
        value: { source: 'record', record: ref, selector: '/payload', digest: canonicalValueDigest(selected.value) },
      }
    }
  }
  return actionFailure('record-unreadable', 'Accepted source is absent from its scope')
}

async function mergedReviewBase(
  request: UwActionRequest,
  cwd: string,
  state: string | undefined,
  merge: string | undefined,
  currentBase: string,
): Promise<boolean> {
  if (request.purpose !== 'review' || state !== 'MERGED' || typeof merge !== 'string' || !isGitSha(merge)) return false
  try {
    const [first, second] = await Promise.all([
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', `${merge}^1`], { encoding: 'utf8' }),
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', `${merge}^2`], { encoding: 'utf8' }),
      execFileAsync('git', ['-C', cwd, 'merge-base', '--is-ancestor', merge, currentBase], { encoding: 'utf8' }),
    ])
    return first.stdout.trim() === request.code.base && second.stdout.trim() === request.code.head
  } catch {
    return false
  }
}

type PullObservation = {
  headRefOid?: string
  baseRefOid?: string
  headRefName?: string
  baseRefName?: string
  state?: string
  mergeCommit?: { oid?: string }
}

async function validateCorrectionPull(
  request: UwActionRequest,
  source: ActionFactSource,
  pull: { repository: string; target: string },
  parsed: PullObservation,
  correction: CorrectionActionCode,
): Promise<Result<void>> {
  const histories = await readHistories([pull], source)
  if (!histories.ok) return histories
  if (
    parsed.headRefOid !== correction.expectedRemoteHead ||
    parsed.headRefName !== correction.remoteBranch ||
    parsed.baseRefName !== correction.base ||
    (await checkoutRepository(correction.cwd)) !== pull.repository ||
    !correctionAnchorsValid(request, correction, histories.value) ||
    !(await correctionWorktreeValid(correction))
  )
    return actionFailure('action-code-moved', 'Correction remote anchor, original authority, or worktree changed')
  return { ok: true, value: undefined }
}

async function observePull(
  request: UwActionRequest,
  source: ActionFactSource,
  pull: { repository: string; target: string },
): Promise<Result<{ branch: string; baseName: string }>> {
  const raw = await source.gh(source.cwd, [
    'pr',
    'view',
    pull.target.split('#').at(-1) ?? '',
    '--repo',
    pull.repository,
    '--json',
    'headRefOid,baseRefOid,headRefName,baseRefName,state,mergeCommit',
  ])
  const parsed = JSON.parse(raw) as PullObservation
  const correction = correctionObservation(request)
  if (correction !== undefined) {
    const validation = await validateCorrectionPull(request, source, pull, parsed, correction)
    if (!validation.ok) return validation
  }
  if (
    parsed.headRefOid !== (correction?.expectedRemoteHead ?? request.code.head) ||
    typeof parsed.baseRefName !== 'string' ||
    parsed.baseRefName.length === 0
  ) {
    return actionFailure(
      'action-code-moved',
      `Observed PR head ${parsed.headRefOid ?? 'absent'} does not match ${request.code.head}`,
    )
  }
  const selectedBase = await execFileAsync(
    'git',
    ['-C', correction?.cwd ?? source.cwd, 'rev-parse', `origin/${parsed.baseRefName}`],
    {
      encoding: 'utf8',
    },
  ).catch(() => null)
  if (
    selectedBase === null ||
    (selectedBase.stdout.trim() !== request.code.base &&
      !(await mergedReviewBase(request, source.cwd, parsed.state, parsed.mergeCommit?.oid, selectedBase.stdout.trim())))
  ) {
    return actionFailure('action-code-moved', 'Selected origin base does not match the requested base')
  }
  return { ok: true, value: { branch: parsed.headRefName ?? '', baseName: parsed.baseRefName ?? '' } }
}

export async function observeCode(
  request: UwActionRequest,
  source: ActionFactSource,
): Promise<Result<{ branch: string; baseName: string }>> {
  const code = request.code
  if (
    !isGitSha(code.head) ||
    !isGitSha(code.base) ||
    code.referenceCommit !== (BASE_PURPOSE[request.purpose] ? code.base : code.head)
  ) {
    return actionFailure('action-code-moved', 'Code coordinates are not the observed base or head for this purpose')
  }
  const pull = request.subject.pullRequest
  if (pull === null) {
    const head = await execFileAsync('git', ['-C', source.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    if (head.stdout.trim() !== code.head)
      return actionFailure('action-code-moved', 'Worktree HEAD does not match the requested code head')
    return { ok: true, value: { branch: 'HEAD', baseName: 'HEAD' } }
  }
  return observePull(request, source, pull)
}

export async function configuration(
  cwd: string,
  commit: string,
): Promise<Result<ActionInputManifest['configuration']>> {
  const git: GitRunner = async (directory, args) => {
    try {
      const shown = await execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' })
      return { code: 0, stdout: shown.stdout, stderr: shown.stderr }
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string }
      return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
    }
  }
  const effective = await readEffectiveFixConfig({ cwd, commit, git })
  if (!effective.ok) return { ok: false, diagnostics: effective.diagnostics }
  return {
    ok: true,
    value: { version: effective.version, digest: effective.digest, serialized: JSON.stringify(effective.effective) },
  }
}
