import type { CanonicalRecord, CauseContext, Json, Scope, Submission } from '../dist/contracts.js'
import type { NativeBatch, NativeTask } from '../omp/review-runtime/contracts.ts'
import type { NativeBatchController } from '../omp/review-runtime/controller.ts'
import type { FixPolicy } from './fix-domain'
import type { ActionSubject } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
/** `reasons` names why an observation was unavailable, for the operator only: it is never a published code. */
export type FixActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: string[]; reasons?: readonly string[] }

export type FixScope = Scope

export type FixTarget = FixScope & {
  number: number
  kind: 'issue' | 'pull-request'
  state: 'open' | 'closed'
  candidateGitSHA: string | null
  baseGitSHA: string | null
}
export type PublishBinding = {
  pushUrl: string
  publicationRepository: string
  localBranch: string
  destinationRef: string
  localHead: string
  expectedRemoteSHA: string | null
  defaultBranch: string
  observed: Json
}

export type TargetResolver = {
  resolveExplicit(reference: string): Promise<FixTarget | null>
  resolveContext(): Promise<FixTarget | null>
}

export type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
export type NativePort = Pick<NativeBatchController, 'activate' | 'active' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
}

export type ReviewStepResult = {
  action: 'fix' | 'review' | 'land' | 'stop'
  reason?: string
  reviews?: number
  remaining?: number
}

export type ReviewAuthority = {
  nextReviewStep(
    cwd: string,
    pr: number,
    options: { ciFailed?: boolean; reviewing?: boolean },
  ): Promise<ReviewStepResult>
}

export type FixRecordKind =
  | 'contribution'
  | 'fix-request'
  | 'review-attempt'
  | 'decision'
  | 'correction-result'
  | 'falsification-result'
  | 'cause-disposition'
  | 'fix-result'
export type FixRecord = Extract<CanonicalRecord, { kind: FixRecordKind }>

export type RecordPublisher = { publish(record: FixRecord, canPublish?: () => boolean): Promise<FixActionResult<void>> }

export type FixIdentity = {
  runId: string
  operationId: string
  nextRecordId(kind: FixRecord['kind']): string
}

export type FixRequestInput = {
  cwd: string
  reference?: string
  contextTarget?: FixTarget
  rawOperatorRequest: Json
  scope: string
  reviewId?: string
  candidateGitSHA?: string
  policy?: FixPolicy
  identity: FixIdentity
  publishBinding: PublishBinding
  nativeTasks: Array<Omit<NativeTask, 'action'>>
  operations: UwOperations
  /** Approved mandate scope when it is distinct from the correction target. Never a pull-request scope. */
  uw?: Scope
  /** Same-scope confirmed mandate ids only. Cross-scope ids stay external refs, never inputs. */
  authorityInputs?: readonly string[]
}

export type PreparedFix = {
  target: FixTarget
  requestId: string
  inventoryId: string
  batch: NativeBatch
  causeContext: CauseContext
  sourceContributionId: string
  policy: FixPolicy
  cwd: string
  publishBinding: PublishBinding
  subject: ActionSubject
}

export function sameScopeAuthorityInputs(input: FixRequestInput): FixActionResult<readonly string[]> {
  const ids = input.authorityInputs ?? []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!isRecordId(id) || seen.has(id)) return failure('fix-authority-input-invalid')
    seen.add(id)
  }
  return { ok: true, value: ids }
}

export function failure<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}
export function validPublishBinding(binding: PublishBinding, target: FixTarget): boolean {
  return (
    target.candidateGitSHA !== null &&
    /^[0-9a-f]{40}$/.test(target.candidateGitSHA) &&
    binding.publicationRepository.trim().length > 0 &&
    binding.localHead === target.candidateGitSHA &&
    /^[0-9a-f]{40}$/.test(binding.localHead) &&
    binding.localBranch.trim().length > 0 &&
    binding.defaultBranch.trim().length > 0 &&
    /^refs\/heads\/.+/.test(binding.destinationRef) &&
    binding.destinationRef === `refs/heads/${binding.localBranch}` &&
    binding.localBranch !== binding.defaultBranch &&
    binding.pushUrl.trim().length > 0 &&
    (binding.expectedRemoteSHA === null || /^[0-9a-f]{40}$/.test(binding.expectedRemoteSHA))
  )
}

export function isRecordId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

export function validScope(scope: string): boolean {
  return scope.trim().length > 0 && scope.length <= 4_000
}
export function targetMatches(left: FixTarget, right: FixTarget): boolean {
  return (
    left.repository === right.repository &&
    left.target === right.target &&
    left.number === right.number &&
    left.kind === right.kind
  )
}

export function capturedSubmission(
  raw: Json,
  data: Json | null = null,
  attemptIndex = 0,
  partialText: string | null = null,
): Submission {
  return { attemptIndex, data, raw, partialText }
}
