import { describe, expect, it } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { fictionalNoneIdentifiedEffectIntent } from '../../testing/context-effect-review-fixture.ts'
import { CONTEXT_EFFECTS_SCOPE, contextEffectsToolCall } from '../../testing/context-effects-unit-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { MissingContextOutput } from '../action-context.ts'
import type { ContextEffectIntent } from '../context-effect-review-schema.ts'
import { contextEffectSources } from '../context-effect-sources.ts'
import type { NativeToolObservation } from '../native-tool-observation-schema.ts'
import { buildRecord } from '../record-construction.ts'
import type { Contribution } from '../record-values.ts'
import { inspectContextEffectIntent } from '../workflow-context-effects.ts'
import type { MandateRecord, ReceiptRecord } from '../workflow-control.ts'

const MISSING_CONTEXT: MissingContextOutput = {
  outcome: 'missing-context',
  missing: [
    {
      locator: { kind: 'information-request', description: 'Outside effect disposition' },
      reason: 'Unreconciled outside effect remains open',
      targets: [],
    },
  ],
}

function observationFor(
  actionId: string,
  childId: string,
  sessionId: string,
  calls: NativeToolObservation['calls'],
): NativeToolObservation {
  return {
    format: 'omp-build-native-tool-observation/1',
    scope: 'guarded-tool-admission',
    actionId,
    childId,
    sessionId,
    boundary: 'closed',
    closedBy: 'settlement-fence',
    calls,
  }
}

function blockedImplementNegative(
  mandate: MandateRecord,
  actionId: string,
  observedTools: NativeToolObservation,
): ReceiptRecord {
  const fixtures = roxabiWorkflowFixtures()
  const start = fixtures.implementStart(mandate, actionId)
  const inputs = acceptedActionInputs(mandate, 'implement')
  const built = buildRecord({
    version: 1,
    recordId: `${actionId}-result`,
    runId: mandate.runId,
    operationId: `op-${actionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      phase: 'result',
      action: 'implement',
      actionId,
      mandate: {
        scope: CONTEXT_EFFECTS_SCOPE,
        recordId: mandate.recordId,
        kind: 'mandate',
      },
      start: {
        scope: CONTEXT_EFFECTS_SCOPE,
        recordId: start.recordId,
        kind: 'action-receipt',
      },
      exactInputs: { mandateId: mandate.recordId, planActionId: 'act-plan-1' },
      inputs,
      native: {
        completion: 'completed',
        strict: 'valid',
        raw: { id: observedTools.childId },
        observedTools,
      },
      structured: {
        outcome: 'blocked',
        commitSHAs: [],
        commands: [],
        criteria: [],
        missing: MISSING_CONTEXT.missing,
        reason: 'Unreconciled outside effect: fictional host file written outside checkout',
      },
      admission: null,
      diagnostics: [],
    },
  })
  if (!built.ok || built.value.kind !== 'action-receipt') throw new Error(JSON.stringify(built))
  return built.value
}

function blockedPlanReviewNestedNegative(options?: { rootObservedActionId?: string }): {
  chain: ReceiptRecord[]
  parentActionId: string
  specialistActionId: string
  specialistChildId: string
} {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: plan nested negative' })
  const planDigestValue = fixtures.publishedPlanDigest()
  const parentActionId = 'act-plan-review-parent'
  const specialistActionId = 'act-plan-architect-child'
  const adversarialActionId = 'act-plan-adversarial-child'
  const specialistChildId = 'plan-architect-child-1'
  const specialistSessionId = 'plan-architect-session-1'
  const inputs = acceptedActionInputs(mandate, 'plan-review')
  const specialistBinding = { actionId: specialistActionId, inputs }
  const adversarialBinding = { actionId: adversarialActionId, inputs }
  const slots = [
    {
      slotId: 'slot-architect',
      specialist: 'R-workflow-plan-architect' as const,
      action: specialistBinding,
    },
    {
      slotId: 'slot-adversarial',
      specialist: 'R-workflow-plan-adversarial' as const,
      action: adversarialBinding,
    },
  ]
  const bash = contextEffectsToolCall({ toolCallId: 'bash-plan-nested-1', toolName: 'bash', ordinal: 0 })
  const observed = observationFor(
    options?.rootObservedActionId ?? specialistActionId,
    specialistChildId,
    specialistSessionId,
    [bash],
  )
  const contributionObserved = observationFor(specialistActionId, specialistChildId, specialistSessionId, [bash])
  const architectContribution: Contribution = {
    content: 'action-result',
    inventoryId: null,
    host: {
      origin: 'native',
      phase: null,
      role: 'R-workflow-plan-architect',
      slotId: 'slot-architect',
      chunk: null,
      childId: specialistChildId,
      action: specialistBinding,
    },
    rawAttempts: [],
    native: {
      completion: 'completed',
      strict: 'valid',
      raw: { id: specialistChildId },
      observedTools: contributionObserved,
    },
    structured: MISSING_CONTEXT,
    findings: null,
  }
  const adversarialContribution: Contribution = {
    content: 'action-result',
    inventoryId: null,
    host: {
      origin: 'native',
      phase: null,
      role: 'R-workflow-plan-adversarial',
      slotId: 'slot-adversarial',
      chunk: null,
      childId: 'plan-adversarial-child-1',
      action: adversarialBinding,
    },
    rawAttempts: [],
    native: {
      completion: 'completed',
      strict: 'valid',
      raw: { id: 'plan-adversarial-child-1' },
    },
    structured: { outcome: 'clear', blockers: [] },
    findings: null,
  }
  const start = buildRecord({
    version: 1,
    recordId: `${parentActionId}-start`,
    runId: mandate.runId,
    operationId: `op-${parentActionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      phase: 'start',
      action: 'plan-review',
      actionId: parentActionId,
      mandate: {
        scope: CONTEXT_EFFECTS_SCOPE,
        recordId: mandate.recordId,
        kind: 'mandate',
      },
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: mandate.payload.ownSpec.version,
        planDigest: planDigestValue,
        draftActionId: 'act-plan-1',
      },
      inputs,
      slots,
    },
  })
  if (!start.ok || start.value.kind !== 'action-receipt') throw new Error(JSON.stringify(start))
  const result = buildRecord({
    version: 1,
    recordId: `${parentActionId}-result`,
    runId: mandate.runId,
    operationId: `op-${parentActionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      phase: 'result',
      action: 'plan-review',
      actionId: parentActionId,
      mandate: {
        scope: CONTEXT_EFFECTS_SCOPE,
        recordId: mandate.recordId,
        kind: 'mandate',
      },
      start: {
        scope: CONTEXT_EFFECTS_SCOPE,
        recordId: start.value.recordId,
        kind: 'action-receipt',
      },
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: mandate.payload.ownSpec.version,
        planDigest: planDigestValue,
        draftActionId: 'act-plan-1',
      },
      inputs,
      slots,
      contributions: [architectContribution, adversarialContribution],
      native: {
        completion: 'completed',
        strict: 'valid',
        raw: { id: specialistChildId },
        observedTools: observed,
      },
      structured: MISSING_CONTEXT,
      admission: null,
      diagnostics: [],
    },
  })
  if (!result.ok || result.value.kind !== 'action-receipt') throw new Error(JSON.stringify(result))
  return {
    chain: [result.value],
    parentActionId,
    specialistActionId,
    specialistChildId,
  }
}

describe('context effect source identity regressions', () => {
  it('admits plan-review root native that carries specialist child observedTools identity', () => {
    const { chain, parentActionId, specialistActionId } = blockedPlanReviewNestedNegative()
    expect(parentActionId).not.toBe(specialistActionId)
    const collected = contextEffectSources(chain)
    expect(collected.ok).toBe(true)
    if (!collected.ok) throw new Error(JSON.stringify(collected.diagnostics))
    const root = chain[0]
    if (root?.payload.phase !== 'result' || root.payload.action !== 'plan-review') {
      throw new Error('fixture-required:plan-review-result')
    }
    expect(root.payload.actionId).toBe(parentActionId)
    expect(root.payload.native.observedTools?.actionId).toBe(specialistActionId)
    const intent = fictionalNoneIdentifiedEffectIntent(collected.value.sources)
    expect(inspectContextEffectIntent(chain, intent).ok).toBe(true)
  })

  it('refuses plan-review root native whose observedTools actionId matches neither root nor contribution', () => {
    const { chain, parentActionId, specialistActionId } = blockedPlanReviewNestedNegative({
      rootObservedActionId: 'act-plan-foreign-observer',
    })
    expect(parentActionId).not.toBe('act-plan-foreign-observer')
    expect(specialistActionId).not.toBe('act-plan-foreign-observer')
    expect(contextEffectSources(chain).ok).toBe(false)
  })

  it('admits exact source-identity coverage regardless of intent negative presentation order', () => {
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: exact source identity coverage' })
    const firstActionId = 'act-impl-outside-a'
    const secondActionId = 'act-impl-outside-b'
    const firstObserved = observationFor(firstActionId, 'child-outside-a', 'session-outside-a', [
      contextEffectsToolCall({ toolCallId: 'bash-outside-a', toolName: 'bash', ordinal: 0 }),
    ])
    const secondObserved = observationFor(secondActionId, 'child-outside-b', 'session-outside-b', [
      contextEffectsToolCall({ toolCallId: 'bash-outside-b', toolName: 'bash', ordinal: 0 }),
    ])
    const first = blockedImplementNegative(mandate, firstActionId, firstObserved)
    const second = blockedImplementNegative(mandate, secondActionId, secondObserved)
    const chain = [first, second] as const
    const collected = contextEffectSources(chain)
    expect(collected.ok).toBe(true)
    if (!collected.ok) throw new Error(JSON.stringify(collected.diagnostics))
    expect(collected.value.sources).toHaveLength(2)
    const orderedIntent = fictionalNoneIdentifiedEffectIntent(collected.value.sources)
    const reversedIntent: ContextEffectIntent = {
      ...orderedIntent,
      negatives: [...orderedIntent.negatives].reverse(),
    }
    expect(reversedIntent.negatives.map((negative) => negative.source.record.recordId)).toEqual([
      second.recordId,
      first.recordId,
    ])
    expect(collected.value.sources.map((source) => source.source.record.recordId)).toEqual([
      first.recordId,
      second.recordId,
    ])
    expect(inspectContextEffectIntent(chain, reversedIntent).ok).toBe(true)
    expect(inspectContextEffectIntent(chain, orderedIntent).ok).toBe(true)
  })
})
