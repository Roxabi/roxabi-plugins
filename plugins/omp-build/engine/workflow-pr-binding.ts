import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import {
  historyFor,
  type MandateRecord,
  type WorkflowBindingRecord,
  workflowOperationProblem,
} from './workflow-control.ts'
import { selectWorkflowBindingCandidate } from './workflow-pr-binding-chain.ts'

export function confirmedAccountedMandate(history: DecodedHistory, ref: ExternalRecordRef): MandateRecord | null {
  const matches = history.operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority === 'accounted' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === ref.recordId &&
      equalScope({ repository: operation.record.repository, target: operation.record.target }, ref.scope),
  )
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (matches.length === 0 || new Set(bodies).size !== 1) return null
  const record = matches[0]?.record
  return record?.kind === 'mandate' ? record : null
}

export type WorkflowBindingSelection =
  | {
      status: 'bound'
      binding: WorkflowBindingRecord
      mandate: ExternalRecordRef
      mandateRecord: MandateRecord
    }
  | { status: 'absent' }
  | { status: 'incomplete' | 'conflicting' | 'incompatible-format'; diagnostics: Diagnostic[] }

export function selectWorkflowBinding(input: {
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
}): WorkflowBindingSelection {
  const chained = selectWorkflowBindingCandidate(input)
  if (chained.status !== 'bound') return chained
  const home = historyFor(chained.binding.payload.mandate.scope, input.histories)
  if (home === null || !home.source.complete) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Binding mandate history is missing or incomplete')],
    }
  }
  const problem = workflowOperationProblem(home)
  if (problem === 'incompatible-format') {
    const formatDiagnostic = home.diagnostics.find((entry) => entry.code === problem)
    return {
      status: problem,
      diagnostics: [formatDiagnostic ?? diagnostic(problem, 'Binding mandate uses an incompatible format')],
    }
  }
  const mandateRecord = confirmedAccountedMandate(home, chained.binding.payload.mandate)
  if (mandateRecord === null) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Binding mandate record is not confirmed')],
    }
  }
  return {
    status: 'bound',
    binding: chained.binding,
    mandate: chained.binding.payload.mandate,
    mandateRecord,
  }
}
