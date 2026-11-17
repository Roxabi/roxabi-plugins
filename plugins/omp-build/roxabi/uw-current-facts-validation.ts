import { unknownWayfinderLabels } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwRead } from './uw-contract.ts'
import type { CurrentOwnSpecFacts, CurrentOwnSpecFactsResult } from './uw-current-facts.ts'

export function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

export function tier(
  uw: Scope,
  labels: readonly string[],
): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['currentSpec']['tier']> {
  const values = labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full')
  if (values.length !== 1)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          uw,
          values.length === 0 ? 'tier-missing' : 'tier-conflicting',
          'UW must have exactly one native size tier',
        ),
      ],
    }
  return { ok: true, value: values[0] === 'size:S' ? 'S' : values[0] === 'size:F-lite' ? 'F-lite' : 'F-full' }
}

export function allocationRefs(
  uw: Scope,
  read: Pick<UwRead, 'identity' | 'proposed'>,
): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['identityAllocations']> {
  if (!read.identity.ok) return { ok: false, diagnostics: read.identity.diagnostics }
  if (!read.proposed.ok) return { ok: false, diagnostics: read.proposed.diagnostics }
  const references: CurrentOwnSpecFacts['identityAllocations'] = []
  for (const item of [...read.proposed.snapshot.spec.criteria, ...read.proposed.snapshot.spec.invariants]) {
    const allocation = read.identity.value.allocations.get(item.id)
    if (allocation === undefined || read.identity.value.retired.has(item.id))
      return {
        ok: false,
        diagnostics: [
          diagnostic(uw, 'spec-ledger-incomplete', 'Current proposed Spec has unknown or retired identities'),
        ],
      }
    references.push(allocation)
  }
  return { ok: true, value: references }
}

export function root(
  uw: Scope,
  observation: UwRead['observation'],
): CurrentOwnSpecFactsResult<UwRead['graph']['nodes'][number]> {
  if (observation === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'observation-missing', 'Current facts require a complete joint observation')],
    }
  if (observation.status !== 'complete') return { ok: false, diagnostics: observation.diagnostics }
  const node = observation.graph.nodes.find(
    (candidate) => candidate.uw.repository === uw.repository && candidate.uw.target === uw.target,
  )
  if (node === undefined)
    return { ok: false, diagnostics: [diagnostic(uw, 'graph-root-missing', 'UW graph root is absent')] }
  const unknownWayfinders = unknownWayfinderLabels(node)
  if (unknownWayfinders.length > 0)
    return {
      ok: false,
      diagnostics: [
        diagnostic(uw, 'wayfinder-unknown', `UW has unknown wayfinder labels: ${unknownWayfinders.join(', ')}`),
      ],
    }
  return { ok: true, value: node }
}
