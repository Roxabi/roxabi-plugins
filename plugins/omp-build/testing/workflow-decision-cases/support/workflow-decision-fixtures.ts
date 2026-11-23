import { decodeHistory } from '../../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../../../engine/action-input.ts'
import type { ActionInputs } from '../../../engine/action-input-schema.ts'
import type { DecodedHistory } from '../../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../../engine/record-schema.ts'
import type { Scope } from '../../../engine/record-values.ts'
import { resolveSpecEffective } from '../../../engine/spec-effective.ts'
import type { SpecEffective } from '../../../engine/spec-effective-schema.ts'
import { resolveAcceptedSpec } from '../../../engine/workflow-accepted-spec.ts'
import type { MandateRecord } from '../../../engine/workflow-control.ts'
import type { PlanOutput } from '../../../engine/workflow-output-schema.ts'
import { pinAcceptedSources } from '../../../roxabi/uw-action-observe.ts'
import { roxabiWorkflowFixtures } from '../../roxabi-presets.ts'

const WORKFLOW_FIXTURES = roxabiWorkflowFixtures()

export const SCOPE: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
export const EPIC: Scope = { repository: 'acme/widgets', target: 'acme/widgets#1' }
export const PR: Scope = { repository: 'acme/widgets', target: 'acme/widgets#20' }
export const HEAD = '1111111111111111111111111111111111111111'
export const BRANCH = 'feat/42-save'
export const BODY = '## Acceptance\n- [ ] Save keeps the selected region'

function fixtureConfig() {
  const mandate = WORKFLOW_FIXTURES.featureMandate(SCOPE, { body: BODY })
  return { config: mandate.payload.config }
}

export function blank(scope: Scope = SCOPE): DecodedHistory {
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
}

export function landingConfigFacts(mandate: MandateRecord | null) {
  const config = mandate?.payload.config ?? fixtureConfig().config
  return {
    productVersion: config.productVersion,
    configVersion: config.version,
    configDigest: config.digest,
    supportedConfigVersions: [config.version],
  }
}

export function shippedMandate(): MandateRecord {
  return WORKFLOW_FIXTURES.featureMandate(SCOPE, { body: BODY })
}

export function authenticatedPlanFixtures(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  effective?: SpecEffective,
  planOutput?: PlanOutput,
  codeRange?: ActionInputs['manifest']['code'],
) {
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) throw new Error(`Plan basis is not authenticated: ${JSON.stringify(accepted)}`)
  const resolved = resolveSpecEffective({
    mode: 'historical',
    own: accepted.spec.ref,
    versionVector: [accepted.spec.ref, ...accepted.spec.inheritedOwnSpecRefs],
    histories,
  })
  if (!resolved.ok) throw new Error(`Plan vector is not authenticated: ${JSON.stringify(resolved.diagnostics)}`)
  if (effective !== undefined && canonicalValueDigest(effective) !== canonicalValueDigest(resolved.value))
    throw new Error('Declared plan vector differs from the authenticated accepted vector')
  const pins = pinAcceptedSources(histories, accepted.spec.sourceRefs)
  if (!pins.ok) throw new Error(`Plan sources are not authenticated: ${JSON.stringify(pins.diagnostics)}`)
  return {
    workflow: roxabiWorkflowFixtures(resolved.value, planOutput, pins.value, codeRange),
    version: accepted.spec.ref.version,
  }
}

export function eligiblePlan(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  effective?: SpecEffective,
  planOutput?: PlanOutput,
  codeRange?: ActionInputs['manifest']['code'],
): CanonicalRecord[] {
  const { workflow, version } = authenticatedPlanFixtures(mandate, histories, effective, planOutput, codeRange)
  const digest = workflow.publishedPlanDigest()
  return [
    mandate,
    ...workflow.planDraftRecords(mandate, 'act-plan-1', version),
    workflow.planReviewStart(mandate, 'act-plan-1', digest, 'act-plan-review-1', version),
    workflow.planReviewRecord(
      mandate,
      'act-plan-1',
      digest,
      [
        workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      'act-plan-review-1',
      version,
    ),
  ]
}
/** Bind the canonical plan fixtures to the explicitly declared checkout before framing them. */
export function eligiblePlanAt(
  mandate: MandateRecord,
  commit: string,
  histories: readonly DecodedHistory[],
  effective?: SpecEffective,
  planOutput?: PlanOutput,
) {
  return eligiblePlan(mandate, histories, effective, planOutput, {
    repository: mandate.repository,
    base: commit,
    head: commit,
    referenceCommit: commit,
  })
}

export function hasAction(history: DecodedHistory, action: string): boolean {
  return history.operations.some((operation) => {
    const record = operation.record
    return record?.kind === 'action-receipt' && record.payload.action === action
  })
}
