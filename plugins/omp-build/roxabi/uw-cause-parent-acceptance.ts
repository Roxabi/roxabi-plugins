import {
  bindExternalRef,
  type GitHubOptions,
  nativeObservationDigest,
  publishConfirmedWorkflowRecord,
  readUwCompletionObservation,
  recheckComposedParentAcceptance,
  resolveAcceptedSpec,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { CreatedChildBinding } from '../engine/workflow-mandate-schema.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import { defaultGh } from './feature-engine.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { CreatedUwRead } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'

function sameHistoryAfterControl(before: DecodedHistory, after: DecodedHistory, recordId: string): boolean {
  const added = after.operations.filter(
    (operation) =>
      operation.recordId === recordId &&
      operation.kind === 'operator-control' &&
      operation.status === 'complete' &&
      operation.authority !== 'foreign',
  )
  const [addedControl] = added
  if (added.length !== 1 || addedControl === undefined) return false
  const nativeIds = new Set(addedControl.parts.map((part) => part.nativeId))
  const restored = {
    ...after,
    operations: after.operations.filter((operation) => operation !== addedControl),
    source: { ...after.source, comments: after.source.comments.filter((comment) => !nativeIds.has(comment.nativeId)) },
  }
  return JSON.stringify(before) === JSON.stringify(restored)
}

function nativeDigest(uw: Scope, observation: UwCompletionObservation): string {
  const value = rootObservation(uw, { graph: observation.graph })
  return nativeObservationDigest({
    ...value,
    labels: [...value.labels],
    children: [...value.children],
    blockers: [...value.blockers],
  })
}

function verifyReadback(
  after: Extract<UwCompletionObservation, { status: 'complete' }>,
  final: Extract<UwCompletionObservation, { status: 'complete' }>,
  prepared: PreparedMaterialAcceptance,
  recordId: string,
): void {
  if (after.histories.length !== final.histories.length || after.graph.nodes.length !== final.graph.nodes.length)
    throw new Error('parent-acceptance-readback-stale')
  for (const history of after.histories) {
    const current = final.histories.find(
      (item) =>
        item.source.scope.repository === history.source.scope.repository &&
        item.source.scope.target === history.source.scope.target,
    )
    if (
      current === undefined ||
      (history.source.scope.repository === prepared.proposal.uw.repository &&
      history.source.scope.target === prepared.proposal.uw.target
        ? !sameHistoryAfterControl(history, current, recordId)
        : JSON.stringify(history) !== JSON.stringify(current))
    )
      throw new Error('parent-acceptance-readback-stale')
  }
  for (const node of after.graph.nodes)
    if (
      !final.graph.nodes.some(
        (item) => item.uw.repository === node.uw.repository && item.uw.target === node.uw.target,
      ) ||
      nativeDigest(node.uw, after) !== nativeDigest(node.uw, final)
    )
      throw new Error('parent-acceptance-readback-stale')
}

function createdChildBinding(child: CreatedUwRead, createOperationId: string): CreatedChildBinding {
  if (
    !child.identity.ok ||
    child.identity.value.head === null ||
    child.identity.value.head.kind !== 'spec-identity' ||
    child.parsed.status !== 'conformant'
  )
    throw new Error('created-child-identity-unavailable')
  const observed = rootObservation(child.uw, child)
  return {
    slot: { kind: 'created-by', operationId: createOperationId },
    child: child.uw,
    identity: { ...child.identity.value.head, kind: 'spec-identity' },
    observed: {
      ...observed,
      labels: [...observed.labels],
      children: [...observed.children],
      blockers: [...observed.blockers],
    },
    snapshot: child.parsed.snapshot,
  }
}

/** Publish and read back the exact internal parent control bound to the actually created child. */
export async function acceptCreatedCauseChild(input: {
  github: GitHubOptions
  prepared: PreparedMaterialAcceptance
  before: Extract<UwCompletionObservation, { status: 'complete' }>
  createOperationId: string
  operation: ExternalRecordRef & { kind: 'cause-operation' }
  child: CreatedUwRead
  signal: AbortSignal
}): Promise<void> {
  const { child, before, prepared } = input
  const binding = createdChildBinding(child, input.createOperationId)
  const seeds: Scope[] = [...before.graph.nodes.map((node) => node.uw), child.uw]
  const read = () =>
    readUwCompletionObservation(
      prepared.proposal.uw,
      input.github,
      (histories) =>
        loadReviewClassCatalogues({ histories, cwd: input.github.cwd, gh: input.github.gh ?? defaultGh() }),
      seeds,
    )
  const after = await read()
  if (after.status !== 'complete') throw new Error('parent-acceptance-observation-incomplete')
  const checked = recheckComposedParentAcceptance({ prepared, before, after, operation: input.operation, binding })
  if (!checked.ok) throw new Error(checked.diagnostics.map((item) => item.code).join(',') || 'parent-acceptance-stale')
  if (input.signal.aborted) throw new Error('parent-acceptance-cancelled')
  const published = await publishConfirmedWorkflowRecord(
    checked.value,
    input.github,
    createPublicationContextResolver(input.github, null),
    after.histories,
  )
  if (published.status !== 'confirmed')
    throw new Error(published.diagnostics.map((item) => item.code).join(',') || 'parent-acceptance-unconfirmed')
  const final = await read()
  if (final.status !== 'complete') throw new Error('parent-acceptance-readback-incomplete')
  const own = final.histories.find(
    (history) =>
      history.source.scope.repository === prepared.proposal.uw.repository &&
      history.source.scope.target === prepared.proposal.uw.target,
  )
  const controlRef = {
    scope: prepared.proposal.uw,
    recordId: checked.value.recordId,
    kind: 'operator-control' as const,
  }
  const bound = own === undefined ? null : bindExternalRef(controlRef, own)
  if (bound === null || !bound.ok || JSON.stringify(bound.value) !== JSON.stringify(checked.value))
    throw new Error('parent-acceptance-readback-unconfirmed')
  verifyReadback(after, final, prepared, checked.value.recordId)
  const mandate = own === undefined ? null : bindExternalRef({ ...prepared.proposal.mandate, kind: 'mandate' }, own)
  if (mandate === null || !mandate.ok || mandate.value.kind !== 'mandate')
    throw new Error('parent-mandate-readback-unconfirmed')
  const accepted = resolveAcceptedSpec(mandate.value, final.histories)
  if (
    !accepted.ok ||
    accepted.spec.chain.at(-1)?.source.recordId !== checked.value.recordId ||
    accepted.spec.chain.at(-1)?.source.kind !== 'operator-control'
  )
    throw new Error('parent-acceptance-authority-unconfirmed')
}
