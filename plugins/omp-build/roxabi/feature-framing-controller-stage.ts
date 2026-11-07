import type { FramingStage } from '../engine/framing-context-schema.ts'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { FramingSubmissionResult } from './feature-framing-contract.ts'
import { decisionProblem, recheck, refused, reopen, type SubmitActual } from './feature-framing-controller-form-gate.ts'
import { advance } from './feature-framing-controller-index.ts'
import {
  type ControllerCore,
  framingDiagnostic,
  type LeaseState,
  submission,
} from './feature-framing-controller-lease.ts'

type StageForm = Extract<FramingForm, { kind: 'grilling' | 'terminology' | 'module-design' }>
const STAGE_OF_FORM: Readonly<Record<StageForm['kind'], FramingStage>> = {
  grilling: 'grilling',
  terminology: 'domain-modeling',
  'module-design': 'codebase-design',
}
function stageTerms(form: StageForm) {
  return form.kind === 'module-design' ? [] : form.terms
}

/** Order, unresolved decisions, own-stage answered decisions and term uniqueness. */
function stageFormProblem(
  lease: LeaseState,
  form: StageForm,
  stage: FramingStage,
  actual: SubmitActual,
): FramingSubmissionResult | null {
  const outOfOrder =
    lease.phase.kind !== 'interview' ||
    lease.stage !== stage ||
    lease.designed ||
    (stage === 'grilling' && lease.shape !== null)
  if (outOfOrder)
    return refused(
      lease,
      'framing-stage-order',
      `Expected the ${lease.stage} result; stages are never skipped or repeated`,
    )
  if (form.unresolved.length > 0)
    return submission(lease, 'waiting', [
      framingDiagnostic(
        lease,
        'framing-decisions-unresolved',
        'Ask every unresolved decision as one numbered question form, then wait for the operator',
      ),
    ])
  const problem = decisionProblem(lease, actual.ctx, form.decisions, stage)
  if (problem) return submission(lease, 'refused', [problem])
  const terms = stageTerms(form)
  const known = [...lease.terms.map((item) => item.term), ...terms.map((item) => item.term)]
  if (new Set(known).size !== known.length)
    return refused(lease, 'framing-term-duplicate', 'Each term is accepted once')
  return null
}

function acceptStage(lease: LeaseState, form: StageForm, stage: FramingStage): void {
  lease.decisions[stage] = form.decisions.map((item) => Object.freeze({ ...item }))
  lease.terms.push(...stageTerms(form).map((item) => Object.freeze({ ...item, stage })))
  if (form.kind === 'grilling') {
    lease.shape = form.shape
    if (form.shape === 'leaf') lease.designed = true
    else lease.stage = 'domain-modeling'
  } else if (form.kind === 'terminology') {
    lease.stage = 'codebase-design'
  } else {
    lease.modules = form.modules.map((item) => Object.freeze({ ...item }))
    lease.designed = true
  }
}

export async function stageResult(
  core: ControllerCore,
  lease: LeaseState,
  form: StageForm,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  const stage = STAGE_OF_FORM[form.kind]
  const problem = stageFormProblem(lease, form, stage, actual)
  if (problem) return problem
  const blocked = await recheck(core, lease, actual, lease.revision)
  if (blocked) return blocked
  acceptStage(lease, form, stage)
  reopen(lease, null)
  advance(lease, actual.ctx)
  return submission(lease, 'accepted', [
    framingDiagnostic(
      lease,
      'framing-stage-accepted',
      lease.designed
        ? 'Stages complete. After the next projection, submit the complete proposal form.'
        : `Next stage: ${lease.stage}. The next projection supplies its procedure and a new supply token.`,
    ),
  ])
}
