import type { ScopedRecordRef } from '../engine/record-references.ts'
import { mandatesInHistory } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { bindsOwnPause, publishConfirmedPause } from './feature-control.ts'
import { disarmKnownTarget } from './feature-disarm.ts'
import { mandateBranch } from './feature-selection.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwOperationResult, UwOperations } from './uw-contract.ts'

/** Publishes the source pause or abandon control after authority admission. */
export async function applyFeatureControl(
  control: 'pause' | 'abandon',
  authority: FeatureAuthority,
  uw?: UwOperations,
): Promise<ContinueFeatureResult> {
  const { context, history, scope, selection, target, parentHistories } = authority
  const pausedOwnMandateId = ownPausedMandateId(control, authority)
  const pausedOwnMandate =
    pausedOwnMandateId === null
      ? null
      : (mandatesInHistory(history).find((candidate) => candidate.recordId === pausedOwnMandateId) ?? null)
  const mandate = selection.status === 'applicable' ? selection.mandate : pausedOwnMandate
  if (mandate === null) {
    await disarmKnownTarget(context.gh, context.cwd, target, null)
    return { kind: 'blocked', reason: control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  const accepted = context.engine.resolveAcceptedSpec(mandate, authority.causal.histories)
  if (!accepted.ok) {
    await disarmKnownTarget(context.gh, context.cwd, target, null)
    return { kind: 'blocked', reason: control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  const role = context.engine.effectiveMandateRole(mandate.payload.role, accepted.spec)
  const branch = mandateBranch(mandate)
  const mandateRef: ScopedRecordRef & { kind: 'mandate' } = {
    scope: history.source.scope,
    recordId: mandate.recordId,
    kind: 'mandate',
  }
  if (control === 'pause') {
    return publishConfirmedPause({
      loaded: context.engine,
      history,
      scope,
      target,
      gh: context.gh,
      cwd: context.cwd,
      parentHistories,
      mandate: mandateRef,
      role,
      branch,
      options: withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }),
    })
  }
  if (uw === undefined) {
    await disarmKnownTarget(context.gh, context.cwd, target, role, branch, {
      loaded: context.engine,
      mandate: mandateRef,
    })
    return { kind: 'abandoned', confirmed: false }
  }
  const result = await uw.abandon(scope, mandateRef)
  if (result.status === 'deferred')
    return { kind: 'blocked', reason: 'operator-confirmation-deferred', diagnostics: result.diagnostics }
  if (result.status !== 'abandoned') return failedAbandonment(result)
  const disarmed = await disarmKnownTarget(context.gh, context.cwd, target, role, branch, {
    loaded: context.engine,
    mandate: mandateRef,
  })
  return disarmed.clean
    ? { kind: 'abandoned', confirmed: true }
    : { kind: 'abandoned', confirmed: false, failure: { phase: 'disarm', evidence: disarmed.evidence } }
}

function ownPausedMandateId(control: 'pause' | 'abandon', authority: FeatureAuthority): string | null {
  const { context, selection, history, scope } = authority
  return control === 'abandon' &&
    selection.status === 'refused' &&
    selection.reason === 'paused' &&
    bindsOwnPause(context.engine, selection, history, scope)
    ? selection.pause.mandate.recordId
    : null
}

function failedAbandonment(
  result: Exclude<UwOperationResult, { status: 'abandoned' | 'deferred' }>,
): ContinueFeatureResult {
  return {
    kind: 'abandoned',
    confirmed: false,
    failure: { phase: 'uw', status: result.status, diagnostics: 'diagnostics' in result ? result.diagnostics : [] },
  }
}
