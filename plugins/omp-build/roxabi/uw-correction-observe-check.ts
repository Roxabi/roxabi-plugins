import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { resolveCorrectionRequestBasis } from '../engine/correction-request-basis.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { accounted } from '../engine/review-context-authentication.ts'
import { historyFor, recordsOf, workflowOperationProblem } from '../engine/workflow-control.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import type { CorrectionActionCode } from './uw-correction-observation.ts'

const exec = promisify(execFile)

/** Authenticate the original decision and request, and derive H1 from the original review inventory. */
export function correctionAnchorsValid(
  request: UwActionRequest,
  basis: CorrectionActionCode,
  histories: readonly DecodedHistory[],
): boolean {
  const scope = request.subject.pullRequest
  if (
    scope === null ||
    !request.stageSources.some((ref) => canonicalValueDigest(ref) === canonicalValueDigest(basis.decision))
  )
    return false
  const history = historyFor(scope, histories)
  if (history === null || workflowOperationProblem(history) !== null) return false
  const records = recordsOf(history)
  const selected = [basis.request, basis.decision].map((ref) => {
    const matches = records.filter(
      (record) => record.kind === ref.record.kind && record.recordId === ref.record.recordId,
    )
    const record = matches[0]
    return ref.selector === '/payload' &&
      canonicalValueDigest(ref.record.scope) === canonicalValueDigest(scope) &&
      matches.length === 1 &&
      record !== undefined &&
      accounted(history, record) &&
      canonicalValueDigest(record.payload) === ref.digest
      ? record
      : undefined
  })
  const [fix, decision] = selected
  if (fix?.kind !== 'fix-request' || decision?.kind !== 'decision') return false
  const resolved = resolveCorrectionRequestBasis(history, fix, decision)
  return (
    resolved.ok &&
    resolved.value.originalCandidate === basis.originalCandidate &&
    resolved.value.expectedRemoteHead === basis.expectedRemoteHead &&
    resolved.value.branch === basis.remoteBranch &&
    resolved.value.base === basis.base
  )
}

/** Observe the actual correction checkout; no local contents are presented as remote facts. */
export async function correctionWorktreeValid(basis: CorrectionActionCode): Promise<boolean> {
  try {
    const [head, status, branch] = await Promise.all([
      exec('git', ['-C', basis.cwd, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }),
      exec('git', ['-C', basis.cwd, 'status', '--porcelain'], { encoding: 'utf8' }),
      exec('git', ['-C', basis.cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }),
      exec('git', ['-C', basis.cwd, 'merge-base', '--is-ancestor', basis.originalCandidate, basis.actionHead], {
        encoding: 'utf8',
      }),
    ])
    return (
      head.stdout.trim() === basis.actionHead && branch.stdout.trim() === basis.branch && status.stdout.length === 0
    )
  } catch {
    return false
  }
}
