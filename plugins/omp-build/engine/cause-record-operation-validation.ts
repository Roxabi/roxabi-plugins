import { createHash } from 'node:crypto'
import { validateCauseAdjudication } from './cause-adjudication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Proposal = Operation['payload']['proposal']

function validateConfirmation(operation: Operation, confirmations: Set<string>, diagnostics: Diagnostic[]): void {
  const payload = operation.payload
  const digest = createHash('sha256').update(JSON.stringify(payload.proposal)).digest('hex')
  if (
    payload.proposalDigest !== digest ||
    payload.confirmation.proposalDigest !== digest ||
    payload.confirmation.operationId !== payload.proposal.operationId
  )
    diagnostics.push(
      diagnostic(
        'cause-operation-confirmation-mismatch',
        `Operation ${operation.recordId} does not bind the exact confirmed proposal`,
      ),
    )
  const key = payload.confirmation.operationId
  if (confirmations.has(key)) diagnostics.push(diagnostic('cause-confirmation-reused', `Confirmation ${key} is reused`))
  confirmations.add(key)
}

function validateAdjudication(
  operation: Operation,
  proposal: Extract<Proposal, { operation: 'adjudicate-cause' }>,
  disposition: Disposition,
  sourceHistory: DecodedHistory,
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): void {
  const effective = recordsOf(sourceHistory).flatMap((candidate) => {
    if (candidate.kind !== 'mandate') return []
    const accepted = resolveAcceptedSpec(candidate, histories)
    if (!accepted.ok || !sameOwnSpecRef(accepted.spec.ref, disposition.payload.origin)) return []
    const projected = resolveOwnSpecEffective(accepted.spec)
    return projected.ok ? [projected.value] : []
  })
  if (effective.length !== 1 || effective[0] === undefined)
    diagnostics.push(diagnostic('cause-origin-unconfirmed', `Operation ${operation.recordId} lacks its accepted Spec`))
  else
    diagnostics.push(
      ...validateCauseAdjudication({
        proposal,
        pending: disposition,
        histories,
        context: { original: disposition.payload.origin.uw, effective: effective[0] },
      }),
    )
}

function sisterMatches(
  creation: Extract<Exclude<Proposal, { operation: 'adjudicate-cause' }>['creation'], { kind: 'sister' }>,
  disposition: Disposition,
): boolean {
  const outcome = disposition.payload.outcome
  if (outcome.state !== 'final' || disposition.payload.subject.kind !== 'cause') return false
  if (outcome.disposition !== 'sister-blocking' && outcome.disposition !== 'sister-after') return false
  return (
    equalScope(creation.original, disposition) &&
    creation.relation ===
      (outcome.disposition === 'sister-blocking' ? 'original-blocked-by-sister' : 'sister-blocked-by-original')
  )
}

function validateCreation(
  operation: Operation,
  proposal: Exclude<Proposal, { operation: 'adjudicate-cause' }>,
  disposition: Disposition,
  diagnostics: Diagnostic[],
): void {
  const creation = proposal.creation
  const expectedDigest = creation.kind === 'sister' ? creation.dispositionDigest : creation.reportDigest
  if (
    createHash('sha256').update(JSON.stringify(disposition)).digest('hex') !== expectedDigest ||
    disposition.payload.outcome.state !== 'final' ||
    (creation.kind === 'sister'
      ? !sisterMatches(creation, disposition)
      : disposition.payload.outcome.disposition !== 'report')
  )
    diagnostics.push(
      diagnostic(
        'cause-operation-source-mismatch',
        `Operation ${operation.recordId} does not match its final disposition`,
      ),
    )
}

export function validateCauseOperations(
  operations: readonly Operation[],
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): void {
  const confirmations = new Set<string>()
  for (const operation of operations) {
    validateConfirmation(operation, confirmations, diagnostics)
    const proposal = operation.payload.proposal
    const sourceRef =
      proposal.operation === 'adjudicate-cause'
        ? proposal.pending
        : proposal.creation.kind === 'sister'
          ? proposal.creation.disposition
          : proposal.creation.report
    const sourceHistory = histories.find((history) => equalScope(history.source.scope, sourceRef.scope))
    const source = sourceHistory && bindExternalRef(sourceRef, sourceHistory)
    if (
      !sourceHistory ||
      !source?.ok ||
      source.value.kind !== 'cause-disposition' ||
      !equalScope(operation, sourceRef.scope)
    ) {
      diagnostics.push(
        diagnostic(
          'cause-operation-source-unconfirmed',
          `Operation ${operation.recordId} lacks its original disposition`,
        ),
      )
      continue
    }
    if (proposal.operation === 'adjudicate-cause')
      validateAdjudication(operation, proposal, source.value, sourceHistory, histories, diagnostics)
    else validateCreation(operation, proposal, source.value, diagnostics)
  }
}
