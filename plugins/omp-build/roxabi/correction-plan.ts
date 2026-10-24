import type { CorrectionExecution } from './correction-execution-contract'
import { executeCorrection } from './correction-plan-execution'
import type {
  CorrectionOutcome,
  CorrectionPlanResult,
  RetainedCorrectionObligation,
  SelectedAdmission,
} from './correction-policy-contract'
import { type CauseAdmission, orderSelectedCauses } from './fix-domain'

function retainedFromOutcome(outcome: CorrectionOutcome): RetainedCorrectionObligation | null {
  if (outcome.outcome === 'applied') return null
  return {
    cause: outcome.cause,
    findingIds: [...outcome.cause.findingIds],
    diagnostics: [`correction-${outcome.outcome}`, ...(outcome.terminalFailure ? ['terminal-effect'] : [])],
    source: 'outcome',
  }
}

function retainWithoutAttempt(
  admission: SelectedAdmission,
  diagnostics: readonly string[],
): RetainedCorrectionObligation {
  return {
    cause: admission.cause,
    findingIds: [...admission.cause.findingIds],
    diagnostics: [...diagnostics],
    source: 'withheld',
  }
}

function retainedAdmissions(admissions: readonly CauseAdmission[]): Map<string, RetainedCorrectionObligation> {
  const retained = new Map<string, RetainedCorrectionObligation>()
  for (const admission of admissions) {
    if (admission.status !== 'retained') continue
    retained.set(admission.cause.id, {
      cause: admission.cause,
      findingIds: [...admission.cause.findingIds],
      diagnostics: [...admission.diagnostics],
      source: 'admission',
    })
  }
  return retained
}

function optionalParentWasApplied(
  admission: SelectedAdmission,
  outcomesByCause: ReadonlyMap<string, CorrectionOutcome>,
): boolean {
  if (admission.required || typeof admission.cause.authorization !== 'object') return true
  return outcomesByCause.get(admission.cause.authorization.optionalNeighborOf)?.outcome === 'applied'
}

type PlanExecutionState = {
  outcomes: CorrectionOutcome[]
  outcomesByCause: Map<string, CorrectionOutcome>
  appliedRequiredCauses: CorrectionOutcome['cause'][]
  terminal: boolean
  terminalDiagnostics: readonly string[] | null
}

function recordOutcome(
  state: PlanExecutionState,
  retained: Map<string, RetainedCorrectionObligation>,
  admission: SelectedAdmission,
  outcome: CorrectionOutcome,
): void {
  state.outcomes.push(outcome)
  state.outcomesByCause.set(outcome.cause.id, outcome)
  if (admission.required && outcome.outcome === 'applied') state.appliedRequiredCauses.push(admission.cause)
  const retainedOutcome = retainedFromOutcome(outcome)
  if (retainedOutcome !== null) retained.set(outcome.cause.id, retainedOutcome)
  if (!outcome.terminalFailure) return
  state.terminal = true
  if (!state.outcomes.some((item) => item.outcome === 'applied' || item.commitSHAs.length !== 0))
    state.terminalDiagnostics = outcome.terminalDiagnostics
}

/** Run a whole posted plan without losing retained admissions or later safe required causes. */
export async function executeCorrectionPlan(
  admissions: readonly CauseAdmission[],
  executor: CorrectionExecution,
): Promise<CorrectionPlanResult> {
  const retained = retainedAdmissions(admissions)
  const state: PlanExecutionState = {
    outcomes: [],
    outcomesByCause: new Map(),
    appliedRequiredCauses: [],
    terminal: false,
    terminalDiagnostics: null,
  }
  for (const admission of orderSelectedCauses(admissions)) {
    if (admission.status !== 'selected') continue
    if (state.terminal) {
      retained.set(admission.cause.id, retainWithoutAttempt(admission, ['prior-correction-terminal']))
      continue
    }
    if (!optionalParentWasApplied(admission, state.outcomesByCause)) {
      retained.set(admission.cause.id, retainWithoutAttempt(admission, ['optional-parent-not-applied-after-gate']))
      continue
    }
    const outcome = await executeCorrection(admission, executor, state.appliedRequiredCauses)
    recordOutcome(state, retained, admission, outcome)
  }
  return {
    ok: !state.terminal,
    outcomes: state.outcomes,
    retainedObligations: [...retained.values()],
    terminal: state.terminal,
    terminalDiagnostics: state.terminalDiagnostics,
  }
}
