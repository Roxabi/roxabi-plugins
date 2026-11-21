import { expect, it, vi } from 'vitest'
import { criterionTarget } from '../../engine/__tests__/criterion-admission-fixture.ts'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { publishRecord } from '../feature-engine.ts'
import { publishIntegrationResult } from '../feature-integration-result.ts'

vi.mock('../feature-action-publication-context.ts', () => ({ resolvePublication: vi.fn() }))
vi.mock('../feature-engine.ts', () => ({ publishRecord: vi.fn() }))

it('retains the host-interrupted integration without inventing a child result or admission', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = { scope, recordId: 'start-1', kind: 'action-receipt' as const }
  const context = {
    opened: {
      recordId: start.recordId,
      payload: {
        action: 'integrate',
        actionId: 'action-1',
        mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
        inputs: { manifest: { purpose: 'integrate' } },
        exactInputs: {},
      },
    },
    loaded: {},
    history: {},
    receiptScope: scope,
    publicationParents: [],
    cwd: '/checkout',
    gh: vi.fn(),
  }
  vi.mocked(resolvePublication).mockResolvedValue(context as never)
  vi.mocked(publishRecord).mockResolvedValue({ ok: true } as never)
  const result: NativeBatchResult = {
    batch: { operationId: 'action-1', tasks: { context: '', tasks: [] } },
    children: [],
    raw: null,
    complete: false,
  }
  const published = await publishIntegrationResult({
    cwd: '/checkout',
    start,
    result,
    stop: { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' },
    gh: async () => '',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  expect(published.published).toBe(true)
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        action: 'integrate',
        phase: 'result',
        actionId: 'action-1',
        start,
        native: { completion: 'incomplete', strict: 'absent', raw: null },
        structured: null,
        admission: null,
        diagnostics: [
          expect.objectContaining({
            code: 'action-interrupted',
            detail: { marker: 'omp-build-host-interruption/2', origin: 'host-stop', proof: 'not-dispatched' },
          }),
        ],
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
  )
})

it('retains the SDK-valid blocked integration context output without discarding its declarations', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = { scope, recordId: 'start-2', kind: 'action-receipt' as const }
  const inputs = { manifest: { purpose: 'integrate' } }
  const missing = [
    { locator: { kind: 'information-request', description: 'Policy' }, reason: 'Policy unavailable', targets: [] },
  ]
  const structured = {
    outcome: 'blocked',
    commitSHAs: [],
    commands: [],
    criteria: [{ target: criterionTarget('C1'), verification: 'unverified', reason: 'Policy unavailable' }],
    reason: 'Missing policy',
    missing,
  }
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
    contextBlock: { missing, action: { actionId: 'action-2', inputs } },
  }
  const context = {
    opened: {
      recordId: start.recordId,
      payload: {
        action: 'integrate',
        actionId: 'action-2',
        mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
        inputs,
        exactInputs: {},
      },
    },
    loaded: {},
    history: {},
    receiptScope: scope,
    publicationParents: [],
    cwd: '/checkout',
    gh: vi.fn(),
  }
  vi.mocked(resolvePublication).mockResolvedValue(context as never)
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
            action: { inputs } as never,
          },
        ],
      },
    },
    children: [child as never],
    raw: null,
    complete: true,
    canPublishContext: () => true,
  }
  expect(
    await publishIntegrationResult({
      cwd: '/checkout',
      start,
      result,
      gh: async () => '',
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
    }),
  ).toMatchObject({ published: true })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        structured,
        admission: null,
        diagnostics: [],
        native: expect.objectContaining({ strict: 'valid' }),
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
    expect.any(Function),
  )
})
