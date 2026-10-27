import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import type { SpecAllocationPlan, SpecIdentityLedger } from './uw-identity.ts'
import {
  type CriterionId,
  canonicalSpec,
  criterionIdSchema,
  type InvariantId,
  invariantIdSchema,
  type Spec,
  type SpecDraft,
  type SpecItemId,
  validateSpecIds,
} from './uw-spec.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
export function nextSpecItemId(id: SpecItemId): string {
  return (BigInt(id.slice(1)) + 1n).toString()
}
export function nextCriterionId(value: string): CriterionId {
  return criterionIdSchema.parse(`C${value}`)
}
export function nextInvariantId(value: string): InvariantId {
  return invariantIdSchema.parse(`I${value}`)
}
function allocateCriteria(
  items: SpecDraft['criteria'],
  value: string,
  assignments: { draftKey: string; id: SpecItemId }[],
): Spec['criteria'] {
  let nextValue = value
  return items.map((item) => {
    if (item.kind === 'existing') return { id: item.id, statement: item.statement }
    const id = nextCriterionId(nextValue)
    nextValue = nextSpecItemId(id)
    assignments.push({ draftKey: item.draftKey, id })
    return { id, statement: item.statement }
  })
}
function allocateInvariants(
  items: SpecDraft['invariants'],
  value: string,
  assignments: { draftKey: string; id: SpecItemId }[],
): Spec['invariants'] {
  let nextValue = value
  return items.map((item) => {
    if (item.kind === 'existing') return { id: item.id, statement: item.statement }
    const id = nextInvariantId(nextValue)
    nextValue = nextSpecItemId(id)
    assignments.push({ draftKey: item.draftKey, id })
    return { id, statement: item.statement }
  })
}
function pending(
  ledger: SpecIdentityLedger,
  assignments: readonly { draftKey: string; id: SpecItemId }[],
): Map<SpecItemId, ExternalRecordRef> {
  const reference: ExternalRecordRef = { scope: ledger.uw, recordId: 'pending', kind: 'spec-identity' }
  const entries: [SpecItemId, ExternalRecordRef][] = []
  for (const { id } of assignments) entries.push([id, reference])
  return new Map([...ledger.allocations, ...entries])
}
function proposedRetirements(ledger: SpecIdentityLedger, spec: Spec): SpecItemId[] {
  const active = new Set([...spec.criteria, ...spec.invariants].map((item) => item.id))
  return [...ledger.allocations.keys()].filter((id) => !active.has(id) && !ledger.retired.has(id))
}
export function buildSpecAllocationPlan(draft: SpecDraft, ledger: SpecIdentityLedger): UwResult<SpecAllocationPlan> {
  const assignments: { draftKey: string; id: SpecItemId }[] = []
  const candidate = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: allocateCriteria(draft.criteria, ledger.nextCriterion, assignments),
    invariants: allocateInvariants(draft.invariants, ledger.nextInvariant, assignments),
    exclusions: draft.exclusions,
    openQuestions: draft.openQuestions,
    sections: draft.sections,
  })
  if (!candidate.ok)
    return {
      ok: false,
      diagnostics: candidate.diagnostics.map((item) => diagnostic(ledger.uw, item.code, item.message)),
    }
  const confirmed = validateSpecIds(candidate.value, { ...ledger, allocations: pending(ledger, assignments) })
  return confirmed.ok
    ? {
        ok: true,
        value: {
          ledgerHead: ledger.head,
          assignments,
          retirements: proposedRetirements(ledger, confirmed.value),
          spec: confirmed.value,
        },
      }
    : confirmed
}
