import type { Cause, Json, Policy } from '../contracts'

export type { Json } from '../contracts'
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

export type DebtEvidence = {
  important: boolean | 'unknown'
  urgent: boolean | 'unknown'
  tooLarge: boolean | 'unknown'
  evidence: Json
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

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function admissionPresent(value: Json | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return typeof value !== 'object' || Object.keys(value).length > 0
}

function candidateAdmissionIsComplete(cause: CorrectionCause): boolean {
  if (!admissionPresent(cause.admission)) return false
  if (cause.authorization === 'required') {
    return (
      typeof cause.admission === 'object' &&
      !Array.isArray(cause.admission) &&
      cause.admission !== null &&
      'safePlan' in cause.admission
    )
  }
  if (
    !cause.authorization ||
    typeof cause.authorization !== 'object' ||
    typeof cause.admission !== 'object' ||
    Array.isArray(cause.admission) ||
    cause.admission === null
  )
    return false
  const evidence = cause.admission
  return (
    evidence.currentDefectMechanism === true &&
    evidence.requiredBoundary === true &&
    evidence.preservesPromise === true &&
    evidence.noDependency === true &&
    evidence.callerCompatibility === true &&
    evidence.targetedProof === true &&
    evidence.separable === true
  )
}

/**
 * Admit only a posted decision's exact causes. This intentionally does not infer
 * identity, merge findings, or promote labels: those remain the model decision.
 */
export function admitCorrectionCauses(
  policy: FixPolicy,
  causes: readonly CorrectionCause[],
  findings: readonly FixFinding[],
): CauseAdmission[] {
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]))
  const causeIds = new Set(causes.map((cause) => cause.id))
  const claimed = new Set<string>()

  const admissions: CauseAdmission[] = causes.map((cause): CauseAdmission => {
    const diagnostics: string[] = []
    if (!validId(cause.id)) diagnostics.push('cause-id-invalid')
    if (![cause.title, cause.mechanism, cause.fix, cause.failure, cause.restored, cause.proof].every(nonEmpty)) {
      diagnostics.push('seven-field-plan-incomplete')
    }
    if (cause.paths.length === 0 || cause.paths.some((path) => !nonEmpty(path))) diagnostics.push('paths-invalid')
    if (cause.findingIds.length === 0 || cause.findingIds.some((id) => !validId(id)))
      diagnostics.push('members-invalid')

    let hasBlockingMember = false
    for (const findingId of cause.findingIds) {
      const finding = findingsById.get(findingId)
      if (!finding) diagnostics.push(`member-unknown:${findingId}`)
      else {
        if (!finding.usable || finding.label === null) diagnostics.push(`member-unusable:${findingId}`)
        else if (!isKnownReviewLabel(finding.label)) diagnostics.push(`member-label-unknown:${findingId}`)
        else if (!isActionableReviewLabel(finding.label)) diagnostics.push(`member-nonactionable:${findingId}`)
        if (isBlockingLabel(finding.label)) hasBlockingMember = true
      }
      if (claimed.has(findingId)) diagnostics.push(`member-duplicate:${findingId}`)
      claimed.add(findingId)
    }

    if (policy.version === 'baseline') {
      if (!hasBlockingMember) diagnostics.push('baseline-blocking-member-required')
      return diagnostics.length === 0
        ? { status: 'selected', cause, required: true }
        : { status: 'retained', cause, diagnostics }
    }

    if (!admissionPresent(cause.admission)) diagnostics.push('candidate-admission-required')
    if (!candidateAdmissionIsComplete(cause)) diagnostics.push('candidate-admission-incomplete')
    if (cause.authorization === 'required') {
      return diagnostics.length === 0
        ? { status: 'selected', cause, required: true }
        : { status: 'retained', cause, diagnostics }
    }
    if (!cause.authorization || typeof cause.authorization !== 'object') {
      diagnostics.push('candidate-authorization-required')
    } else {
      const parent = cause.authorization.optionalNeighborOf
      if (!validId(parent) || parent === cause.id || !causeIds.has(parent)) diagnostics.push('optional-parent-invalid')
    }
    return diagnostics.length === 0
      ? { status: 'selected', cause, required: false }
      : { status: 'retained', cause, diagnostics }
  })
  if (policy.version === 'baseline') return admissions
  const selectedRequired = new Set<string>()
  for (const admission of admissions) {
    if (admission.status === 'selected' && admission.required === true) selectedRequired.add(admission.cause.id)
  }
  return admissions.map((admission): CauseAdmission => {
    if (admission.status !== 'selected' || admission.required) return admission
    const authorization = admission.cause.authorization
    if (typeof authorization !== 'object') return admission
    if (selectedRequired.has(authorization.optionalNeighborOf)) return admission
    return { status: 'retained', cause: admission.cause, diagnostics: ['optional-parent-not-selected-required'] }
  })
}

/**
 * Preserve every admission for retention/filing while putting runnable causes in
 * required-parent order. Execution consumers must filter `selected` themselves.
 */
export function orderSelectedCauses(admissions: readonly CauseAdmission[]): CauseAdmission[] {
  const selected = admissions.filter(
    (admission): admission is Extract<CauseAdmission, { status: 'selected' }> => admission.status === 'selected',
  )
  const byId = new Map(selected.map((admission) => [admission.cause.id, admission]))
  const ordered: CauseAdmission[] = []
  const seen = new Set<string>()
  const add = (admission: Extract<CauseAdmission, { status: 'selected' }>) => {
    if (seen.has(admission.cause.id)) return
    if (!admission.required && typeof admission.cause.authorization === 'object') {
      const parent = byId.get(admission.cause.authorization.optionalNeighborOf)
      if (parent?.required) add(parent)
    }
    seen.add(admission.cause.id)
    ordered.push(admission)
  }
  for (const admission of selected) add(admission)
  return [...ordered, ...admissions.filter((admission) => admission.status === 'retained')]
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

/** Existing issue-triage transport may file only when every independent predicate is true. */
export function debtIssueAdmitted(evidence: DebtEvidence): boolean {
  return evidence.important === true && evidence.urgent === true && evidence.tooLarge === true
}
