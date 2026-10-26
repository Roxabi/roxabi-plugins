import { decodeHistory } from '../../../adapters/github/history-codec.ts'
import type { DecodedHistory } from '../../../engine/history-schema.ts'
import { specDigest } from '../../../engine/record-digests.ts'
import type { CanonicalRecord } from '../../../engine/record-schema.ts'
import type { Json, Scope } from '../../../engine/record-values.ts'
import type { MandateRecord } from '../../../engine/workflow-control.ts'
import { workflowConfigDigest } from '../../../roxabi/workflow-config-digest.ts'
import { roxabiWorkflowFixtures } from '../../roxabi-presets.ts'

const WORKFLOW_FIXTURES = roxabiWorkflowFixtures()

export const SCOPE: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
export const EPIC: Scope = { repository: 'acme/widgets', target: 'acme/widgets#1' }
export const PR: Scope = { repository: 'acme/widgets', target: 'acme/widgets#20' }
export const HEAD = '1111111111111111111111111111111111111111'
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

export function nodeGraph(action: 'implement' | 'stop' | 'fix' | 'review'): Json {
  const { config } = fixtureConfig()
  return {
    version: 1,
    productVersion: config.productVersion,
    configVersion: config.version,
    edgeOrder: 'array',
    nodes: [{ id: action, action }],
    edges: [],
    initial: action,
  }
}

export function graphConfig(action: 'implement' | 'stop' | 'fix' | 'review') {
  const { config } = fixtureConfig()
  return { version: config.version, digest: workflowConfigDigest(), effective: { graph: nodeGraph(action) } }
}

export function decisions(reviewStep: 'stop' | null = null, ciWatchStatus: 'green' | null = null) {
  return {
    reviewStep,
    epicStep: null,
    epicLand: null,
    ciWatchStatus,
    publish: { status: 'absent' as const, evidence: [] },
    landing: { status: 'absent' as const, evidence: [] },
    watch: { status: 'absent' as const, evidence: [] },
  }
}

export function facts(overrides: Partial<{ sessionCwd: string | null }> = {}) {
  const { config } = fixtureConfig()
  return {
    specDigest: specDigest(BODY),
    specBody: BODY,
    branch: 'feat/42-save',
    base: 'main',
    candidateGitSHA: HEAD,
    pullRequest: null,
    merged: false,
    sessionCwd: overrides.sessionCwd === undefined ? '/tmp/prepared-worktree' : overrides.sessionCwd,
    preparedWorktree: '/tmp/prepared-worktree',
    productVersion: config.productVersion,
    configVersion: config.version,
    configDigest: config.digest,
    supportedConfigVersions: [config.version],
    explicitSelection: false,
    explicitResume: false,
    successorAntecedent: null,
    endObligationsMet: false,
    localInhibit: null,
  }
}

export function factsForMandate(mandate: MandateRecord, overrides: Partial<{ sessionCwd: string | null }> = {}) {
  return { ...facts(overrides), configDigest: mandate.payload.config.digest }
}

export function shippedMandate(): MandateRecord {
  return WORKFLOW_FIXTURES.featureMandate(SCOPE, { body: BODY })
}

export function shippedFacts(
  pullRequest: { scope: Scope; head: string; base: string; associatedIssue: Scope | null } | null = null,
) {
  return { ...facts(), pullRequest }
}

export function eligiblePlan(mandate: MandateRecord): CanonicalRecord[] {
  const digest = WORKFLOW_FIXTURES.publishedPlanDigest()
  return [
    mandate,
    ...WORKFLOW_FIXTURES.planDraftRecords(mandate),
    WORKFLOW_FIXTURES.planReviewStart(mandate, 'act-plan-1', digest),
    WORKFLOW_FIXTURES.planReviewRecord(mandate, 'act-plan-1', digest, [
      WORKFLOW_FIXTURES.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      WORKFLOW_FIXTURES.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ]),
  ]
}

export function admittedImplement(mandate: MandateRecord): CanonicalRecord {
  const result = WORKFLOW_FIXTURES.rejectedImplementResult(mandate)
  if (result.kind !== 'action-receipt' || result.payload.phase !== 'result' || result.payload.admission === null) {
    throw new Error('expected a rejected implement result')
  }
  return { ...result, payload: { ...result.payload, admission: { ...result.payload.admission, admitted: true } } }
}

export function hasAction(history: DecodedHistory, action: string): boolean {
  return history.operations.some((operation) => {
    const record = operation.record
    return record?.kind === 'action-receipt' && record.payload.action === action
  })
}
