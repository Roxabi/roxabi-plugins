import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { PauseBinding } from '../engine/workflow-pause.ts'
import { epicFinalReviewRequest, epicNext, epicReport, epicStep } from '../skills/feature/epic-driver.ts'
import type { Step as EpicStep } from '../skills/feature/epic-types.ts'
import { prepareEpicFinalReviewMaterials } from './epic-range-finalization.ts'
import { continueCiCorrection, continueReviewBoundFix } from './feature-ci-correction.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { resumePausedFeature } from './feature-continuation-dispatch.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { payload } from './feature-engine.ts'
import { runEpicPostMergeHook } from './feature-epic-actions.ts'
import { landFeature } from './feature-landing.ts'
import { landingContinuation } from './feature-landing-continuation.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'

type ContinueAtTarget = (
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
  noImplicitResume?: boolean,
  completedReport?: boolean,
  /** Cause of an engine re-entry after landing; the engine may not select `land` again in this call. */
  landingReentry?: string,
) => Promise<ContinueFeatureResult>

export async function coordinateContinuationEffects(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  action: string,
  pause: PauseBinding | undefined,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const { authority, number, mandateRef } = selected
  const { context } = authority
  switch (action) {
    case 'fix':
      return observation.decisions.reviewStep === 'fix-ci'
        ? continueCiCorrection(authority, observation, selected.reader ?? input.read ?? input.uw)
        : continueReviewBoundFix(selected, observation)
    case 'land':
      return coordinateLanding(input, exactMandateRef, authority, observation, continueAtTarget)
    case 'resume':
      return resumeFeature(pause, input, exactMandateRef, authority, observation, continueAtTarget)
    case 'epic-next':
      return continueEpicNext(input, context.cwd, context.git, context.gh, number, continueAtTarget)
    case 'epic-final':
      return input.uw === undefined
        ? { kind: 'blocked', reason: 'prepare-action-unavailable' }
        : prepareEpicFinal(context.cwd, context.git, context.gh, number, mandateRef, input.uw, input.pluginPin)
    case 'hook':
      return coordinateHook(input, exactMandateRef, authority, observation, number, continueAtTarget)
    case 'report':
      return reportEpic(input, exactMandateRef, selected, continueAtTarget)
    default:
      return { kind: 'blocked', reason: `action-unwired:${action}` }
  }
}

async function resumeFeature(
  pause: PauseBinding | undefined,
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  observation: FeatureObservation,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  if (pause === undefined) return { kind: 'blocked', reason: 'resume-pause-missing' }
  const resumed = await resumePausedFeature({ pause, authority, observation })
  return resumed ?? reenterCurrent(input, exactMandateRef, authority, continueAtTarget)
}

async function coordinateLanding(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  observation: FeatureObservation,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const { context } = authority
  const landed = await landFeature({
    loaded: context.engine,
    history: observation.evidence.issue,
    parents: observation.evidence.parents,
    causal: observation.evidence.causal,
    delivery: observation.delivery,
    gh: context.gh,
    git: context.git,
    cwd: context.cwd,
    ...(input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin }),
  })
  if ('kind' in landed) return landed
  const next = landingContinuation(landed)
  return next.kind === 'result'
    ? next.result
    : reenterCurrent(input, exactMandateRef, authority, continueAtTarget, next.cause)
}

function reenterCurrent(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  continueAtTarget: ContinueAtTarget,
  landingReentry?: string,
): Promise<ContinueFeatureResult> {
  const { context } = authority
  return continueAtTarget(
    { ...input, cwd: context.cwd, control: 'continue', principal: false, git: context.git, gh: context.gh },
    exactMandateRef,
    false,
    false,
    landingReentry,
  )
}

async function continueEpicNext(
  input: ContinueFeatureInput,
  cwd: string,
  git: FeatureAuthority['context']['git'],
  gh: FeatureAuthority['context']['gh'],
  epic: number,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  try {
    const step = (await epicNext(cwd, epic, false)).step
    return (step.action === 'start' || step.action === 'resume' || step.action === 'parent') &&
      typeof step.ticket === 'number'
      ? continueAtTarget({
          ...input,
          cwd,
          reference: `#${step.ticket}`,
          control: 'continue',
          principal: false,
          git,
          gh,
        })
      : heldEpicStep(step)
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-next-failed' }
  }
}

/**
 * Any live Epic step but a child to start or resume is unfinished work of the Epic itself: integration,
 * the final review, the post-merge hook, and the completion or drop report are engine actions of a fresh
 * `/feature` run. This call holds on that step; it neither ends the Epic nor starts that work.
 */
function heldEpicStep(step: EpicStep): ContinueFeatureResult {
  const reason =
    step.action === 'drop' || step.action === 'stop' ? `epic-${step.action}:${step.stop}` : `epic-${step.action}`
  const message = step.reason.trim()
  return {
    kind: 'blocked',
    reason,
    next: 'feature-reentry',
    ...(message === '' ? {} : { diagnostics: [{ code: `epic-${step.action}`, message }] }),
  }
}

async function prepareEpicFinal(
  cwd: string,
  git: FeatureAuthority['context']['git'],
  gh: FeatureAuthority['context']['gh'],
  epic: number,
  mandateRef: ScopedRecordRef | null,
  operations: NonNullable<ContinueFeatureInput['uw']>,
  pluginPin?: ContinueFeatureInput['pluginPin'],
): Promise<ContinueFeatureResult> {
  if (mandateRef === null) return { kind: 'blocked', reason: 'epic-final-mandate-missing' }
  try {
    const request = await epicFinalReviewRequest(cwd, epic)
    return {
      kind: 'epic-final-review',
      review: await prepareEpicFinalReviewMaterials({ cwd, request, mandateRef, git, gh, operations, pluginPin }),
    }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-final-unprepared' }
  }
}

async function coordinateHook(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  observation: FeatureObservation,
  epic: number,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const { context } = authority
  const selected = context.engine.selectApplicableMandate(
    observation.evidence.issue,
    observation.evidence.parents,
    observation.evidence.causal,
  )
  if (selected.status !== 'applicable' || selected.mandate === null || selected.mandate.kind !== 'mandate')
    return { kind: 'blocked', reason: 'hook-mandate-missing' }
  const mandate = selected.mandate
  const parent = payload(mandate).parent
  const accepted = context.engine.resolveAcceptedSpec(mandate, observation.evidence.causal.histories)
  if (!accepted.ok) return { kind: 'blocked', reason: 'hook-spec-unreadable', diagnostics: accepted.evidence }
  const role = context.engine.effectiveMandateRole(mandate.payload.role, accepted.spec)
  if (role === 'feature') {
    if (!isMandateReference(parent)) return { kind: 'blocked', reason: 'parent-mandate-unreadable' }
    return continueAtTarget(
      {
        ...input,
        cwd: context.cwd,
        reference: parent.scope.target,
        control: 'continue',
        principal: false,
        git: context.git,
        gh: context.gh,
      },
      parent,
    )
  }
  if (role !== 'epic') return { kind: 'blocked', reason: 'epic-hook-role' }
  try {
    await runEpicPostMergeHook(context.cwd, epic)
    return reenterCurrent(input, exactMandateRef, authority, continueAtTarget)
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-hook-failed' }
  }
}

async function reportEpic(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const { context } = selected.authority
  try {
    const step = await epicStep(context.cwd, selected.number)
    const outcome = step.name === 'drop' ? 'drop' : 'complete'
    await epicReport(context.cwd, selected.number, outcome, outcome === 'drop' ? 'epic-drop' : '')
    if (outcome === 'complete' && selected.mandate?.payload.parent?.kind === 'mandate') {
      return continueAtTarget(
        { ...input, cwd: context.cwd, control: 'continue', principal: false, git: context.git, gh: context.gh },
        exactMandateRef ?? selected.mandateRef ?? undefined,
        true,
        true,
      )
    }
    return { kind: 'terminal', reason: `epic-${outcome}` }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-report-failed' }
  }
}

function isMandateReference(value: unknown): value is ScopedRecordRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scope' in value &&
    typeof value.scope === 'object' &&
    value.scope !== null &&
    'repository' in value.scope &&
    typeof value.scope.repository === 'string' &&
    'target' in value.scope &&
    typeof value.scope.target === 'string' &&
    'recordId' in value &&
    typeof value.recordId === 'string' &&
    'kind' in value &&
    value.kind === 'mandate'
  )
}
