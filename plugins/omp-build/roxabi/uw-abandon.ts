import { createHash, randomUUID } from 'node:crypto'
import {
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  nativeObservationDigest,
  publishConfirmedWorkflowRecord,
  resolveAcceptedSpec,
  selectApplicableMandate,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type { OperatorPort, PreparedUwAbandon, UwOperationResult, UwRead, UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'

function problem(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function abandonmentAuthority(read: UwRead) {
  if (read.observation.status !== 'complete') return null
  const histories = read.observation.histories
  const home = histories.find(
    (entry) => entry.source.scope.repository === read.uw.repository && entry.source.scope.target === read.uw.target,
  )
  if (home === undefined) return null
  const selection = selectApplicableMandate(
    home,
    histories.filter((entry) => entry !== home),
    {
      histories,
      catalogues: read.observation.catalogues,
      observation: read.observation,
    },
  )
  const ref =
    selection.status === 'applicable'
      ? { scope: home.source.scope, recordId: selection.mandate.recordId, kind: 'mandate' as const }
      : selection.reason === 'paused'
        ? selection.pause.mandate
        : null
  if (ref === null) return null
  const mandate = bindExternalRef(ref, home)
  if (!mandate.ok || mandate.value.kind !== 'mandate') return null
  const accepted = resolveAcceptedSpec(mandate.value, histories)
  if (!accepted.ok) return null
  return { mandate: ref, accepted: accepted.spec.ref }
}

async function authenticateAbandonmentReadback(
  reader: UwReadPort,
  uw: Scope,
  proposal: PreparedUwAbandon['proposal'],
  record: Parameters<typeof publishConfirmedWorkflowRecord>[0],
): Promise<UwOperationResult> {
  const reread = await reader.readUw(uw)
  const home = reread.histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  const terminal =
    reread.observation.status === 'complete' && home !== undefined
      ? selectApplicableMandate(
          home,
          reread.observation.histories.filter((entry) => entry !== home),
          {
            histories: reread.observation.histories,
            catalogues: reread.observation.catalogues,
            observation: reread.observation,
          },
        )
      : null
  const bound =
    home === undefined
      ? null
      : bindExternalRef({ scope: uw, recordId: proposal.operationId, kind: 'operator-control' }, home)
  if (
    reread.observation.status !== 'complete' ||
    bound === null ||
    !bound.ok ||
    JSON.stringify(bound.value) !== JSON.stringify(record) ||
    terminal?.status !== 'refused' ||
    terminal.reason !== 'abandoned'
  )
    return {
      status: 'partial',
      uw,
      diagnostics: [
        problem(
          uw,
          'abandon-readback-unconfirmed',
          'Abandonment record or its terminal authority could not be authenticated on readback',
        ),
      ],
    }
  return { status: 'abandoned', uw }
}

function expectedMandateMatches(
  expected: (ExternalRecordRef & { kind: 'mandate' }) | undefined,
  mandate: ExternalRecordRef,
): boolean {
  return (
    expected === undefined ||
    (expected.recordId === mandate.recordId &&
      expected.scope.repository === mandate.scope.repository &&
      expected.scope.target === mandate.scope.target)
  )
}

async function publishAbandonment(
  input: { reader: UwReadPort; github: GitHubOptions },
  uw: Scope,
  proposal: PreparedUwAbandon['proposal'],
  publication: { mayExist: boolean },
): Promise<UwOperationResult> {
  const fresh = await input.reader.readUw(uw)
  const current = fresh.observation.status === 'complete' ? rootObservation(uw, fresh) : null
  const authority = abandonmentAuthority(fresh)
  if (
    fresh.observation.status !== 'complete' ||
    authority === null ||
    current === null ||
    hash(fresh.observation.histories) !== proposal.historyDigest ||
    nativeObservationDigest({
      ...current,
      labels: [...current.labels],
      children: [...current.children],
      blockers: [...current.blockers],
    }) !== proposal.nativeDigest ||
    JSON.stringify(authority.accepted) !== JSON.stringify(proposal.accepted) ||
    JSON.stringify(authority.mandate) !== JSON.stringify(proposal.mandate)
  )
    return {
      status: 'refused',
      diagnostics: [problem(uw, 'proposal-stale', 'Abandonment authority or native facts changed after confirmation')],
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
  const published = await publishConfirmedWorkflowRecord(
    record.value,
    input.github,
    createPublicationContextResolver(input.github, null),
    fresh.observation.histories,
  )
  if (published.status !== 'confirmed')
    return {
      status: 'partial',
      uw,
      diagnostics: published.diagnostics.map((item) => problem(uw, item.code, item.message)),
    }
  return authenticateAbandonmentReadback(input.reader, uw, proposal, record.value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function prepareAbandonment(
  reader: UwReadPort,
  uw: Scope,
  expectedMandate: (ExternalRecordRef & { kind: 'mandate' }) | undefined,
): Promise<{ ok: true; proposal: PreparedUwAbandon['proposal'] } | { ok: false; result: UwOperationResult }> {
  const read = await reader.readUw(uw)
  const authority = abandonmentAuthority(read)
  if (read.observation.status !== 'complete' || authority === null)
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: [
          problem(
            uw,
            'abandon-authority-unavailable',
            'A complete observation and authenticated current or paused mandate are required',
          ),
        ],
      },
    }
  const mandate = authority.mandate
  const before = rootObservation(uw, read)
  if (before === null)
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: [problem(uw, 'abandon-authority-unavailable', 'The native issue observation is missing')],
      },
    }
  if (!expectedMandateMatches(expectedMandate, mandate))
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: [problem(uw, 'abandon-mandate-stale', 'The selected mandate changed before abandonment')],
      },
    }
  const proposal: PreparedUwAbandon['proposal'] = {
    format: 'omp-build-uw-abandon/1',
    operationId: `abandon:${randomUUID()}`,
    uw,
    mandate: { ...mandate, kind: 'mandate' },
    accepted: authority.accepted,
    historyDigest: hash(read.observation.histories),
    nativeDigest: nativeObservationDigest({
      ...before,
      labels: [...before.labels],
      children: [...before.children],
      blockers: [...before.blockers],
    }),
  }
  return { ok: true, proposal }
}

/** Confirm and publish an abandonment of the exact authenticated current mandate. */
export function createUwAbandon(input: {
  operator: OperatorPort
  reader: UwReadPort
  github: GitHubOptions
}): (uw: Scope, expectedMandate?: ExternalRecordRef & { kind: 'mandate' }) => Promise<UwOperationResult> {
  return async (uw, expectedMandate) => {
    const publication = { mayExist: false }
    try {
      const preparation = await prepareAbandonment(input.reader, uw, expectedMandate)
      if (!preparation.ok) return preparation.result
      const proposal = preparation.proposal
      const prepared: PreparedUwAbandon = { proposal, digest: hash(proposal) }
      const confirmed = await input.operator.executeConfirmed(prepared, () =>
        publishAbandonment(input, uw, proposal, publication),
      )
      return confirmed.status === 'confirmed'
        ? confirmed.value
        : { status: 'refused', diagnostics: confirmed.diagnostics }
    } catch (error) {
      const diagnostics = [problem(uw, 'abandon-unconfirmed', error instanceof Error ? error.message : String(error))]
      return publication.mayExist ? { status: 'partial', uw, diagnostics } : { status: 'refused', diagnostics }
    }
  }
}
