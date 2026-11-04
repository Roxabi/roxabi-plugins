import type { Cause, Policy } from '../dist/contracts.js'

export type { Json } from '../dist/contracts.js'
export type FixPolicy = Policy
export type FixFinding = {
  id: string
  label: string | null
  usable: boolean
}

export type CorrectionCause = Cause

export type CauseAdmission =
  | { status: 'selected'; cause: CorrectionCause; required: boolean }
  | { status: 'retained'; cause: CorrectionCause; diagnostics: string[] }

export type FalsificationFact = {
  guard: string
  removedProductionGuard: boolean
  proofFailedIntendedScenario: boolean
  inconclusive?: boolean
  detail?: string
}

export type FalsificationAssessment = {
  result: 'pass' | 'fail' | 'skipped'
  notes: string
}

export function isBlockingLabel(label: string | null): boolean {
  return label === 'issue' || label === 'issue(blocking)' || label === 'todo' || label === 'suggestion(blocking)'
}

export function isKnownReviewLabel(label: string | null): boolean {
  return (
    label === 'issue' ||
    label === 'issue(blocking)' ||
    label === 'todo' ||
    label === 'suggestion(blocking)' ||
    label === 'suggestion' ||
    label === 'suggestion(non-blocking)' ||
    label === 'nitpick' ||
    label === 'thought' ||
    label === 'question' ||
    label === 'praise'
  )
}

export function isActionableReviewLabel(label: string | null): boolean {
  return isBlockingLabel(label) || label === 'suggestion' || label === 'suggestion(non-blocking)' || label === 'nitpick'
}

/** Preserve assessment order; all admitted D14 corrections are required work. */
export function orderSelectedCauses(admissions: readonly CauseAdmission[]): CauseAdmission[] {
  return [...admissions]
}

/** A model assertion is never enough for a pass: every removed guard must fail the stated scenario. */
export function assessFalsification(facts: readonly FalsificationFact[], reason?: string): FalsificationAssessment {
  const removed = facts.filter((fact) => fact.removedProductionGuard)
  const tautological = removed.find((fact) => !fact.proofFailedIntendedScenario)
  if (tautological)
    return { result: 'fail', notes: tautological.detail || `proof passed without ${tautological.guard}` }
  if (reason) return { result: 'skipped', notes: reason }
  if (removed.length === 0) return { result: 'skipped', notes: 'no production guard identified' }
  if (facts.some((fact) => fact.inconclusive)) return { result: 'skipped', notes: 'inconclusive guard-removal proof' }
  return { result: 'pass', notes: '' }
}
