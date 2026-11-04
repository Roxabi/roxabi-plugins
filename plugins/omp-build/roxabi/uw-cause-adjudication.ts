import { createHash, randomUUID } from 'node:crypto'
import {
  buildRecord,
  causeAdjudicationProposalSchema,
  type GitHubOptions,
  publishConfirmedWorkflowRecord,
  validateCauseAdjudication,
} from '../dist/contracts.js'
import type { CauseAdjudicationInput, CauseAdjudicationProposal } from '../engine/cause-disposition-schema.ts'
import type { ObservationRef } from '../engine/criterion-evidence-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import { publishAdjudicationSuccessor } from './uw-cause-adjudication-successor.ts'
import { type CauseRead, readAuthenticatedCause } from './uw-cause-read.ts'
import type { CauseOperationResult, OperatorPort, UwReadPort } from './uw-contract.ts'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function diagnostics(uw: Scope, errors: readonly { code: string; message?: string }[]): UwDiagnostic[] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message ?? error.code,
    location: { kind: 'native', uw, connection: 'state' },
    related: [],
  }))
}
function caught(uw: Scope, error: unknown): UwDiagnostic[] {
  return diagnostics(uw, [
    { code: 'cause-source-unavailable', message: error instanceof Error ? error.message : String(error) },
  ])
}

async function refreshAdjudication(
  input: { reader: UwReadPort; github: GitHubOptions },
  request: CauseAdjudicationInput,
  references: readonly ObservationRef[],
  proposal: CauseAdjudicationProposal,
) {
  const uw = request.pending.scope
  let fresh: CauseRead
  try {
    fresh = await readAuthenticatedCause(request.pending, input.reader, input.github, references)
  } catch (error) {
    return { ok: false as const, diagnostics: caught(uw, error) }
  }
  if (digest(fresh.disposition) !== proposal.pendingDigest)
    return { ok: false as const, diagnostics: diagnostics(uw, [{ code: 'cause-disposition-stale' }]) }
  const invalid = validateCauseAdjudication({
    proposal,
    pending: fresh.disposition,
    histories: fresh.histories,
    context: fresh.context,
  })
  return invalid.length
    ? { ok: false as const, diagnostics: diagnostics(uw, invalid) }
    : { ok: true as const, value: fresh }
}

/** Confirm one exact adjudication, persist its intent, then publish the assessed successor. */
export function createCauseAdjudication(input: {
  reader: UwReadPort
  github: GitHubOptions
  operator: OperatorPort
}): (request: CauseAdjudicationInput) => Promise<CauseOperationResult> {
  return async (raw) => {
    const request = structuredClone(raw)
    const references = [
      ...request.references,
      ...(request.judgment === null
        ? []
        : [
            ...request.judgment.necessary.references,
            ...request.judgment.urgent.references,
            ...request.judgment.tooLarge.references,
          ]),
    ]
    const uw = request.pending.scope
    let effectMayExist = false
    try {
      const current = await readAuthenticatedCause(request.pending, input.reader, input.github, references)
      if (current.disposition.payload.outcome.state !== 'pending-blocking')
        return { status: 'refused', diagnostics: diagnostics(uw, [{ code: 'cause-not-pending' }]) }
      const parsed = causeAdjudicationProposalSchema.safeParse({
        ...structuredClone(request),
        format: 'omp-build-cause-adjudication-proposal/1',
        operationId: `cause-${randomUUID()}`,
        operation: 'adjudicate-cause',
        uw,
        pendingDigest: digest(current.disposition),
      })
      if (!parsed.success)
        return { status: 'refused', diagnostics: diagnostics(uw, [{ code: 'cause-adjudication-proposal-invalid' }]) }
      const proposal = parsed.data
      const errors = validateCauseAdjudication({
        proposal,
        pending: current.disposition,
        histories: current.histories,
        context: current.context,
      })
      if (errors.length) return { status: 'refused', diagnostics: diagnostics(uw, errors) }
      const prepared = { proposal, digest: digest(proposal) }
      const confirmed = await input.operator.executeConfirmed(
        prepared,
        async (confirmation): Promise<CauseOperationResult> => {
          const refreshed = await refreshAdjudication(input, request, references, proposal)
          if (!refreshed.ok) return { status: 'refused', diagnostics: refreshed.diagnostics }
          const fresh = refreshed.value
          const intent = buildRecord({
            ...uw,
            version: 1,
            kind: 'cause-operation',
            recordId: `${proposal.operationId}:intent`,
            runId: proposal.operationId,
            operationId: `${proposal.operationId}:intent`,
            payload: { format: 'omp-build-cause-operation/1', proposal, proposalDigest: prepared.digest, confirmation },
          })
          if (!intent.ok) return { status: 'refused', diagnostics: diagnostics(uw, intent.diagnostics) }
          const own = fresh.histories.find(
            (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
          )
          if (!own) return { status: 'refused', diagnostics: diagnostics(uw, [{ code: 'cause-history-missing' }]) }
          effectMayExist = true
          const published = await publishConfirmedWorkflowRecord(
            intent.value,
            own,
            input.github,
            null,
            fresh.histories.filter((history) => history !== own),
          )
          if (published.status !== 'confirmed')
            return { status: 'partial', uw, diagnostics: diagnostics(uw, published.diagnostics) }
          return publishAdjudicationSuccessor({ input, fresh, uw, intent, request, proposal })
        },
      )
      return confirmed.status === 'confirmed'
        ? confirmed.value
        : { status: 'refused', diagnostics: confirmed.diagnostics }
    } catch (error) {
      return effectMayExist
        ? { status: 'partial', uw, diagnostics: caught(uw, error) }
        : { status: 'refused', diagnostics: caught(uw, error) }
    }
  }
}
