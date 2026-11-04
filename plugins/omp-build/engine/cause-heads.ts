import { canonicalValueDigest } from './action-input.ts'
import { blockingLabels } from './cause-assessment.ts'
import { causeDispositionLineage } from './cause-lineage.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef, recordsOf, workflowOperationProblem } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type State = {
  history: DecodedHistory
  scope: Scope
  initial: Set<string>
  successors: Set<string>
  adjudications: Set<string>
  diagnostics: Diagnostic[]
}

function validateMotivation(record: Disposition, operation: Operation, diagnostics: Diagnostic[]): void {
  const proposal = operation.payload.proposal
  if (proposal.operation !== 'adjudicate-cause') return
  const subject = record.payload.subject
  const invalidMembers =
    subject.kind === 'rule-error'
      ? proposal.rejectedFindingIds.length !== 0 || proposal.judgment !== null
      : subject.kind === 'retained-finding'
        ? proposal.rejectedFindingIds.length !== 1 ||
          proposal.rejectedFindingIds[0] !== subject.finding.id ||
          proposal.judgment !== null
        : (proposal.rejectedFindingIds.length === 0 && proposal.judgment === null) ||
          new Set(proposal.rejectedFindingIds).size !== proposal.rejectedFindingIds.length ||
          proposal.rejectedFindingIds.some((id) => !subject.findings.some((finding) => finding.id === id))
  if (proposal.reason.trim() === '' || proposal.references.length === 0 || invalidMembers)
    diagnostics.push(
      diagnostic(
        'cause-adjudication-motivation',
        `Disposition ${record.recordId} has an invalid motivated adjudication`,
      ),
    )
}

function validateSurvivors(
  record: Disposition,
  lineage: readonly { disposition: Disposition; adjudication: Operation | null }[],
  diagnostics: Diagnostic[],
): void {
  const subject = record.payload.subject
  if (subject.kind !== 'cause') return
  const rejected = new Set<string>()
  let judgment = subject.cause.judgment
  for (const member of lineage) {
    const proposal = member.adjudication?.payload.proposal
    if (proposal?.operation !== 'adjudicate-cause') continue
    for (const id of proposal.rejectedFindingIds) rejected.add(id)
    judgment = proposal.judgment ?? judgment
  }
  const blocking = subject.findings.some(
    (finding) => !rejected.has(finding.id) && (finding.label === null || blockingLabels.has(finding.label)),
  )
  const supported = [judgment.necessary, judgment.urgent, judgment.tooLarge].every(
    (value) => value.state === 'supported' && value.reason.trim() !== '' && value.references.length > 0,
  )
  if (
    blocking &&
    record.payload.outcome.state === 'final' &&
    (!supported ||
      judgment.necessary.value !== true ||
      judgment.urgent.value !== true ||
      record.payload.outcome.disposition !== (judgment.tooLarge.value ? 'sister-blocking' : 'fix-original'))
  )
    diagnostics.push(
      diagnostic('cause-outcome-mismatch', `Disposition ${record.recordId} cannot clear a surviving blocking member`),
    )
}

function validateSuccessor(record: Disposition, state: State): void {
  const previous = record.payload.previous
  if (previous === null) return
  if (state.successors.has(previous.recordId))
    state.diagnostics.push(
      diagnostic('cause-chain-competing', `Disposition ${record.recordId} has a competing successor`),
    )
  state.successors.add(previous.recordId)
  const operationRef = record.payload.adjudication
  if (operationRef !== null) {
    if (state.adjudications.has(operationRef.recordId))
      state.diagnostics.push(diagnostic('cause-confirmation-reused', `Adjudication ${operationRef.recordId} is reused`))
    state.adjudications.add(operationRef.recordId)
  }
  const lineage = causeDispositionLineage({ head: record, history: state.history })
  if (!lineage.ok) {
    state.diagnostics.push(...lineage.diagnostics)
    return
  }
  const last = lineage.value[lineage.value.length - 1]
  if (last?.adjudication) validateMotivation(record, last.adjudication, state.diagnostics)
  validateSurvivors(record, lineage.value, state.diagnostics)
}

function validateRecord(record: Disposition, state: State): void {
  const bound = bindExternalRef(
    { scope: state.scope, kind: 'cause-disposition', recordId: record.recordId },
    state.history,
  )
  if (!bound.ok) state.diagnostics.push(...bound.diagnostics)
  if (!equalScope(record.payload.origin.uw, state.scope))
    state.diagnostics.push(diagnostic('cause-origin-mismatch', `Disposition ${record.recordId} has a foreign origin`))
  if (record.payload.previous !== null) {
    validateSuccessor(record, state)
    return
  }
  const identity = canonicalValueDigest([record.payload.origin, record.payload.subject])
  if (state.initial.has(identity))
    state.diagnostics.push(diagnostic('cause-duplicate-initial', `Duplicate initial disposition ${record.recordId}`))
  state.initial.add(identity)
  if (record.payload.adjudication !== null)
    state.diagnostics.push(
      diagnostic('cause-chain-invalid', `Initial disposition ${record.recordId} has an adjudication`),
    )
}

export function readCauseDispositionHeads(input: {
  uw: Scope
  histories: readonly DecodedHistory[]
}): Result<readonly Disposition[]> {
  const histories = input.histories.filter((history) => equalScope(history.source.scope, input.uw))
  const history = histories[0]
  if (histories.length !== 1 || history === undefined || workflowOperationProblem(history) !== null)
    return {
      ok: false,
      diagnostics: [diagnostic('cause-history-unconfirmed', 'A unique complete authenticated UW history is required')],
    }
  const dispositions = recordsOf(history).filter((record): record is Disposition => record.kind === 'cause-disposition')
  const state: State = {
    history,
    scope: input.uw,
    initial: new Set(),
    successors: new Set(),
    adjudications: new Set(),
    diagnostics: [],
  }
  for (const record of dispositions) validateRecord(record, state)
  return state.diagnostics.length
    ? { ok: false, diagnostics: state.diagnostics }
    : { ok: true, value: dispositions.filter((record) => !state.successors.has(record.recordId)) }
}
