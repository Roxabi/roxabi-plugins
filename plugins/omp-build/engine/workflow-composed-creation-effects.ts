import type { CauseCreationProposal, ComposedParentConsent } from './cause-disposition-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { isWayfinder, scopeKey, type UwNativeNode, unknownWayfinderLabels } from './uw-graph.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'
import { issueFromScope, type NativeObservationReader, sameObservationValue } from './workflow-composed-observation.ts'
import { historyFor } from './workflow-control.ts'
import type { CreatedChildBinding } from './workflow-mandate-schema.ts'
import type { PreparedMaterialAcceptance } from './workflow-spec-assessment.ts'

export type CreationDeltaInput = {
  prepared: PreparedMaterialAcceptance
  before: UwCompletionObservation
  after: UwCompletionObservation
  operation: ExternalRecordRef
  binding: CreatedChildBinding
}

function sameHistoryWithIntent(before: DecodedHistory, after: DecodedHistory, operation: ExternalRecordRef): boolean {
  if (sameObservationValue(before, after)) return true
  if (!equalScope(before.source.scope, operation.scope)) return false
  const added = after.operations.filter(
    (entry) =>
      entry.recordId === operation.recordId &&
      entry.status === 'complete' &&
      entry.authority !== 'foreign' &&
      entry.record?.kind === 'cause-operation',
  )
  const [addition] = added
  if (added.length !== 1 || addition === undefined) return false
  const ids = new Set(addition.parts.map((part) => part.nativeId))
  const restored = {
    ...after,
    operations: after.operations.filter((entry) => entry !== addition),
    source: { ...after.source, comments: after.source.comments.filter((comment) => !ids.has(comment.nativeId)) },
  }
  return sameObservationValue(before, restored)
}

function expectedCreationNode(
  uw: Scope,
  oldNative: NativeIssueObservation,
  outer: CauseCreationProposal,
  consent: ComposedParentConsent,
  childIssue: NativeIssueObservation['issue'],
): NativeIssueObservation {
  const reparented = outer.writes.relations.addChildren
  const movesHere = reparented.some((child) => sameObservationValue(child, oldNative.issue))
  const children = oldNative.children.filter((child) => !reparented.some((moved) => sameObservationValue(child, moved)))
  if (equalScope(uw, consent.parent)) children.push(childIssue)
  const addsBlocker =
    outer.creation.kind === 'sister' &&
    outer.creation.relation === 'original-blocked-by-sister' &&
    equalScope(uw, outer.creation.original)
  return {
    ...oldNative,
    parent: movesHere ? childIssue : oldNative.parent,
    children,
    blockers: addsBlocker ? [...oldNative.blockers, childIssue] : oldNative.blockers,
  }
}

export class ComposedCreationEffects {
  constructor(
    private readonly input: CreationDeltaInput,
    private readonly native: NativeObservationReader,
  ) {}

  historyProblem(): string | null {
    const { before, after, operation, binding } = this.input
    for (const previous of before.histories) {
      const current = historyFor(previous.source.scope, after.histories)
      if (current === null || !sameHistoryWithIntent(previous, current, operation))
        return 'A previously observed history changed beyond the confirmed intent'
    }
    for (const current of after.histories) {
      if (
        historyFor(current.source.scope, before.histories) === null &&
        !equalScope(current.source.scope, binding.child)
      )
        return 'A new unrelated history appeared during creation'
    }
    return null
  }

  graphProblem(
    outer: CauseCreationProposal,
    consent: ComposedParentConsent,
    childIssue: NativeIssueObservation['issue'],
  ): string | null {
    const { before, after } = this.input
    for (const moved of outer.writes.relations.addChildren) {
      if (!before.graph.nodes.some((node) => sameObservationValue(issueFromScope(node.uw), moved)))
        return 'A child selected for attachment was not present in the complete before graph'
    }
    for (const previous of before.graph.nodes) {
      const current = after.graph.nodes.find((node) => equalScope(node.uw, previous.uw))
      const oldNative = this.native(previous)
      const newNative = current === undefined ? null : this.native(current)
      if (oldNative === null || newNative === null) return 'An existing graph node was not fully observed'
      const expected = expectedCreationNode(previous.uw, oldNative, outer, consent, childIssue)
      if (nativeObservationDigest(expected) !== nativeObservationDigest(newNative))
        return 'Native graph differs from the exact confirmed creation effects'
    }
    return null
  }

  parentChildrenProblem(afterNode: UwNativeNode | undefined): string | null {
    const { prepared, binding, after } = this.input
    const proposedChildren = prepared.proposal.exactInputs.proposed.children
      .map((child) => scopeKey('kind' in child ? binding.child : child.scope))
      .sort()
    if (afterNode === undefined) return 'Confirmed parent native readback is unavailable'
    const actualChildren: string[] = []
    for (const scope of afterNode.children) {
      const node = after.graph.nodes.find((item) => equalScope(item.uw, scope))
      if (node === undefined || unknownWayfinderLabels(node).length !== 0)
        return 'Parent child classification is incomplete or unknown'
      if (!isWayfinder(node)) actualChildren.push(scopeKey(scope))
    }
    actualChildren.sort()
    return sameObservationValue(proposedChildren, actualChildren)
      ? null
      : 'Confirmed proposed parent children do not match native creation readback'
  }

  newNativeProblem(): string | null {
    const { before, after, binding } = this.input
    for (const current of after.graph.nodes) {
      if (!equalScope(current.uw, binding.child) && !before.graph.nodes.some((node) => equalScope(node.uw, current.uw)))
        return 'A new unrelated native graph node appeared during creation'
    }
    const actualChild = after.graph.nodes.find((node) => equalScope(node.uw, binding.child))
    const actual = actualChild === undefined ? null : this.native(actualChild)
    return actual === null || nativeObservationDigest(actual) !== nativeObservationDigest(binding.observed)
      ? 'Created child binding is not the observed native readback'
      : null
  }
}
