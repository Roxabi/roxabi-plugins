import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { ContextEffectIntent } from '../engine/context-effect-review-schema.ts'
import { contextEffectSources } from '../engine/context-effect-sources.ts'
import type { NativeObservedToolCall, NativeToolObservation } from '../engine/native-tool-observation-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

export const CONTEXT_EFFECTS_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const CONTEXT_EFFECTS_CHILD_ID = 'implement-child-1'
export const CONTEXT_EFFECTS_SESSION_ID = 'implement-session-1'
export const CONTEXT_EFFECTS_ACTION_ID = 'act-implement-1'

/** Fixture element must exist; never optional-chain away a control or skip the case. */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture-required:${label}`)
  return value
}

export function contextEffectsToolCall(
  overrides: Partial<NativeObservedToolCall> & Pick<NativeObservedToolCall, 'toolCallId' | 'toolName'> = {
    toolCallId: 'bash-outside-1',
    toolName: 'bash',
  },
): NativeObservedToolCall {
  return {
    ordinal: 0,
    inputDigest: 'a'.repeat(64),
    resultDigest: 'b'.repeat(64),
    completion: 'returned',
    isError: false,
    exitCode: 0,
    ...overrides,
  }
}

export function contextEffectsObservation(calls: NativeObservedToolCall[]): NativeToolObservation {
  return {
    format: 'omp-build-native-tool-observation/1',
    scope: 'guarded-tool-admission',
    actionId: CONTEXT_EFFECTS_ACTION_ID,
    childId: CONTEXT_EFFECTS_CHILD_ID,
    sessionId: CONTEXT_EFFECTS_SESSION_ID,
    boundary: 'closed',
    closedBy: 'settlement-fence',
    calls,
  }
}

export function blockedOutsideEffectImplement(
  mandate: MandateRecord,
  observedTools?: NativeToolObservation,
): ReceiptRecord {
  const fixtures = roxabiWorkflowFixtures()
  const start = fixtures.implementStart(mandate, CONTEXT_EFFECTS_ACTION_ID)
  const inputs = acceptedActionInputs(mandate, 'implement')
  const built = buildRecord({
    version: 1,
    recordId: `${CONTEXT_EFFECTS_ACTION_ID}-result`,
    runId: mandate.runId,
    operationId: `op-${CONTEXT_EFFECTS_ACTION_ID}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      phase: 'result',
      action: 'implement',
      actionId: CONTEXT_EFFECTS_ACTION_ID,
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
        raw: { id: CONTEXT_EFFECTS_CHILD_ID },
        ...(observedTools === undefined ? {} : { observedTools }),
      },
      structured: {
        outcome: 'blocked',
        commitSHAs: [],
        commands: [],
        criteria: [],
        missing: [
          {
            locator: { kind: 'information-request', description: 'Outside effect disposition' },
            reason: 'Unreconciled outside effect remains open',
            targets: [],
          },
        ],
        reason: 'Unreconciled outside effect: fictional host file written outside checkout',
      },
      admission: null,
      diagnostics: [],
    },
  })
  if (!built.ok || built.value.kind !== 'action-receipt') throw new Error(JSON.stringify(built))
  return built.value
}

export function contextEffectSourceRef(record: ReceiptRecord): ContextEffectIntent['negatives'][number]['source'] {
  return {
    source: 'record',
    record: { scope: CONTEXT_EFFECTS_SCOPE, recordId: record.recordId, kind: 'action-receipt' },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
}

export function outsideEffectFixtureChain() {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: persist the region' })
  const bash = contextEffectsToolCall()
  const observed = contextEffectsObservation([bash])
  const negative = blockedOutsideEffectImplement(mandate, observed)
  return { mandate, bash, observed, negative, chain: [negative] as const }
}

export function coveringOutsideEffectIntent(
  negative: ReceiptRecord,
  observed: NativeToolObservation,
  bash: NativeObservedToolCall,
  options: {
    report?: ContextEffectIntent['negatives'][number]['reportConclusion']
    call?: ContextEffectIntent['negatives'][number]['calls'][number]['conclusion']
    resources?: ContextEffectIntent['resources']
    callDigest?: string
  } = {},
): ContextEffectIntent {
  const sources = contextEffectSources([negative])
  if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
  const inventory = required(sources.value.sources[0], 'covering-intent-source').inventory
  const resource =
    options.resources ??
    ([
      {
        key: 'outside-file',
        absolutePath: '/tmp/omp-fictional-outside-effect.txt',
        basis: 'accept-named-state' as const,
        expected: { kind: 'absent' as const },
      },
    ] satisfies ContextEffectIntent['resources'])
  const localFiles = {
    kind: 'local-files' as const,
    resourceKeys: ['outside-file'],
    reason: 'Named outside file attributed to the conserved Bash call',
  }
  return {
    format: 'omp-build-context-effect-intent/1',
    negatives: [
      {
        source: contextEffectSourceRef(negative),
        inventory,
        reportConclusion: options.report ?? localFiles,
        calls: [
          {
            childId: observed.childId,
            sessionId: observed.sessionId,
            ordinal: bash.ordinal,
            toolCallId: bash.toolCallId,
            callDigest: options.callDigest ?? canonicalValueDigest(bash),
            // Legitimate many-to-one: report and writer call may share the same named file.
            conclusion: options.call ?? localFiles,
          },
        ],
      },
    ],
    resources: resource,
  }
}
