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
  validatePlannedSpecIds,
  validateSpecIdsWithPlan,
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
function proposedRetirements(ledger: SpecIdentityLedger, spec: Spec): SpecItemId[] {
  const active = new Set([...spec.criteria, ...spec.invariants].map((item) => item.id))
  return [...ledger.allocations.keys()].filter((id) => !active.has(id) && !ledger.retired.has(id))
}
function allocateCandidate(draft: SpecDraft, nextCriterion: string, nextInvariant: string) {
  const assignments: { draftKey: string; id: SpecItemId }[] = []
  const candidate = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: allocateCriteria(draft.criteria, nextCriterion, assignments),
    invariants: allocateInvariants(draft.invariants, nextInvariant, assignments),
    exclusions: draft.exclusions,
    openQuestions: draft.openQuestions,
    sections: draft.sections,
  })
  return { assignments, candidate }
}

export function buildSpecAllocationPlan(draft: SpecDraft, ledger: SpecIdentityLedger): UwResult<SpecAllocationPlan> {
  const { assignments, candidate } = allocateCandidate(draft, ledger.nextCriterion, ledger.nextInvariant)
  if (!candidate.ok)
    return {
      ok: false,
      diagnostics: candidate.diagnostics.map((item) => diagnostic(ledger.uw, item.code, item.message)),
    }
  const confirmed = validateSpecIdsWithPlan(candidate.value, ledger, new Set(assignments.map((item) => item.id)))
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

export function buildNewSpecAllocationPlan(draft: SpecDraft, repository: string): UwResult<SpecAllocationPlan> {
  const { assignments, candidate } = allocateCandidate(draft, '1', '1')
  if (!candidate.ok)
    return {
      ok: false,
      diagnostics: candidate.diagnostics.map((item) => ({
        code: item.code,
        message: item.message,
        location: { kind: 'repository' as const, repository },
        related: [],
      })),
    }
  const confirmed = validatePlannedSpecIds(
    candidate.value,
    {
      allocated: new Set(assignments.map((item) => item.id)),
      retired: new Set(),
    },
    repository,
  )
  return confirmed.ok
    ? { ok: true, value: { ledgerHead: null, assignments, retirements: [], spec: confirmed.value } }
    : confirmed
}
