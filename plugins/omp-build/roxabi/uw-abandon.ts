import { randomUUID } from 'node:crypto'
import {
  buildRecord,
  canonicalValueDigest,
  decodeHistory,
  type GitHubOptions,
  publishConfirmedWorkflowRecord,
  readGitHubHistory,
  selectRevocableMandate,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorPort, PreparedUwAbandon, UwOperationResult } from './uw-contract.ts'

type MandateRef = ExternalRecordRef & { kind: 'mandate' }

function problem(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

async function readRevocable(uw: Scope, options: GitHubOptions, exact?: MandateRef) {
  return selectRevocableMandate(decodeHistory(await readGitHubHistory(uw, options)), exact)
}

async function publishAbandonment(
  github: GitHubOptions,
  uw: Scope,
  proposal: PreparedUwAbandon['proposal'],
  publication: { mayExist: boolean },
  expectedMandate: MandateRef | undefined,
): Promise<UwOperationResult> {
  const current = await readRevocable(uw, github, expectedMandate)
  if (current.status !== 'applicable' || canonicalValueDigest(current.mandate) !== proposal.mandateDigest)
    return {
      status: 'refused',
      diagnostics: [problem(uw, 'proposal-stale', 'The exact mandate changed after confirmation')],
    }
  const record = buildRecord({
    ...uw,
    version: 1,
    recordId: proposal.operationId,
    runId: proposal.operationId,
    operationId: proposal.operationId,
    kind: 'operator-control',
    payload: {
      control: 'abandon',
      controlId: proposal.operationId,
      predecessor: null,
      mandate: proposal.mandate,
    },
  })
  if (!record.ok)
    return {
      status: 'refused',
      diagnostics: record.diagnostics.map((item) => problem(uw, item.code, item.message)),
    }
  publication.mayExist = true
  const published = await publishConfirmedWorkflowRecord(record.value, github, async () => ({
    ok: true,
    value: { config: null, externalHistories: [] },
  }))
  if (published.status !== 'confirmed')
    return {
      status: 'partial',
      uw,
      diagnostics: published.diagnostics.map((item) => problem(uw, item.code, item.message)),
    }
  return { status: 'abandoned', uw }
}

async function prepareAbandonment(
  github: GitHubOptions,
  uw: Scope,
  expectedMandate: MandateRef | undefined,
): Promise<{ ok: true; proposal: PreparedUwAbandon['proposal'] } | { ok: false; result: UwOperationResult }> {
  const authority = await readRevocable(uw, github, expectedMandate)
  if (authority.status !== 'applicable')
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: authority.evidence.map((item) => problem(uw, item.code, item.message)),
      },
    }
  const mandate = { scope: uw, recordId: authority.mandate.recordId, kind: 'mandate' as const }
  const proposal: PreparedUwAbandon['proposal'] = {
    format: 'omp-build-uw-abandon/1',
    operationId: `abandon:${randomUUID()}`,
    uw,
    mandate,
    mandateDigest: canonicalValueDigest(authority.mandate),
  }
  return { ok: true, proposal }
}

/** Confirm and publish an abandonment of the exact authenticated current mandate. */
export function createUwAbandon(input: {
  operator: OperatorPort
  github: GitHubOptions
}): (uw: Scope, expectedMandate?: ExternalRecordRef & { kind: 'mandate' }) => Promise<UwOperationResult> {
  return async (uw, expectedMandate) => {
    const publication = { mayExist: false }
    try {
      const preparation = await prepareAbandonment(input.github, uw, expectedMandate)
      if (!preparation.ok) return preparation.result
      const proposal = preparation.proposal
      const prepared: PreparedUwAbandon = { proposal, digest: canonicalValueDigest(proposal) }
      const confirmed = await input.operator.executeConfirmed(prepared, () =>
        publishAbandonment(input.github, uw, proposal, publication, expectedMandate),
      )
      return confirmed.status === 'confirmed' ? confirmed.value : confirmed
    } catch (error) {
      const diagnostics = [problem(uw, 'abandon-unconfirmed', error instanceof Error ? error.message : String(error))]
      return publication.mayExist ? { status: 'partial', uw, diagnostics } : { status: 'refused', diagnostics }
    }
  }
}
