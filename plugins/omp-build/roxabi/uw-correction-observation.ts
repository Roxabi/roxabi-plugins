import type { Result } from '../engine/result.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure, isGitSha } from './uw-action-result.ts'

/** Host-observed correction coordinates, never an execution grant. */
export type CorrectionActionCode = {
  actionHead: string
  originalCandidate: string
  expectedRemoteHead: string | null
  request: RecordInputRef
  decision: RecordInputRef
  cwd: string
  remoteBranch: string
  branch: string
  base: string
}

const active = new WeakMap<UwActionRequest, CorrectionActionCode>()

/** Only the active correction host wraps its own exact request; scope ends after confirmation. */
export async function withCorrectionObservation<T>(
  request: UwActionRequest,
  basis: CorrectionActionCode,
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const pull = request.subject.pullRequest
  if (
    active.has(request) ||
    request.purpose !== 'correction' ||
    pull === null ||
    request.code.repository !== pull.repository ||
    request.code.head !== basis.actionHead ||
    request.code.referenceCommit !== basis.actionHead ||
    !isGitSha(basis.actionHead) ||
    !isGitSha(basis.originalCandidate) ||
    basis.expectedRemoteHead !== basis.originalCandidate ||
    basis.request.record.kind !== 'fix-request' ||
    basis.decision.record.kind !== 'decision' ||
    basis.cwd.length === 0 ||
    basis.branch.length === 0 ||
    basis.remoteBranch.length === 0 ||
    basis.base.length === 0 ||
    basis.request.selector !== '/payload' ||
    basis.decision.selector !== '/payload' ||
    [basis.request, basis.decision].some(
      (ref) => ref.record.scope.repository !== pull.repository || ref.record.scope.target !== pull.target,
    )
  )
    return actionFailure('action-code-moved', 'Correction observation does not match the live action coordinates')
  active.set(request, basis)
  try {
    return await run()
  } finally {
    active.delete(request)
  }
}

/** Unregistered copies have no local observation context. */
export function correctionObservation(request: UwActionRequest): CorrectionActionCode | undefined {
  return active.get(request)
}
