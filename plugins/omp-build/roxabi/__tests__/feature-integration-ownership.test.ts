import { expect, it, vi } from 'vitest'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { publishRecord } from '../feature-engine.ts'
import { admitIntegration } from '../feature-integration-admission.ts'
import { integrationAuthority } from '../feature-integration-authority.ts'
import { publishIntegrationResult } from '../feature-integration-result.ts'

vi.mock('../feature-action-publication-context.ts', () => ({ resolvePublication: vi.fn() }))
vi.mock('../feature-engine.ts', () => ({ publishRecord: vi.fn() }))
vi.mock('../feature-integration-admission.ts', () => ({ admitIntegration: vi.fn() }))
vi.mock('../../dist/contracts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dist/contracts.js')>()
  return {
    ...actual,
    integrationOutputSchema: {
      safeParse: (value: unknown) => ({ success: true as const, data: value }),
    },
  }
})

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const start = { scope, recordId: 'start-1', kind: 'action-receipt' as const }
const tip = 'a'.repeat(40)
const inputs = { manifest: { purpose: 'integrate' as const } }
const structured = {
  outcome: 'integrated' as const,
  code: { repository: 'acme/app', base: tip, head: tip, referenceCommit: tip },
  children: [],
  coverage: { parent: { uw: scope, version: 'b'.repeat(64) }, assignments: [] },
  commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0 }],
  criteria: [],
  reason: 'integrated and checked',
}

function openedContext() {
  return {
    opened: {
      recordId: start.recordId,
      payload: {
        action: 'integrate' as const,
        actionId: 'action-1',
        mandate: { scope, recordId: 'mandate-1', kind: 'mandate' as const },
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
}

function positiveBatch(canPublishContext: () => boolean): NativeBatchResult {
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
    bashCalls: [{ toolCallId: 'tool-1', command: 'bun test', cwd: '/checkout' }],
    commandRuns: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
  }
  return {
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
            action: { inputs } as never,
          },
        ],
      },
    },
    children: [child as never],
    raw: null,
    complete: true,
    canPublishContext,
  }
}

function admittedSuccess() {
  return {
    admitted: true,
    commits: [tip],
    paths: ['fixture.txt'],
    commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
    remoteBranch: null,
    remoteTip: tip,
    published: true,
    reason: structured.reason,
  }
}

it('refuses authority when original execution current is false while context publish stays allowed', async () => {
  const authorized = integrationAuthority(
    {
      cwd: '/checkout',
      result: positiveBatch(() => true),
      start,
      gh: async () => '',
      current: () => false,
    },
    openedContext() as never,
    { scope, recordId: 'mandate-1' },
    scope,
    { completion: { completions: new Map() } } as never,
    { children: [] } as never,
  )
  expect(await authorized()).toEqual({ ok: false, reason: 'integration-local-inhibition' })
})

it('retains completed integrate evidence without admitting when current dies after durable admission', async () => {
  const context = openedContext()
  let live = true
  const canPublishContext = () => true
  vi.mocked(resolvePublication)
    .mockReset()
    .mockResolvedValueOnce(context as never)
    .mockImplementationOnce(async () => {
      await Promise.resolve()
      live = false
      return context as never
    })
  vi.mocked(admitIntegration)
    .mockReset()
    .mockResolvedValue(admittedSuccess() as never)
  vi.mocked(publishRecord)
    .mockReset()
    .mockResolvedValue({ ok: true } as never)
  const published = await publishIntegrationResult({
    cwd: '/checkout',
    start,
    result: positiveBatch(canPublishContext),
    gh: async () => '',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: () => live,
  })
  expect(live).toBe(false)
  expect(canPublishContext()).toBe(true)
  expect(published).toMatchObject({ published: true })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        structured,
        admission: expect.objectContaining({
          admitted: false,
          published: true,
          remoteTip: tip,
          commits: [tip],
          commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
          reason: 'integration-local-inhibition',
        }),
        diagnostics: [{ code: 'integration-local-inhibition', message: 'integration-local-inhibition' }],
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
    undefined,
  )
})

it('retains completed-after-stop integrate evidence when current is already false', async () => {
  const context = openedContext()
  vi.mocked(resolvePublication)
    .mockReset()
    .mockResolvedValue(context as never)
  vi.mocked(admitIntegration)
    .mockReset()
    .mockResolvedValue(admittedSuccess() as never)
  vi.mocked(publishRecord)
    .mockReset()
    .mockResolvedValue({ ok: true } as never)
  const published = await publishIntegrationResult({
    cwd: '/checkout',
    start,
    result: positiveBatch(() => true),
    stop: { kind: 'completed-after-stop', origin: 'host-stop' },
    gh: async () => '',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: () => false,
  })
  expect(published).toMatchObject({ published: true })
  expect(publishRecord).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        structured,
        admission: expect.objectContaining({
          admitted: false,
          published: true,
          remoteTip: tip,
          reason: 'integration-local-inhibition',
          commits: [tip],
        }),
      }),
    }),
    expect.anything(),
    '/checkout',
    [],
    undefined,
  )
})
