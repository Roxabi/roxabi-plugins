import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { PauseBinding } from '../engine/workflow-control.ts'
import { epicFinalReviewRequest, epicNext, epicReport, epicStep } from '../skills/feature/epic-driver.ts'
import { featureLandOutcome } from '../skills/feature/workflow-outcome.js'
import { prepareEpicFinalReviewMaterials } from './epic-range-finalization.ts'
import { continueCiCorrection, continueReviewBoundFix } from './feature-ci-correction.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { resumePausedFeature } from './feature-continuation-dispatch.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { payload } from './feature-engine.ts'
import { fileEpicFixTicket, runEpicPostMergeHook } from './feature-epic-actions.ts'
import { landFeature } from './feature-landing.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'

type ContinueAtTarget = (
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
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
      return observation.facts.failedChecks === null
        ? continueReviewBoundFix(selected, observation)
        : continueCiCorrection(authority, observation, selected.reader ?? input.read ?? input.uw)
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
    case 'mark-fix':
      return fileEpicFix(input, exactMandateRef, authority, number, observation, continueAtTarget)
    case 'hook':
      return coordinateHook(input, exactMandateRef, authority, observation, number, continueAtTarget)
    case 'report':
      return reportEpic(context.cwd, number)
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

async function fileEpicFix(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  epic: number,
  observation: FeatureObservation,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const filed = await fileEpicFixTicket(authority.context.cwd, epic, observation.evidence.issue)
  return filed.kind === 'terminal' && filed.reason.startsWith('epic-fix-marked:')
    ? reenterCurrent(input, exactMandateRef, authority, continueAtTarget)
    : filed
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
    delivery: observation.delivery,
    gh: context.gh,
    git: context.git,
    cwd: context.cwd,
    ...(input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin }),
  })
  if ('kind' in landed) return landed
  const outcome = featureLandOutcome(landed)
  if (outcome.action === 'start-watch' || outcome.action === 'reattach-watch') {
    return typeof landed.watch === 'string'
      ? { kind: 'watch', command: landed.watch }
      : { kind: 'blocked', reason: 'watch-missing' }
  }
  if (outcome.action === 'report-merged') return reenterCurrent(input, exactMandateRef, authority, continueAtTarget)
  return outcome.action === 'stop' || outcome.action === 'blocked'
    ? { kind: 'terminal', reason: outcome.reason }
    : { kind: 'blocked', reason: outcome.action }
}

function reenterCurrent(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  continueAtTarget: ContinueAtTarget,
): Promise<ContinueFeatureResult> {
  const { context } = authority
  return continueAtTarget(
    { ...input, cwd: context.cwd, control: 'continue', principal: false, git: context.git, gh: context.gh },
    exactMandateRef,
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
    return (step.action === 'start' || step.action === 'resume') && typeof step.ticket === 'number'
      ? continueAtTarget({
          ...input,
          cwd,
          reference: `#${step.ticket}`,
          control: 'continue',
          principal: false,
          git,
          gh,
        })
      : { kind: 'terminal', reason: `epic-${step.action}` }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-next-failed' }
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
  const selected = context.engine.selectApplicableMandate(observation.evidence.issue, observation.evidence.parents)
  if (selected.status !== 'applicable' || selected.mandate === null || selected.mandate.kind !== 'mandate')
    return { kind: 'blocked', reason: 'hook-mandate-missing' }
  const mandate = selected.mandate
  const parent = payload(mandate).parent
  const accepted = context.engine.resolveAcceptedSpec(mandate, [
    observation.evidence.issue,
    ...observation.evidence.parents,
  ])
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

async function reportEpic(cwd: string, epic: number): Promise<ContinueFeatureResult> {
  try {
    const step = await epicStep(cwd, epic)
    const outcome = step.name === 'drop' ? 'drop' : 'complete'
    await epicReport(cwd, epic, outcome, outcome === 'drop' ? 'epic-drop' : '')
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
