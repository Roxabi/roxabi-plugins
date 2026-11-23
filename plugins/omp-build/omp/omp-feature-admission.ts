import { isAbsolute } from 'node:path'
import {
  canonicalValueDigest,
  classifyAttempts,
  INTERRUPTION_ACTIONS,
  interruptionGate,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  outstandingPauseInAuthority,
  readNativePullRequestFacts,
  resolveAcceptedSpec,
  resolveSpecEffective,
  type SpecEffective,
  selectWorkflowBinding,
} from '../dist/contracts.js'
import { type FeatureAuthority, resolveFeatureAuthority } from '../roxabi/feature-continuation-admission.ts'
import { applyFeatureControl } from '../roxabi/feature-continuation-controls.ts'
import { resumePausedFeature } from '../roxabi/feature-continuation-dispatch.ts'
import {
  assembleObservationBase,
  type FeatureAdmissionObservation,
} from '../roxabi/feature-continuation-observation.ts'
import { type SelectedFeature, selectFeatureMandate } from '../roxabi/feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from '../roxabi/feature-contract.ts'
import { bindsOwnPause, inhibition } from '../roxabi/feature-control.ts'
import { resolveFeatureInterruption } from '../roxabi/feature-interruption.ts'
import { requireMandateCheckout } from '../roxabi/feature-selection.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { acceptOwnMaterialDecision } from '../roxabi/workflow-material-decision.ts'

export type FeatureReady = {
  kind: 'ready'
  repository: string
  issue: number
  mandate: string
  branch: string
  base: string
  worktree: string
  acceptedSpec: SpecEffective
  acceptedBodySha256: string
  liveIssueBodyDiffers: boolean
  pr?: number
}

export type Admission = ContinueFeatureResult | FeatureReady

function blocked(reason: string): ContinueFeatureResult {
  return { kind: 'blocked', reason }
}

function pausedMandate(authority: FeatureAuthority): MandateRecord | undefined {
  const { selection, history, scope, context } = authority
  if (selection.status !== 'refused' || selection.reason !== 'paused') return undefined
  if (!bindsOwnPause(context.engine, selection, history, scope)) return undefined
  return mandatesOf(history).find((record) => record.recordId === selection.pause.mandate.recordId)
}

async function resumeSelectedFeature(
  input: ContinueFeatureInput,
  authority: FeatureAuthority,
  observation: FeatureAdmissionObservation,
  mandate: MandateRecord,
): Promise<Admission> {
  const { facts, evidence } = observation
  const { selection } = authority
  if (selection.status !== 'refused' || selection.reason !== 'paused') return blocked('resume-pause-missing')
  const config = mandate.payload.config
  if (config.productVersion !== facts.productVersion || config.digest !== facts.configDigest)
    return blocked('config-drift')
  if (!facts.supportedConfigVersions.includes(config.version)) return blocked('unsupported-config')
  const checkout = await requireMandateCheckout({
    cwd: input.cwd,
    git: authority.context.git,
    scope: authority.scope,
    mandate,
  })
  if (checkout !== null) return checkout
  const scan = evidence.pullRequest === null ? [evidence.issue] : [evidence.issue, evidence.pullRequest]
  const scope = mandateScope(mandate)
  const attempts = interruptionGate(
    classifyAttempts({
      histories: [...scan, ...evidence.causal.histories],
      scan,
      actions: INTERRUPTION_ACTIONS,
      select: (record) => {
        const ref = record.payload.mandate
        return (
          'scope' in ref &&
          ref.recordId === mandate.recordId &&
          ref.scope.repository === scope.repository &&
          ref.scope.target === scope.target
        )
      },
    }),
  )
  if (attempts.kind === 'stop') {
    const diagnostics = attempts.completion.evidence
    const reason =
      attempts.completion.status === 'uncertain' ? 'action-uncertain' : (diagnostics[0]?.code ?? 'interruption-invalid')
    return { kind: 'blocked', reason, diagnostics }
  }
  if (input.owned?.() === false) return blocked('continuation-owner-revoked')
  const resumed = await resumePausedFeature({ pause: selection.pause, authority, observation })
  return resumed ?? admitFeature({ ...input, control: 'continue' })
}

function deliveryStop(observation: FeatureAdmissionObservation): ContinueFeatureResult | null {
  const { deliveryAdmission } = observation
  if (deliveryAdmission === null) return blocked('uw-delivery-admission-required')
  const diagnostics =
    'diagnostics' in deliveryAdmission
      ? deliveryAdmission.diagnostics
      : deliveryAdmission.admission.deliverable.diagnostics
  if (diagnostics.length > 0) return { kind: 'blocked', reason: 'uw-delivery-admission-refused', diagnostics }
  return null
}

async function boundOpenPr(
  authority: FeatureAuthority,
  mandate: MandateRecord,
  observation: FeatureAdmissionObservation,
) {
  const { delivery, evidence } = observation
  if (delivery === null || delivery.branch !== mandate.payload.branch || delivery.base !== mandate.payload.base)
    return undefined
  const binding = selectWorkflowBinding({
    pullRequest: delivery.scope,
    histories: evidence.causal.histories,
    native: { branch: delivery.branch, base: delivery.base },
  })
  if (
    binding.status !== 'bound' ||
    binding.mandateRecord.recordId !== mandate.recordId ||
    binding.mandateRecord.repository !== mandate.repository ||
    binding.mandateRecord.target !== mandate.target
  )
    return undefined
  const { context, scope } = authority
  const live = await readNativePullRequestFacts(scope.repository, delivery.number, withRoxabiGitHubPolicy(context))
  return live.state === 'OPEN' && live.branch === delivery.branch && live.base === delivery.base
    ? delivery.number
    : undefined
}

export async function admitFeature(input: ContinueFeatureInput, classified?: () => void): Promise<Admission> {
  const authority = await resolveFeatureAuthority(input)
  if ('kind' in authority) return authority
  if (input.owned?.() === false) return blocked('continuation-owner-revoked')
  const { control } = input
  if (control === 'pause' || control === 'abandon') {
    classified?.()
    return applyFeatureControl(control, authority, input.uw)
  }
  if (control === 'resolve-interruption') {
    classified?.()
    return resolveFeatureInterruption(input, authority)
  }
  if (control === 'material-decision') {
    classified?.()
    return acceptOwnMaterialDecision(input, authority, async () => ({
      kind: 'terminal',
      reason: 'material-decision-accepted',
    }))
  }
  const reader = input.read ?? input.uw
  const selected = await selectFeatureMandate(control, undefined, authority, input.uw, reader, input.owned)
  if ('kind' in selected) return selected
  classified?.()
  return admitSelectedFeature(input, selected)
}

async function admitPausedFeature(input: ContinueFeatureInput, selected: SelectedFeature): Promise<Admission> {
  const { authority } = selected
  if (input.control !== 'resume' || authority.onPrincipal) return { kind: 'paused', confirmed: true, reason: 'paused' }
  const mandate = pausedMandate(authority)
  if (mandate === undefined) return { kind: 'paused', confirmed: true, reason: 'paused' }
  const accepted = resolveAcceptedSpec(mandate, authority.causal.histories)
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing', diagnostics: accepted.evidence }
  const observation = await assembleObservationBase({ ...selected, mandate, acceptedSpec: accepted.spec })
  if ('kind' in observation) return observation
  return resumeSelectedFeature(input, authority, observation, mandate)
}

async function admitSelectedFeature(input: ContinueFeatureInput, selected: SelectedFeature): Promise<Admission> {
  const issueAuthority = selected.authority
  const { selection, context, identity, scope } = issueAuthority
  if (selection.status === 'refused') {
    if (selection.reason === 'paused') return admitPausedFeature(input, selected)
    return { kind: 'blocked', reason: selection.reason, diagnostics: selection.evidence }
  }
  const { mandate, acceptedSpec } = selected
  if (mandate === null || acceptedSpec === null) return blocked('mandate-spec-missing')
  if (inhibition(scope) !== undefined) return blocked('continuation-inhibited')
  if (issueAuthority.onPrincipal || input.principal || !identity.ok || !isAbsolute(identity.sessionTop))
    return blocked('session-not-intended-worktree')
  const checkout = await requireMandateCheckout({ cwd: input.cwd, git: context.git, scope, mandate })
  if (checkout !== null) return checkout
  const observation = await assembleObservationBase(selected)
  if ('kind' in observation) return observation
  const effective = readySpec(observation, mandate, acceptedSpec)
  if ('kind' in effective) return effective
  const { base, branch } = mandate.payload
  if (base === null || branch === null) return blocked('mandate-checkout-unreadable')
  const pr = await boundOpenPr(issueAuthority, mandate, observation)
  return {
    kind: 'ready',
    repository: scope.repository,
    issue: selected.number,
    mandate: mandate.recordId,
    branch,
    base,
    worktree: identity.sessionTop,
    acceptedSpec: effective,
    acceptedBodySha256: acceptedSpec.snapshot.raw.bodySha256,
    liveIssueBodyDiffers: selected.issue.body !== acceptedSpec.snapshot.raw.body,
    ...(pr === undefined ? {} : { pr }),
  }
}

function readySpec(
  observation: FeatureAdmissionObservation,
  mandate: MandateRecord,
  acceptedSpec: NonNullable<SelectedFeature['acceptedSpec']>,
): ContinueFeatureResult | SpecEffective {
  const outstandingPause = outstandingPauseInAuthority(mandate, [
    observation.evidence.issue,
    ...observation.evidence.causal.histories,
  ])
  if (outstandingPause !== null) return { kind: 'paused', confirmed: false, reason: outstandingPause.code }
  const problem = deliveryStop(observation)
  if (problem !== null) return problem
  const current = observation.facts.currentSpec
  if (
    current === null ||
    current.snapshot.spec.version !== acceptedSpec.snapshot.spec.version ||
    current.tier !== acceptedSpec.tier ||
    current.children.length !== 0 ||
    canonicalValueDigest(current.inheritedOwnSpecRefs) !== canonicalValueDigest(acceptedSpec.inheritedOwnSpecRefs) ||
    canonicalValueDigest(current.coverage) !== canonicalValueDigest(acceptedSpec.coverage)
  )
    return { kind: 'operator-decision', reason: 'material-spec' }
  const causal = observation.evidence.causal
  const effective = resolveSpecEffective({
    mode: 'current',
    own: acceptedSpec.ref,
    histories: causal.histories,
    graph: causal.observation.graph,
  })
  return effective.ok ? effective.value : { kind: 'operator-decision', reason: 'material-spec' }
}
