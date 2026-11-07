import type { PreparedCauseDependencyAdjustment } from './cause-dependency-adjustment-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import type { CauseDependencyAdjustmentInputJson } from './uw-command-schema.ts'
import type { UwCompletionObservation, UwWaitProjection, WaitRequirement } from './uw-completion-types.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { waitCycleDiagnostics } from './uw-wait-cycles.ts'
import { projectUwWaits } from './uw-waits.ts'
import { historyFor, recordsOf } from './workflow-control.ts'

export type Input = CauseDependencyAdjustmentInputJson & {
  operationId: string
  controlId: string
  observation: UwCompletionObservation
}

export function fail<T>(origin: Scope, message: string): UwResult<T> {
  return {
    ok: false,
    diagnostics: [
      {
        code: 'cause-adjustment-unavailable',
        message,
        location: { kind: 'native', uw: origin, connection: 'blockers' },
        related: [],
      },
    ],
  }
}

function withdrawnTarget(
  input: Input,
  history: DecodedHistory,
  predecessor: Input['predecessor'],
  target: Scope,
): UwResult<Scope> {
  let cursor = input.receipt as typeof input.predecessor
  const controls = recordsOf(history).filter(
    (record) => record.kind === 'operator-control' && record.payload.control === 'adjust-cause-dependency',
  )
  while (!sameRef(cursor, predecessor)) {
    const next = controls.filter(
      (record) =>
        record.kind === 'operator-control' &&
        record.payload.control === 'adjust-cause-dependency' &&
        sameRef(record.payload.proposal.predecessor, cursor),
    )
    const record = next[0]
    if (
      next.length !== 1 ||
      record?.kind !== 'operator-control' ||
      record.payload.control !== 'adjust-cause-dependency'
    )
      return fail(input.origin, 'Prior causal chain cannot be reconstructed')
    if (record.payload.proposal.change.kind === 'replace') target = record.payload.proposal.change.blocker
    cursor = { scope: input.origin, recordId: record.recordId, kind: 'operator-control' }
  }
  return { ok: true, value: target }
}

export function currentDecision(
  input: Input,
  history: DecodedHistory,
  waits: UwWaitProjection,
): UwResult<{ predecessor: Input['predecessor']; target: Scope }> {
  const match = waits.causeWaits.filter(
    (item) =>
      equalScope(item.origin, input.origin) &&
      sameRef(item.disposition, input.disposition) &&
      sameRef(item.receipt, input.receipt),
  )
  const current = match[0]
  if (
    match.length !== 1 ||
    current === undefined ||
    current.state === 'held' ||
    waits.diagnostics.some((entry) => entry.code !== 'wait-cycle')
  )
    return fail(input.origin, 'The current cause and complete wait graph cannot be authenticated')
  const predecessor = current.control ?? input.receipt
  if (!sameRef(predecessor, input.predecessor))
    return fail(input.origin, 'The decision does not extend the unique current predecessor')
  const receipt = recordsOf(history).find(
    (record) => record.kind === 'debt-receipt' && record.recordId === input.receipt.recordId,
  )
  if (receipt?.kind !== 'debt-receipt') return fail(input.origin, 'Original sister receipt is unavailable')
  const target = current.state === 'required' ? current.target : receipt.payload.sister
  if (current.state !== 'withdrawn') return { ok: true, value: { predecessor, target } }
  const resolved = withdrawnTarget(input, history, predecessor, target)
  return resolved.ok ? { ok: true, value: { predecessor, target: resolved.value } } : resolved
}

export function replacementCycles(input: Input, waits: UwWaitProjection) {
  if (input.change.kind !== 'replace') return []
  const edges: WaitRequirement[] = waits.requirements.filter(
    (edge) =>
      !(edge.source.kind === 'blocking-sister' && sameRef(edge.source.receipt, input.receipt)) &&
      !(
        edge.source.kind === 'native-blocker' &&
        equalScope(edge.from, input.origin) &&
        input.nativeEffect.kind === 'update-blockers' &&
        input.nativeEffect.remove.some((scope) => equalScope(scope, edge.to))
      ),
  )
  edges.push({
    from: input.origin,
    to: input.change.blocker,
    source: { kind: 'blocking-sister', disposition: input.disposition, receipt: input.receipt, control: null },
  })
  if (input.nativeEffect.kind === 'update-blockers')
    for (const to of input.nativeEffect.add) edges.push({ from: input.origin, to, source: { kind: 'native-blocker' } })
  return waitCycleDiagnostics(edges)
}

function historicalTarget(
  p: PreparedCauseDependencyAdjustment['proposal'],
  history: DecodedHistory,
  target: Scope,
): UwResult<Scope> {
  let cursor = p.predecessor
  const seen = new Set<string>()
  while (cursor.kind === 'operator-control') {
    if (seen.has(cursor.recordId)) return fail(p.origin, 'Prior causal chain contains a cycle')
    seen.add(cursor.recordId)
    const record = recordsOf(history).find(
      (item) => item.kind === 'operator-control' && item.recordId === cursor.recordId,
    )
    if (record?.kind !== 'operator-control' || record.payload.control !== 'adjust-cause-dependency')
      return fail(p.origin, 'Prior causal chain is unavailable')
    if (record.payload.proposal.change.kind === 'replace')
      return { ok: true, value: record.payload.proposal.change.blocker }
    cursor = record.payload.proposal.predecessor
  }
  return { ok: true, value: target }
}

export function effectTarget(
  p: PreparedCauseDependencyAdjustment['proposal'],
  baseline: UwCompletionObservation,
): UwResult<Scope> {
  const history = historyFor(p.origin, baseline.histories)
  const receipt =
    history &&
    recordsOf(history).find((record) => record.kind === 'debt-receipt' && record.recordId === p.receipt.recordId)
  if (receipt?.kind !== 'debt-receipt') return fail(p.origin, 'Original receipt is unavailable')
  const waits = projectUwWaits({
    graph: baseline.graph,
    histories: baseline.histories,
    catalogues: baseline.catalogues,
  })
  const current = waits.causeWaits.find((item) => sameRef(item.receipt, p.receipt) && equalScope(item.origin, p.origin))
  const target = current?.state === 'required' ? current.target : receipt.payload.sister
  return current?.state === 'withdrawn' && history ? historicalTarget(p, history, target) : { ok: true, value: target }
}
