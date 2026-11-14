import { expect, it, vi } from 'vitest'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { resolvableStarts } from '../../engine/workflow-action-interruption.ts'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { publishRecord } from '../feature-engine.ts'
import { publishFeatureNativeResult } from '../feature-result.ts'
import { bindImplementationResult } from '../feature-result-binding.ts'
import { readFreshUwCausalContext } from '../fix-uw-histories.ts'

vi.mock('../feature-engine.ts', () => ({ publishRecord: vi.fn(), defaultGh: vi.fn() }))
vi.mock('../feature-result-binding.ts', () => ({ bindImplementationResult: vi.fn() }))
vi.mock('../fix-uw-histories.ts', () => ({ readFreshUwCausalContext: vi.fn() }))

it('retains an honestly empty implementation interruption without inventing a child or work', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = { scope, recordId: 'start-1', kind: 'action-receipt' as const }
  const history = { operations: [], source: { scope } }
  vi.mocked(bindImplementationResult).mockResolvedValue({
    loaded: {
      readComposedWorkflowHistory: async () => ({ ok: true, histories: [history] }),
      startResolution: () => ({ ok: true, value: null }),
    },
    gh: vi.fn(),
    history,
    receiptScope: scope,
    start: { recordId: start.recordId, payload: { actionId: 'action-1', inputs: { manifest: { deliveryData: [] } } } },
    mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
    branch: 'feat/42-save',
    exactInputs: { mandateId: 'mandate-1', planActionId: 'plan-1' },
    publicationParents: [],
    child: undefined,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: { histories: [history] } } as never)
  vi.mocked(publishRecord).mockResolvedValue({ ok: true } as never)
  const result: NativeBatchResult = {
    children: [],
    raw: null,
    complete: false,
    batch: {
      operationId: 'action-1',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: { manifest: { purpose: 'implement' } } } as never,
          },
        ],
      },
    },
  }
  const published = await publishFeatureNativeResult({
    cwd: '/checkout',
    start,
    result,
    stop: { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' },
    gh: async () => '',
  })
  expect(published).toMatchObject({ published: false, retained: true, reason: 'action-interrupted' })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        action: 'implement',
        phase: 'result',
        actionId: 'action-1',
        start,
        native: { completion: 'incomplete', strict: 'absent', raw: null },
        structured: null,
        diagnostics: [
          expect.objectContaining({
            code: 'action-interrupted',
            detail: { marker: 'omp-build-host-interruption/2', proof: 'not-dispatched', origin: 'host-stop' },
          }),
        ],
        admission: {
          admitted: false,
          published: false,
          commits: [],
          paths: [],
          commands: [],
          remoteBranch: null,
          remoteTip: null,
          reason: 'action-interrupted',
        },
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
  )
})

it('retains an SDK terminal without structured output as completed invalid, not interrupted', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = { scope, recordId: 'start-2', kind: 'action-receipt' as const }
  const history = { operations: [], source: { scope } }
  const child = {
    id: 'child',
    expectedId: 'child',
    submissions: [],
    proofEvidence: null,
    raw: { exitCode: 0, structuredOutput: null },
    partialText: null,
    structured: null,
    usable: false,
    reason: 'invalid',
    sdkTerminal: 'returned' as const,
  }
  vi.mocked(bindImplementationResult).mockResolvedValue({
    loaded: {
      readComposedWorkflowHistory: async () => ({ ok: true, histories: [history] }),
      startResolution: () => ({ ok: true, value: null }),
    },
    gh: vi.fn(),
    history,
    receiptScope: scope,
    start: { recordId: start.recordId, payload: { actionId: 'action-2', inputs: { manifest: { deliveryData: [] } } } },
    mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
    branch: 'feat/42-save',
    exactInputs: { mandateId: 'mandate-1', planActionId: 'plan-1' },
    publicationParents: [],
    child,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: { histories: [history] } } as never)
  vi.mocked(publishRecord)
    .mockReset()
    .mockResolvedValue({ ok: true } as never)
  const result: NativeBatchResult = {
    batch: {
      operationId: 'action-2',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: { manifest: { purpose: 'implement' } } } as never,
          },
        ],
      },
    },
    children: [child],
    raw: null,
    complete: false,
  }
  const published = await publishFeatureNativeResult({
    cwd: '/checkout',
    start,
    result,
    stop: { kind: 'invalid-terminal', origin: 'host-stop' },
    gh: async () => '',
  })
  expect(published).toMatchObject({ published: false, retained: true, reason: 'implementation-output-invalid' })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        native: expect.objectContaining({ completion: 'completed', strict: 'invalid', raw: child.raw }),
        structured: null,
        diagnostics: [expect.objectContaining({ code: 'implementation-output-invalid' })],
        admission: expect.objectContaining({ admitted: false, reason: 'implementation-output-invalid' }),
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
  )
})

it('retains an invalid SDK terminal without claiming it returned or completed', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope)
  const opened = fixtures.implementStart(mandate, 'action-3')
  if (opened.payload.action !== 'implement' || opened.payload.phase !== 'start')
    throw new Error('invalid START fixture')
  const start = { scope, recordId: opened.recordId, kind: 'action-receipt' as const }
  const history = fixtures.historyFrom([mandate, opened])
  const retained: CanonicalRecord[] = []
  vi.mocked(bindImplementationResult).mockResolvedValue({
    loaded: {
      readComposedWorkflowHistory: async () => ({ ok: true, histories: [history] }),
      startResolution: () => ({ ok: true, value: null }),
    },
    gh: vi.fn(),
    history,
    receiptScope: scope,
    start: opened,
    mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
    branch: 'feat/42-save',
    exactInputs: opened.payload.exactInputs,
    publicationParents: [],
    child: undefined,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: { histories: [history] } } as never)
  vi.mocked(publishRecord)
    .mockReset()
    .mockImplementation(async (_loaded, _history, candidate) => {
      const record = buildRecord(candidate)
      if (!record.ok) throw new Error(JSON.stringify(record.diagnostics))
      retained.push(record.value)
      return { ok: true } as never
    })
  const result: NativeBatchResult = {
    batch: {
      operationId: 'action-3',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: { manifest: { purpose: 'implement' } } } as never,
          },
        ],
      },
    },
    children: [],
    raw: null,
    complete: false,
  }
  const published = await publishFeatureNativeResult({
    cwd: '/checkout',
    start,
    result,
    stop: { kind: 'invalid-terminal', origin: null },
    gh: async () => '',
  })
  expect(published).toMatchObject({ published: false, retained: true, reason: 'implementation-output-invalid' })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        native: { completion: 'incomplete', strict: 'absent', raw: null },
        structured: null,
        diagnostics: [expect.objectContaining({ code: 'implementation-output-invalid' })],
        admission: expect.objectContaining({ admitted: false, reason: 'implementation-output-invalid' }),
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
  )
  const pauseRequest = fixtures.pauseRequested(mandate)
  const paused = fixtures.historyFrom([
    mandate,
    opened,
    ...retained,
    pauseRequest,
    fixtures.pauseConfirmed(mandate, pauseRequest),
  ])
  expect(retained).toHaveLength(1)
  expect(resolvableStarts([paused], mandate)).toEqual({ ok: true, value: [] })
})

it('retains the SDK-valid common missing-context output for implementation unchanged', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope)
  const opened = fixtures.implementStart(mandate, 'action-4')
  if (opened.payload.action !== 'implement' || opened.payload.phase !== 'start')
    throw new Error('invalid START fixture')
  const start = { scope, recordId: opened.recordId, kind: 'action-receipt' as const }
  const history = fixtures.historyFrom([mandate, opened])
  const missing = [
    { locator: { kind: 'information-request', description: 'Policy' }, reason: 'Policy unavailable', targets: [] },
  ]
  const structured = { outcome: 'missing-context', missing }
  const child = {
    id: 'child',
    expectedId: 'child',
    submissions: [],
    proofEvidence: null,
    raw: { exitCode: 0, structuredOutput: { status: 'valid', data: structured } },
    partialText: null,
    structured,
    usable: true,
    reason: null,
    contextBlock: { missing, action: { actionId: 'action-4', inputs: opened.payload.inputs } },
  }
  vi.mocked(bindImplementationResult).mockResolvedValue({
    loaded: {
      readComposedWorkflowHistory: async () => ({ ok: true, histories: [history] }),
      startResolution: () => ({ ok: true, value: null }),
    },
    gh: vi.fn(),
    history,
    receiptScope: scope,
    start: opened,
    mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
    branch: 'feat/42-save',
    exactInputs: opened.payload.exactInputs,
    publicationParents: [],
    child,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: { histories: [history] } } as never)
  vi.mocked(publishRecord)
    .mockReset()
    .mockImplementation(async (_loaded, _history, candidate) => {
      const record = buildRecord(candidate)
      if (!record.ok) return { ok: false, reason: 'record-invalid' } as never
      return { ok: true } as never
    })
  const result: NativeBatchResult = {
    batch: {
      operationId: 'action-4',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: opened.payload.inputs } as never,
          },
        ],
      },
    },
    children: [child as never],
    raw: null,
    complete: true,
    canPublishContext: () => true,
  }
  expect(await publishFeatureNativeResult({ cwd: '/checkout', start, result, gh: async () => '' })).toMatchObject({
    published: false,
    retained: true,
    reason: 'action-context-missing',
  })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({ structured, admission: null, diagnostics: [] }),
    }),
    expect.anything(),
    '/checkout',
    [],
    expect.any(Function),
  )
})
