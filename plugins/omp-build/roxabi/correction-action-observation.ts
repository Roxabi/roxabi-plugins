import type { CorrectionEffectResult } from './correction-execution-contract.ts'
import type { CorrectionNativeRuntime } from './correction-native-runtime.ts'
import { confirmPreparedAction, prepareRefusal } from './delivery-action.ts'
import { isRecord } from './feature-engine.ts'
import type { FixTarget } from './fix-contract.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import { withCorrectionObservation } from './uw-correction-observation.ts'

export async function prepareObservedCorrection(
  operations: UwOperations,
  request: UwActionRequest,
  target: FixTarget,
  runtime: CorrectionNativeRuntime,
): Promise<CorrectionEffectResult<PreparedUwAction>> {
  const resolveRefs = runtime.options.correctionObservationRefs
  if (resolveRefs === undefined || target.candidateGitSHA === null)
    return { ok: false, kind: 'terminal', diagnostics: ['prepare-action-unavailable'] }
  const refs = await resolveRefs()
  if (!refs.ok) return { ...refs, preEffectRefusal: refs.diagnostics }
  const binding = runtime.options.prepared.publishBinding
  const destination = binding.destinationRef
  const observed = binding.observed
  const pr = isRecord(observed) && isRecord(observed.pr) ? observed.pr : null
  if (
    !destination.startsWith('refs/heads/') ||
    destination.length === 'refs/heads/'.length ||
    pr === null ||
    pr.headRefOid !== target.candidateGitSHA ||
    typeof pr.headRefName !== 'string' ||
    pr.headRefName !== destination.slice('refs/heads/'.length) ||
    pr.headRepository !== binding.publicationRepository ||
    typeof pr.baseRefName !== 'string' ||
    pr.baseRefName.length === 0
  )
    return {
      ok: false,
      kind: 'terminal',
      diagnostics: ['publish-binding-invalid'],
      preEffectRefusal: ['publish-binding-invalid'],
    }
  const prepared = await withCorrectionObservation(
    request,
    {
      actionHead: request.code.head,
      originalCandidate: target.candidateGitSHA,
      expectedRemoteHead: binding.expectedRemoteSHA,
      request: refs.value.request,
      decision: refs.value.decision,
      cwd: runtime.options.prepared.cwd,
      branch: binding.localBranch,
      remoteBranch: pr.headRefName,
      base: pr.baseRefName,
    },
    () => confirmPreparedAction(operations, request),
  )
  if (!prepared.ok) {
    const reason = prepareRefusal(prepared.diagnostics)
    return { ok: false, kind: 'terminal', diagnostics: [reason], preEffectRefusal: [reason] }
  }
  return { ok: true, value: prepared.value }
}
