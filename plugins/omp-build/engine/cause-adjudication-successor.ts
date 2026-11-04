import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import { validateCauseAdjudication } from './cause-adjudication.ts'
import { assessValidatedCauseDispositions } from './cause-assessment.ts'
import type { CauseAdjudicationProposal, CauseDispositionPayload } from './cause-disposition-schema.ts'
import { causeDispositionLineage } from './cause-lineage.ts'
import { type CauseValidationFrame, causeValidationFrame } from './cause-validation-frame.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { bindExternalRef } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Input = { pending: Disposition; operation: Operation; histories: readonly DecodedHistory[]; context: CauseContext }
const failure = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('cause-chain-invalid', message)],
})

function authenticated(input: Input, frame: CauseValidationFrame): Result<null> {
  const { pending, operation, histories, context } = input
  const confirmationKey = canonicalValueDigest([pending, operation, context])
  if (frame.confirmations.has(confirmationKey)) return { ok: true, value: null }
  const history = histories.find((item) => equalScope(item.source.scope, context.original))
  if (!history || !equalScope(pending, context.original) || !equalScope(operation, context.original))
    return failure('Adjudication scope is not authenticated')
  const op = bindExternalRef(
    { scope: context.original, kind: 'cause-operation', recordId: operation.recordId },
    history,
  )
  const proposal = operation.payload.proposal
  if (
    !op.ok ||
    canonicalValueDigest(op.value) !== canonicalValueDigest(operation) ||
    proposal.operation !== 'adjudicate-cause'
  )
    return failure('Adjudication operation is not authenticated')
  const digest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  if (
    operation.payload.proposalDigest !== digest ||
    operation.payload.confirmation.proposalDigest !== digest ||
    operation.payload.confirmation.operationId !== proposal.operationId
  )
    return failure('Adjudication confirmation is not bound')
  const evidenceKey = canonicalValueDigest([proposal, pending, context])
  const errors =
    frame.adjudications.get(evidenceKey) ?? validateCauseAdjudication({ proposal, pending, histories, context })
  frame.adjudications.set(evidenceKey, errors)
  if (errors.length) return { ok: false, diagnostics: [...errors] }
  frame.confirmations.add(confirmationKey)
  return { ok: true, value: null }
}

function assessCause(
  input: Input,
  historical: boolean,
  prefix: readonly CauseAdjudicationProposal[],
  frame: CauseValidationFrame,
): Result<CauseDispositionPayload> {
  const subject = input.pending.payload.subject
  if (subject.kind !== 'cause') return failure('Cause subject is unavailable')
  const history = input.histories.find((item) => equalScope(item.source.scope, subject.decision.scope))
  const decision = history && bindExternalRef(subject.decision, history)
  if (!decision?.ok || decision.value.kind !== 'decision') return failure('Cause decision is not authenticated')
  const assessed = assessValidatedCauseDispositions(
    {
      context: input.context,
      source: { kind: 'decision', decision: decision.value },
      histories: input.histories,
      adjudications: [input.operation],
    },
    historical,
    prefix,
    frame,
  )
  if (!assessed.ok) return assessed
  const matches = assessed.value.outcomes.filter(
    (outcome) =>
      outcome.previous?.recordId === input.pending.recordId &&
      outcome.adjudication?.recordId === input.operation.recordId,
  )
  return matches.length === 1 && matches[0] !== undefined
    ? { ok: true, value: matches[0] }
    : failure('Exact adjudication successor could not be assessed')
}

function assessAuthenticatedTransition(
  input: Input,
  historical: boolean,
  prefix: readonly CauseAdjudicationProposal[],
  frame: CauseValidationFrame,
): Result<CauseDispositionPayload> {
  const proposal = input.operation.payload.proposal
  if (proposal.operation !== 'adjudicate-cause') return failure('Operation is not an adjudication')
  if (input.pending.payload.subject.kind === 'cause') return assessCause(input, historical, prefix, frame)
  return {
    ok: true,
    value: {
      ...input.pending.payload,
      previous: proposal.pending,
      adjudication: { scope: input.context.original, kind: 'cause-operation', recordId: input.operation.recordId },
      outcome: { state: 'final', disposition: 'report', blocking: false, reason: proposal.reason },
    },
  }
}

function assessTransition(
  input: Input,
  historical: boolean,
  prefix: readonly CauseAdjudicationProposal[],
  frame: CauseValidationFrame,
): Result<CauseDispositionPayload> {
  const key = canonicalValueDigest([input.pending, input.operation, input.context, historical])
  const cached = frame.transitions.get(key)
  if (cached) return cached
  const confirmed = authenticated(input, frame)
  if (!confirmed.ok) return confirmed
  const result = assessAuthenticatedTransition(input, historical, prefix, frame)
  frame.transitions.set(key, result)
  return result
}

function assessSuccessor(
  input: Input,
  historical: boolean,
  frame: CauseValidationFrame,
): Result<CauseDispositionPayload> {
  const auth = authenticated(input, frame)
  if (!auth.ok) return auth
  const cached = frame.transitions.get(
    canonicalValueDigest([input.pending, input.operation, input.context, historical]),
  )
  if (cached) return cached
  const history = input.histories.find((item) => equalScope(item.source.scope, input.context.original))
  if (!history) return failure('Adjudication history is missing')
  const lineage = causeDispositionLineage({ head: input.pending, history })
  if (!lineage.ok) return lineage
  const prefix: CauseAdjudicationProposal[] = []
  for (let index = 1; index < lineage.value.length; index++) {
    const current = lineage.value[index]
    const previous = lineage.value[index - 1]
    if (!current?.adjudication || !previous) return failure('Prior transition is missing')
    const transition = { ...input, pending: previous.disposition, operation: current.adjudication }
    const assessed = assessTransition(transition, historical, prefix, frame)
    if (!assessed.ok) return assessed
    if (canonicalValueDigest(assessed.value) !== canonicalValueDigest(current.disposition.payload))
      return failure('Prior successor differs from its assessment')
    const proposal = current.adjudication.payload.proposal
    if (proposal.operation !== 'adjudicate-cause') return failure('Prior operation is not an adjudication')
    prefix.push(proposal)
  }
  return assessTransition(input, historical, prefix, frame)
}

export function assessAdjudicationSuccessor(input: Input): Result<CauseDispositionPayload> {
  return assessSuccessor(input, false, causeValidationFrame(input.histories))
}

export function assessHistoricalAdjudicationSuccessor(
  input: Input,
  frame: CauseValidationFrame,
): Result<CauseDispositionPayload> {
  return assessSuccessor(input, true, frame)
}
