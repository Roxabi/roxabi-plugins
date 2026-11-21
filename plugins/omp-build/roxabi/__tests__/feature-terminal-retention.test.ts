import { beforeEach, describe, expect, it, vi } from 'vitest'
import { actionInputDigest } from '../../engine/action-input.ts'
import { integrationReceiptEligible } from '../../engine/delivery-eligibility.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import {
  classifyAttempts,
  interruptionResolutionCandidate,
  resolvableStarts,
} from '../../engine/workflow-action-interruption.ts'
import type { MandateRecord, ReceiptRecord } from '../../engine/workflow-control.ts'
import {
  interruptionResolutionDigest,
  interruptionResolutionRecordId,
  type ResolutionProposal,
  type ResolutionRecord,
} from '../../engine/workflow-interruption-proof.ts'
import { admitInterruptionResolution } from '../../engine/workflow-interruption-resolution.ts'
import { prepareReview } from '../../engine/workflow-plan-review-selection.ts'
import type { NativeBatchResult, NativeStop } from '../../omp/review-runtime/contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { publishNonImplementResult } from '../feature-action-result.ts'
import { publishRecord } from '../feature-engine.ts'
import { publishIntegrationResult } from '../feature-integration-result.ts'

vi.mock('../feature-action-publication-context.ts', () => ({ resolvePublication: vi.fn() }))
vi.mock('../feature-engine.ts', () => ({ publishRecord: vi.fn() }))

const fixtures = roxabiWorkflowFixtures()
const scope = { repository: 'acme/app', target: 'acme/app#42' }

beforeEach(() => vi.resetAllMocks())

function openedFixture(action: 'plan' | 'integrate', mandate: MandateRecord) {
  const original = action === 'plan' ? fixtures.planDraftRecords(mandate)[0] : fixtures.implementStart(mandate)
  if (original?.kind !== 'action-receipt' || original.payload.phase !== 'start') throw new Error('missing start')
  if (action === 'plan') return original
  if (original.payload.action !== 'implement') throw new Error('expected implementation start')
  const exactInputs = { mandateId: mandate.recordId, planActionId: 'act-plan-1' }
  const manifest = {
    ...original.payload.inputs.manifest,
    purpose: 'integrate' as const,
    operands: { action: 'integrate' as const, exactInputs },
  }
  const built = buildRecord({
    ...original,
    recordId: 'integration-start',
    operationId: 'integration-start-op',
    payload: {
      ...original.payload,
      action: 'integrate',
      actionId: 'integration-action',
      exactInputs,
      inputs: { ...original.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) },
    },
  })
  if (!built.ok || built.value.kind !== 'action-receipt' || built.value.payload.phase !== 'start')
    throw new Error('invalid start')
  return built.value
}

function assertNegativeCannotReplay(
  action: 'plan' | 'integrate',
  mandate: MandateRecord,
  opened: ReceiptRecord,
  pause: { recordId: string },
  history: DecodedHistory,
) {
  const start = { scope, recordId: opened.recordId, kind: 'action-receipt' as const }
  expect(resolvableStarts([history], mandate)).toEqual({ ok: true, value: [] })
  expect(interruptionResolutionCandidate({ histories: [history], mandate, start }).ok).toBe(false)
  const operationId = 'forged-resolution'
  const proposal: ResolutionProposal = {
    control: 'resolve-interruption',
    controlId: operationId,
    mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
    predecessor: { scope, recordId: pause.recordId, kind: 'operator-control' },
    action,
    actionId: opened.payload.actionId,
    start,
    result: null,
    executor: { kind: 'not-dispatched' },
    runtime: {
      productVersion: mandate.payload.config.productVersion,
      configVersion: mandate.payload.config.version,
      configDigest: mandate.payload.config.digest,
    },
  }
  const digest = interruptionResolutionDigest(proposal)
  const forged = buildRecord({
    ...scope,
    version: 1,
    recordId: interruptionResolutionRecordId(start.recordId),
    runId: operationId,
    operationId,
    kind: 'operator-control',
    payload: {
      ...proposal,
      proposalDigest: digest,
      confirmation: {
        route: 'omp-native-command',
        operationId,
        proposalDigest: digest,
        confirmedAt: '2026-01-01T00:00:00Z',
      },
    },
  })
  if (!forged.ok) throw new Error(`invalid forged resolution fixture: ${JSON.stringify(forged.diagnostics)}`)
  if (forged.value.kind !== 'operator-control' || forged.value.payload.control !== 'resolve-interruption')
    throw new Error('fixture is not an interruption resolution')
  expect(admitInterruptionResolution(forged.value as ResolutionRecord, [history]).ok).toBe(false)
  const classified = classifyAttempts({ histories: [history], scan: [history], actions: [action] })
  expect(classified).toMatchObject({ ok: true, value: { excluded: expect.any(Set), unresolved: [] } })
  if (classified.ok) expect(classified.value.excluded.size).toBe(0)
}

function negativeBatch(
  action: 'plan' | 'integrate',
  terminal: 'invalid-output' | 'invalid-terminal' | 'execution-errors',
  opened: ReceiptRecord,
): NativeBatchResult {
  return {
    batch: {
      operationId: opened.payload.actionId,
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: action === 'integrate' ? 'R-workflow-implement' : 'R-workflow-plan',
            task: '',
            solutionSpace: '',
            action: { inputs: opened.payload.inputs } as never,
          },
        ],
      },
    },
    children: [
      {
        id: 'child',
        expectedId: 'child',
        submissions: [],
        proofEvidence: null,
        raw: { exitCode: 0, structuredOutput: terminal === 'invalid-terminal' ? null : { status: 'valid', data: {} } },
        partialText: null,
        structured: terminal === 'invalid-terminal' ? null : {},
        usable: terminal !== 'invalid-terminal',
        reason: terminal === 'invalid-terminal' ? 'invalid' : null,
        sdkTerminal: 'returned',
      },
    ],
    raw: null,
    complete: terminal === 'invalid-output',
  }
}

function assertNegativeSelection(
  action: 'plan' | 'integrate',
  opened: ReceiptRecord,
  mandate: MandateRecord,
  history: DecodedHistory,
  results: ReceiptRecord[],
) {
  if (action === 'plan') {
    const spec = opened.payload.inputs.manifest.spec
    if (spec.kind !== 'accepted') throw new Error('expected accepted plan fixture')
    const selected = prepareReview(
      { issue: history, pullRequest: null, parents: [], causal: { histories: [history] } } as never,
      mandate,
      { sourceRefs: [] } as never,
      spec.effective,
      ((phase: string, evidence: unknown) => ({ phase, evidence })) as never,
    )
    expect(selected).toHaveProperty('macro')
    if ('macro' in selected) expect(['blocked', 'uncertain']).toContain(selected.macro.phase)
  } else {
    const result = results[0]
    if (result === undefined) throw new Error('missing retained result')
    expect(integrationReceiptEligible(result)).toBe(false)
  }
}

describe('returned negative terminals under a later pause', () => {
  it.each([
    ['plan', 'invalid-output'],
    ['plan', 'invalid-terminal'],
    ['plan', 'execution-errors'],
    ['integrate', 'invalid-output'],
    ['integrate', 'invalid-terminal'],
    ['integrate', 'execution-errors'],
  ] as const)('%s %s is retained but is neither resolvable nor replayable', async (action, terminal) => {
    const mandate = fixtures.featureMandate(scope)
    const opened = openedFixture(action, mandate)
    const start = { scope, recordId: opened.recordId, kind: 'action-receipt' as const }
    const initial = fixtures.historyFrom([mandate, opened])
    const retained: CanonicalRecord[] = []
    vi.mocked(resolvePublication).mockResolvedValue({
      opened,
      loaded: {},
      history: initial,
      receiptScope: scope,
      publicationParents: [],
      cwd: '/checkout',
      gh: vi.fn(),
    } as never)
    vi.mocked(publishRecord).mockImplementation(async (_loaded, _history, candidate) => {
      const parsed = buildRecord(candidate)
      // A raw invalid output must not be smuggled in as a malformed canonical record.
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error('producer attempted malformed RESULT')
      retained.push(parsed.value)
      return { ok: true } as never
    })
    const result = negativeBatch(action, terminal, opened)
    const stop: NativeStop | undefined =
      terminal === 'invalid-terminal'
        ? { kind: 'invalid-terminal', origin: 'host-stop' }
        : terminal === 'execution-errors'
          ? { kind: 'withheld', cause: 'execution-errors' }
          : undefined
    if (action === 'plan') await publishNonImplementResult({ cwd: '/checkout', start, result, stop })
    else
      await publishIntegrationResult({
        cwd: '/checkout',
        start,
        result,
        stop,
        gh: async () => '',
        git: async () => ({ code: 0, stdout: '', stderr: '' }),
      })

    const request = fixtures.pauseRequested(mandate)
    const pause = fixtures.pauseConfirmed(mandate, request)
    const history = fixtures.historyFrom([mandate, opened, ...retained, request, pause])
    const results = history.operations.flatMap((operation) =>
      operation.record?.kind === 'action-receipt' && operation.record.payload.phase === 'result'
        ? [operation.record]
        : [],
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.payload).toMatchObject({
      action,
      structured: null,
      admission: null,
      diagnostics: [expect.objectContaining({ code: expect.not.stringMatching(/^action-interrupted$/) })],
    })
    assertNegativeCannotReplay(action, mandate, opened, pause, history)
    assertNegativeSelection(action, opened, mandate, history, results)
  })
})
