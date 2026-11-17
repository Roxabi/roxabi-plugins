import {
  admitContextSuccession,
  contextHandoffPrefixDigest,
  controlsOf,
  workflowOperationProblem,
} from '../dist/contracts.js'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { observeCurrentContextSuccession } from './feature-context-successor-observation.ts'

export function findSuccessionAdmission(
  source: Parameters<typeof observeCurrentContextSuccession>[0],
  ref: ScopedRecordRef,
) {
  const scope = source.authority.scope
  const issue = source.causal.histories.find(
    (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
  )
  if (issue === undefined) return { kind: 'refused' as const }
  const controls = controlsOf(issue).filter(
    (control) =>
      control.payload.control === 'select-successor' &&
      control.payload.contextDisposition !== undefined &&
      sameRef(control.payload.successor, ref),
  )
  if (controls.length === 0) return { kind: 'absent' as const }
  if (controls.length !== 1 || !completeCut(source)) return { kind: 'refused' as const }
  const control = controls[0]
  if (
    control === undefined ||
    control.payload.control !== 'select-successor' ||
    control.payload.contextDisposition === undefined
  )
    return { kind: 'refused' as const }
  const admitted = admitContextSuccession(control, source.causal.histories)
  if (!admitted.ok || admitted.value.successor.recordId !== source.mandate.recordId) return { kind: 'refused' as const }
  const historical = control.payload.contextDisposition.reconciliation
  const historyDigest = contextHandoffPrefixDigest(source.causal.histories, historical.cuts)
  if (historyDigest === null || historyDigest !== historical.historyDigest) return { kind: 'refused' as const }
  return { kind: 'ready' as const, issue, control, admitted, historical, historyDigest }
}

function completeCut(source: Parameters<typeof observeCurrentContextSuccession>[0]): boolean {
  return (
    source.causal.observation.status === 'complete' &&
    !source.causal.histories.some((history) => workflowOperationProblem(history) !== null)
  )
}
