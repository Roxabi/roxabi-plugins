import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { ContextSuccessionProposal } from './workflow-context-disposition-schema.ts'
import { historyFor, type MandateRecord, type ReceiptRecord } from './workflow-control.ts'

type ContextSuccessionCode = Extract<
  ReceiptRecord['payload'],
  { action: 'implement'; phase: 'result' }
>['inputs']['manifest']['code']
type ProspectiveSuccessor = Pick<MandateRecord, 'repository' | 'target' | 'recordId' | 'payload'>
const refuse = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

export function authenticateSuccessionBaseline(
  proposal: ContextSuccessionProposal,
  predecessor: MandateRecord,
  successor: ProspectiveSuccessor,
  histories: readonly DecodedHistory[],
  spec: AcceptedOwnSpec,
  code: ContextSuccessionCode,
): Result<void> {
  const observation = proposal.reconciliation
  const scope = proposal.uw
  const parent = authenticateParentBaseline(proposal, predecessor, successor, histories, spec)
  if (!parent.ok) return parent
  if (
    canonicalValueDigest(observation.code) !== canonicalValueDigest(code) ||
    code.referenceCommit !== code.head ||
    observation.repository !== scope.repository ||
    observation.branch !== predecessor.payload.branch ||
    (successor.payload.branch !== observation.branch &&
      !(
        successor.payload.branch === null &&
        successor.payload.role === 'epic' &&
        spec.children.length > 0 &&
        spec.coverage !== null
      )) ||
    successor.payload.base !== predecessor.payload.base ||
    observation.remote.base.ref !== `refs/heads/${predecessor.payload.base}` ||
    (observation.branch === null
      ? observation.remote.candidate !== null ||
        observation.branch !== null ||
        observation.remote.base.tip !== code.head
      : observation.remote.candidate === null ||
        observation.branch === null ||
        observation.remote.candidate.ref !== `refs/heads/${observation.branch}` ||
        (observation.remote.candidate.tip !== null && observation.remote.candidate.tip !== code.head)) ||
    successor.payload.lineageHead !== code.head ||
    !equalScope(observation.delivery.uw, scope) ||
    observation.delivery.pullRequests.length !== 0 ||
    observation.delivery.integrations.length !== 0 ||
    observation.delivery.commits.length !== 0
  )
    return refuse('Context succession delivery baseline is not reconciled')
  return { ok: true, value: undefined }
}

function authenticateParentBaseline(
  proposal: ContextSuccessionProposal,
  predecessor: MandateRecord,
  successor: ProspectiveSuccessor,
  histories: readonly DecodedHistory[],
  spec: AcceptedOwnSpec,
): Result<void> {
  if (predecessor.payload.role !== 'epic') return { ok: true, value: undefined }
  if (
    predecessor.payload.branch !== null ||
    predecessor.payload.children.length === 0 ||
    predecessor.payload.coverage === null ||
    successor.payload.role !== 'epic' ||
    successor.payload.branch !== null ||
    spec.children.length === 0 ||
    spec.coverage === null
  )
    return refuse('Plan context succession requires detached parent authority')
  for (const child of [...predecessor.payload.children, ...spec.children]) {
    const history = historyFor(child.scope, histories)
    const cut = proposal.reconciliation.cuts.find((item) => equalScope(item.scope, child.scope))
    if (
      history === null ||
      cut === undefined ||
      !history.source.complete ||
      history.operations
        .slice(0, cut.count)
        .some(
          (operation) =>
            operation.authority !== 'foreign' &&
            (operation.kind === 'mandate' ||
              operation.record?.kind === 'mandate' ||
              operation.claimedKinds.includes('mandate')),
        )
    )
      return refuse('Parent context succession requires complete child histories without mandates')
  }
  return { ok: true, value: undefined }
}
