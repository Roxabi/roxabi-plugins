import type { DecodedHistory } from './history-schema.ts'
import {
  abandoned,
  bindExternalRef,
  type ControlRecord,
  childPermitted,
  historyFor,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  refused,
  successorOf,
  unliftedPause,
  workflowOperationProblem,
} from './workflow-control.ts'
import { executableGraph } from './workflow-graph.ts'
import type { MandateSelection } from './workflow-mandate.ts'
import { epicParentProblem } from './workflow-parent.ts'
import { diagnostic, equalScope, sameRef } from './workflow-support.ts'

function cycleRefusal(history: DecodedHistory, seen: ReadonlySet<string>): MandateSelection | null {
  const scopeKey = `${history.source.scope.repository}\0${history.source.scope.target}`
  return seen.has(scopeKey) ? refused('ambiguous', [diagnostic('ambiguous', 'Mandate parent chain cycles')]) : null
}

function historyRefusal(history: DecodedHistory): MandateSelection | null {
  const problem = workflowOperationProblem(history)
  if (problem !== null && mandatesOf(history).length === 0 && problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  if (problem === 'ambiguous') return refused('ambiguous', [diagnostic('ambiguous', 'Workflow history conflicts')])
  if (problem === 'unconfirmed')
    return refused('unconfirmed', [diagnostic('unconfirmed', 'Workflow history has an incomplete operation')])
  if (problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  return null
}

function noMandateRefusal(history: DecodedHistory): MandateSelection {
  const claimed = history.operations.some(
    (operation) => operation.kind === 'mandate' || operation.claimedKinds.includes('mandate'),
  )
  return claimed
    ? refused('unconfirmed', [diagnostic('unconfirmed', 'A mandate was claimed but not confirmed')])
    : refused('missing', [diagnostic('missing', 'No mandate record exists')])
}

function selectedMandate(history: DecodedHistory): MandateRecord | MandateSelection {
  const mandates = mandatesOf(history)
  if (mandates.length === 0) return noMandateRefusal(history)
  const active = mandates.filter((mandate) => !abandoned(history, mandate) && successorOf(history, mandate) === null)
  if (active.length === 0) {
    const last = mandates[mandates.length - 1]
    if (last !== undefined && abandoned(history, last))
      return refused('abandoned', [diagnostic('abandoned', `Mandate ${last.recordId} is abandoned`)])
    return refused('revoked', [diagnostic('revoked', 'The mandate was superseded')])
  }
  if (active.length > 1) return refused('ambiguous', [diagnostic('ambiguous', 'More than one mandate is active')])
  const mandate = active[0]
  if (mandate === undefined) return refused('missing', [diagnostic('missing', 'No mandate record exists')])
  if (abandoned(history, mandate))
    return refused('abandoned', [diagnostic('abandoned', `Mandate ${mandate.recordId} is abandoned`)])
  return mandate
}

function pauseRefusal(mandate: MandateRecord, pause: ControlRecord): MandateSelection {
  return {
    status: 'refused',
    reason: 'paused',
    evidence: [diagnostic('paused', `Mandate ${mandate.recordId} is paused`)],
    pause: {
      mandate: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' },
      confirmation: {
        scope: { repository: pause.repository, target: pause.target },
        recordId: pause.recordId,
        kind: 'operator-control',
      },
    },
  }
}

function parentPolicyRefusal(
  mandate: MandateRecord,
  parent: MandateRecord,
  parentHistory: DecodedHistory,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
): MandateSelection | null {
  if (
    parent.payload.role === 'epic' &&
    !childPermitted(parent, mandateScope(mandate), [parentHistory, history, ...externalHistories])
  )
    return refused('unknown-binding', [diagnostic('unknown-binding', 'Child scope is not approved')])
  if (mandate.payload.permissions.landing && !parent.payload.permissions.landing)
    return refused('incompatible', [diagnostic('incompatible', 'Child landing exceeds the parent')])
  if (mandate.payload.permissions.correct && !parent.payload.permissions.correct)
    return refused('incompatible', [diagnostic('incompatible', 'Child correction exceeds the parent')])
  if (parent.payload.role !== 'epic') return null
  const approved = parent.payload.children.find((child) => equalScope(child.scope, mandateScope(mandate)))
  if (approved !== undefined && mandate.payload.spec.bodySha256 !== approved.specDigest) {
    return refused('materially-changed', [
      diagnostic('materially-changed', 'Child spec digest differs from the approved snapshot'),
    ])
  }
  return null
}

function parentAdmission(
  mandate: MandateRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  seen: ReadonlySet<string>,
): MandateSelection | null {
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, externalHistories)
  if (parentHistory === null)
    return refused('incomplete', [diagnostic('missing-history', 'Parent mandate history is missing')])
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok) return refused('incomplete', parent.diagnostics)
  if (parent.value.kind !== 'mandate')
    return refused('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
  const parentSelection = selectApplicableMandate(parentHistory, externalHistories, seen)
  if (parentSelection.status === 'refused') return parentSelection
  if (
    !sameRef(
      { scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: 'mandate' },
      mandate.payload.parent,
    )
  ) {
    return refused('revoked', [diagnostic('revoked', 'Child parent reference does not name the active parent mandate')])
  }
  const policy = parentPolicyRefusal(mandate, parent.value, parentHistory, history, externalHistories)
  return policy
}

function mandateAdmission(
  mandate: MandateRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  seen: ReadonlySet<string>,
): MandateSelection {
  const pause = unliftedPause(history, mandate)
  if (pause !== null) return pauseRefusal(mandate, pause)
  const graph = executableGraph(mandate)
  if (!graph.ok) return refused('unsupported', graph.diagnostics)
  const omission = epicParentProblem(mandate, [history, ...externalHistories])
  if (omission !== null) return refused(omission.reason, omission.evidence)
  const parent = parentAdmission(mandate, history, externalHistories, seen)
  return parent ?? { status: 'applicable', mandate }
}

export function selectApplicableMandate(
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[] = [],
  seen: ReadonlySet<string> = new Set(),
): MandateSelection {
  const cycle = cycleRefusal(history, seen)
  if (cycle !== null) return cycle
  const historyProblem = historyRefusal(history)
  if (historyProblem !== null) return historyProblem
  const selected = selectedMandate(history)
  if ('status' in selected) return selected
  const nextSeen = new Set(seen)
  nextSeen.add(`${history.source.scope.repository}\0${history.source.scope.target}`)
  return mandateAdmission(selected, history, externalHistories, nextSeen)
}
