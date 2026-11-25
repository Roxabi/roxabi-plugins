import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { ContinueFeatureInput, ContinueFeatureResult } from '../roxabi/feature-contract.ts'
import type { FramingOperator } from '../roxabi/feature-framing-contract.ts'
import {
  featureResultStatus,
  featureSessionCwdMessage,
  featureStopMessage,
  principalRefusalMessage,
} from '../roxabi/feature-presentation.ts'
import { featureSpecDigest } from '../roxabi/feature-spec-digest.ts'
import { type OmpBuildExtensionApi, reportFeatureTerminalStatus } from './omp-controller'
import type { Admission, FeatureReady } from './omp-feature-admission.ts'
import type { FeatureOperationReportGuard } from './omp-feature-composition.ts'
import { stageFeatureDelivery } from './omp-feature-run.ts'
import type { FeatureFramingRuntime } from './omp-framing-runtime.ts'
import { sendSkillMessage } from './omp-skill-command-runtime.ts'

export async function deliverAdmission(
  composition: Readonly<{ pi: OmpBuildExtensionApi; framing: FeatureFramingRuntime; skillsDir: string }>,
  ctx: ExtensionContext,
  operator: FramingOperator,
  input: ContinueFeatureInput,
  result: Admission,
  body: string | undefined,
  guard: FeatureOperationReportGuard,
  originalArgs: string | null,
): Promise<void> {
  const { pi, framing, skillsDir } = composition
  if (!guard.isCurrent()) return
  if (result.kind === 'ready') {
    if (body === undefined) return
    const delivery = stageFeatureDelivery(pi, ctx, operator, result)
    try {
      await sendSkillMessage(pi, join(skillsDir, 'feature'), body, featureContext(result, delivery.id))
    } catch (error) {
      delivery.discard()
      throw error
    }
    return
  }
  if (result.kind === 'framing') {
    await framing.start({ ctx, operator, originalArgs, pluginPin: input.pluginPin }, result.source, guard.handoff)
    return
  }
  reportAdmissionStop(pi, ctx, input, result)
}

function featureContext(result: FeatureReady, deliveryId: string): string {
  const { repository, issue, mandate, branch, base, worktree, pr } = result
  return [
    '## Feature context',
    `repository: ${repository}`,
    `issue: ${issue}`,
    `mandate: ${mandate}`,
    `branch: ${branch}`,
    `base: ${base}`,
    `worktree: ${worktree}`,
    `delivery: ${deliveryId}`,
    ...(pr === undefined ? [] : [`pr: ${pr}`]),
    '',
    acceptedSpecContext(result),
  ].join('\n')
}

function acceptedSpecContext({ acceptedSpec, acceptedBodySha256, liveIssueBodyDiffers }: FeatureReady): string {
  const { own, spec, inherited } = acceptedSpec
  const { criteria, invariants, exclusions } = spec
  return [
    '## Accepted Spec',
    `spec: ${featureSpecDigest(acceptedSpec)}`,
    ...(liveIssueBodyDiffers ? ['The live issue body differs from the accepted snapshot.'] : []),
    '',
    '```json',
    JSON.stringify({ own, acceptedBodySha256, criteria, invariants, exclusions, inherited }, null, 2),
    '```',
  ].join('\n')
}

export function deliversSkill(control: ContinueFeatureInput['control']): boolean {
  return control === 'select' || control === 'new'
}

function reportAdmissionStop(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  input: ContinueFeatureInput,
  result: ContinueFeatureResult,
): void {
  if (result.kind === 'blocked' && result.reason === 'parent-delivery-suspended') {
    reportFeatureTerminalStatus(pi, 'Parent /feature delivery is suspended; resumes in slice 6 (#1031).')
    return
  }
  const stop = featureStopMessage(result)
  if (result.kind === 'session-cwd' && stop === null) {
    reportFeatureTerminalStatus(pi, featureSessionCwdMessage(result.path, result.instruction))
    return
  }
  const principalDispatch = input.principal && deliversSkill(input.control)
  const message = stop ?? `feature-stopped: workflow-result: ${result.kind}`
  if (result.kind === 'blocked') {
    ctx.ui?.setStatus?.('omp-build-watch', featureResultStatus(input.reference, result))
  }
  reportFeatureTerminalStatus(pi, principalDispatch ? principalRefusalMessage(ctx.cwd, message) : message)
}
