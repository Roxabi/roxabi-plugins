import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import { validateCauseAdjudication } from './cause-adjudication.ts'
import type { Ref } from './cause-disposition.ts'
import type { CauseAdjudicationProposal } from './cause-disposition-schema.ts'
import { causeDispositionLineage } from './cause-lineage.ts'
import type { CauseValidationFrame } from './cause-validation-frame.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { Cause, CauseJudgment, FinalFinding } from './review-schema.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Input = {
  context: CauseContext
  histories: readonly DecodedHistory[]
  adjudications: readonly Operation[]
  cause: Cause
  findings: FinalFinding[]
  decisionRef: Ref<'decision'>
  validatedPrefix?: readonly CauseAdjudicationProposal[]
  validationFrame?: CauseValidationFrame
}
type Assessment = {
  effectiveJudgment: CauseJudgment
  effectiveFindings: FinalFinding[]
  predecessor: Ref<'cause-disposition'> | null
  adjudication: Ref<'cause-operation'> | null
  localDiagnostics: Diagnostic[]
}
type Confirmed = { pending: Disposition; proposal: CauseAdjudicationProposal; opRef: Ref<'cause-operation'> }

function findCandidates(input: Input, records: readonly CanonicalRecord[]): Operation[] {
  return input.adjudications.filter((item) => {
    const proposal = item.payload.proposal
    if (proposal.operation !== 'adjudicate-cause') return false
    const pending = records.find(
      (entry) => entry.kind === 'cause-disposition' && entry.recordId === proposal.pending.recordId,
    )
    return (
      pending?.kind === 'cause-disposition' &&
      pending.payload.subject.kind === 'cause' &&
      sameRef(pending.payload.subject.decision, input.decisionRef) &&
      pending.payload.subject.cause.id === input.cause.id
    )
  })
}

function authenticateOperation(input: Input, operation: Operation, history: DecodedHistory): Result<Confirmed> {
  const proposal = operation.payload.proposal
  if (proposal.operation !== 'adjudicate-cause')
    return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Operation is not an adjudication')] }
  const opRef: Ref<'cause-operation'> = {
    scope: input.context.original,
    recordId: operation.recordId,
    kind: 'cause-operation',
  }
  const pending = bindExternalRef(proposal.pending, history)
  if (
    pending.ok &&
    pending.value.kind === 'cause-disposition' &&
    input.validationFrame?.confirmations.has(canonicalValueDigest([pending.value, operation, input.context]))
  )
    return { ok: true, value: { pending: pending.value, proposal, opRef } }
  const authenticated = bindExternalRef(opRef, history)
  const digest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  if (
    !authenticated.ok ||
    JSON.stringify(authenticated.value) !== JSON.stringify(operation) ||
    !pending.ok ||
    pending.value.kind !== 'cause-disposition' ||
    operation.payload.proposalDigest !== digest ||
    operation.payload.confirmation.proposalDigest !== digest ||
    operation.payload.confirmation.operationId !== proposal.operationId
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('cause-adjudication-unconfirmed', `Cause ${input.cause.id} adjudication is not authenticated`),
      ],
    }
  return { ok: true, value: { pending: pending.value, proposal, opRef } }
}

function validateSnapshot(input: Input, current: Confirmed, records: readonly CanonicalRecord[]): Diagnostic[] {
  const { pending, proposal, opRef } = current
  const evidenceKey = canonicalValueDigest([proposal, pending, input.context])
  const existing = input.validationFrame?.adjudications.get(evidenceKey)
  const errors = existing
    ? [...existing]
    : validateCauseAdjudication({ proposal, pending, histories: input.histories, context: input.context })
  if (!existing) input.validationFrame?.adjudications.set(evidenceKey, [...errors])
  if (
    pending.payload.subject.kind !== 'cause' ||
    canonicalValueDigest(pending.payload.subject.cause) !== canonicalValueDigest(input.cause) ||
    canonicalValueDigest(pending.payload.subject.findings) !== canonicalValueDigest(input.findings) ||
    !sameOwnSpecRef(pending.payload.origin, input.context.effective.own)
  )
    errors.push(
      diagnostic('cause-adjudication-subject-mismatch', 'Pending snapshot differs from the immutable decision cause'),
    )
  const advanced = records.some(
    (entry) =>
      entry.kind === 'cause-disposition' &&
      entry.payload.previous !== null &&
      sameRef(entry.payload.previous, proposal.pending) &&
      (entry.payload.adjudication === null || !sameRef(entry.payload.adjudication, opRef)),
  )
  if (advanced) errors.push(diagnostic('cause-adjudication-stale', 'Pending disposition already has a successor'))
  return errors
}

function validatedChain(
  input: Input,
  current: Confirmed,
  history: DecodedHistory,
): Result<CauseAdjudicationProposal[]> {
  if (input.validatedPrefix !== undefined) return { ok: true, value: [...input.validatedPrefix, current.proposal] }
  const lineage = causeDispositionLineage({ head: current.pending, history })
  if (!lineage.ok) return lineage
  const chain: CauseAdjudicationProposal[] = []
  for (let index = 1; index < lineage.value.length; index++) {
    const member = lineage.value[index]
    const previous = lineage.value[index - 1]
    const proposal = member?.adjudication?.payload.proposal
    if (!previous || proposal?.operation !== 'adjudicate-cause')
      return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Prior operation is not an adjudication')] }
    const errors = validateCauseAdjudication({
      proposal,
      pending: previous.disposition,
      histories: input.histories,
      context: input.context,
    })
    if (errors.length) return { ok: false, diagnostics: errors }
    chain.push(proposal)
  }
  chain.push(current.proposal)
  return { ok: true, value: chain }
}

export function assessCauseAdjudication(input: Input): Assessment {
  const initial: Assessment = {
    effectiveJudgment: input.cause.judgment,
    effectiveFindings: input.findings,
    predecessor: null,
    adjudication: null,
    localDiagnostics: [],
  }
  const history = input.histories.find((item) => equalScope(item.source.scope, input.context.original))
  const records = history ? recordsOf(history) : []
  const candidates = findCandidates(input, records)
  if (candidates.length > 1)
    return {
      ...initial,
      localDiagnostics: [
        diagnostic('cause-adjudication-ambiguous', `Cause ${input.cause.id} has competing adjudications`),
      ],
    }
  const operation = candidates[0]
  if (!history || !operation) return initial
  const authenticated = authenticateOperation(input, operation, history)
  if (!authenticated.ok) return { ...initial, localDiagnostics: [...authenticated.diagnostics] }
  const current = authenticated.value
  const errors = validateSnapshot(input, current, records)
  const chain = validatedChain(input, current, history)
  if (!chain.ok) errors.push(...chain.diagnostics)
  if (errors.length || !chain.ok) return { ...initial, localDiagnostics: errors }
  let effectiveFindings = input.findings
  let effectiveJudgment = input.cause.judgment
  for (const step of chain.value) {
    effectiveFindings = effectiveFindings.filter((finding) => !step.rejectedFindingIds.includes(finding.id))
    if (step.judgment !== null) effectiveJudgment = step.judgment
  }
  return {
    effectiveJudgment,
    effectiveFindings,
    predecessor: current.proposal.pending,
    adjudication: current.opRef,
    localDiagnostics: [],
  }
}
