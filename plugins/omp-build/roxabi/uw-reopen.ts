import { createHash, randomUUID } from 'node:crypto'
import type { IssueWriteResult } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { nativeObservationDigest } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { PreparedUwReopen, UwOperationResult } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import type { UwOperationsPorts } from './uw-operations.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function writeDiagnostics(uw: Scope, result: IssueWriteResult): readonly UwDiagnostic[] {
  if (result.status === 'written') return []
  return result.diagnostics.map((item) => diagnostic(uw, item.code, item.message))
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function confirmReopen(
  uw: Scope,
  proposal: PreparedUwReopen['proposal'],
  before: PreparedUwReopen['proposal']['before'],
  ports: UwOperationsPorts,
): Promise<UwOperationResult> {
  try {
    const after = await ports.read(uw)
    const root = after.observation.status === 'complete' ? rootObservation(uw, after) : null
    const expected = {
      ...before,
      nativeState: proposal.effect,
      labels: [...before.labels],
      children: [...before.children],
      blockers: [...before.blockers],
    }
    if (
      root === null ||
      after.observation.status !== 'complete' ||
      after.accepted.status !== 'accepted' ||
      JSON.stringify(after.accepted.value.ref) !== JSON.stringify(proposal.accepted) ||
      hash(after.observation.histories) !== proposal.historyDigest ||
      nativeObservationDigest({
        ...root,
        labels: [...root.labels],
        children: [...root.children],
        blockers: [...root.blockers],
      }) !== nativeObservationDigest(expected)
    )
      return {
        status: 'partial',
        uw,
        diagnostics: [
          diagnostic(
            uw,
            'reopen-readback-mismatch',
            'Reopen was written but its exact native state and authority could not be read back',
          ),
        ],
      }
    return { status: 'written', value: after }
  } catch (error) {
    return {
      status: 'partial',
      uw,
      diagnostics: [
        diagnostic(
          uw,
          'reopen-readback-failed',
          error instanceof Error ? error.message : 'Reopen readback failed after the write',
        ),
      ],
    }
  }
}

async function executeReopen(
  uw: Scope,
  proposal: PreparedUwReopen['proposal'],
  before: PreparedUwReopen['proposal']['before'],
  target: PreparedUwReopen['proposal']['before']['issue'],
  ports: UwOperationsPorts,
): Promise<UwOperationResult> {
  const fresh = await ports.read(uw)
  const observed = fresh.observation.status === 'complete' ? rootObservation(uw, fresh) : null
  if (
    fresh.observation.status !== 'complete' ||
    fresh.accepted.status !== 'accepted' ||
    observed === null ||
    JSON.stringify(fresh.accepted.value.ref) !== JSON.stringify(proposal.accepted) ||
    hash(fresh.observation.histories) !== proposal.historyDigest ||
    nativeObservationDigest({
      ...observed,
      labels: [...observed.labels],
      children: [...observed.children],
      blockers: [...observed.blockers],
    }) !== proposal.nativeDigest
  )
    return {
      status: 'refused',
      diagnostics: [diagnostic(uw, 'proposal-stale', 'Reopen authority or native facts changed after confirmation')],
    }
  const applicable = ports.resolveSpecEffective({
    mode: 'current',
    own: fresh.accepted.value.ref,
    histories: fresh.observation.histories,
    graph: fresh.observation.graph,
  })
  if (!applicable.ok) return { status: 'refused', diagnostics: applicable.diagnostics }
  const written = await ports.writer.setNativeState(target, proposal.effect, observed)
  if (written.status !== 'written')
    return written.status === 'refused'
      ? { status: 'refused', diagnostics: writeDiagnostics(uw, written) }
      : { status: 'partial', uw, diagnostics: writeDiagnostics(uw, written) }
  return confirmReopen(uw, proposal, before, ports)
}

export async function reopenUw(uw: Scope, ports: UwOperationsPorts): Promise<UwOperationResult> {
  const current = await ports.read(uw)
  if (current.observation.status !== 'complete' || current.accepted.status !== 'accepted')
    return {
      status: 'refused',
      diagnostics: [
        diagnostic(
          uw,
          'reopen-authority-unavailable',
          'Reopen requires a complete observation and authenticated accepted Spec',
        ),
      ],
    }
  const authority = ports.resolveSpecEffective({
    mode: 'current',
    own: current.accepted.value.ref,
    histories: current.observation.histories,
    graph: current.observation.graph,
  })
  if (!authority.ok) return { status: 'refused', diagnostics: authority.diagnostics }
  const before = rootObservation(uw, current)
  const target = before.issue
  if (before.nativeState.state !== 'CLOSED')
    return {
      status: 'refused',
      diagnostics: [
        diagnostic(uw, 'reopen-state-invalid', 'Reopen requires a completely observed closed native issue'),
      ],
    }
  const proposal: PreparedUwReopen['proposal'] = {
    format: 'omp-build-uw-reopen/1',
    operationId: `reopen:${randomUUID()}`,
    uw,
    accepted: current.accepted.value.ref,
    before,
    nativeDigest: nativeObservationDigest({
      ...before,
      labels: [...before.labels],
      children: [...before.children],
      blockers: [...before.blockers],
    }),
    historyDigest: hash(current.observation.histories),
    effect: { state: 'OPEN', stateReason: 'REOPENED' },
  }
  const prepared: PreparedUwReopen = { proposal, digest: hash(proposal) }
  const confirmed = await ports.operator.executeConfirmed(prepared, () =>
    executeReopen(uw, proposal, before, target, ports),
  )
  return confirmed.status === 'confirmed' ? confirmed.value : confirmed
}
