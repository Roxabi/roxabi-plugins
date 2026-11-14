import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { publishNonImplementResult } from '../feature-action-result.ts'
import { publishRecord } from '../feature-engine.ts'

vi.mock('../feature-action-publication-context.ts', () => ({ resolvePublication: vi.fn() }))
vi.mock('../feature-engine.ts', () => ({ publishRecord: vi.fn() }))

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const start = { scope, recordId: 'start-1', kind: 'action-receipt' as const }

function result(complete: boolean): NativeBatchResult {
  return {
    batch: {
      operationId: 'action-1',
      tasks: {
        context: '',
        tasks: [{ name: 'child', agent: 'agent', task: '', solutionSpace: '', action: {} as never }],
      },
    },
    children: [
      {
        id: 'child',
        expectedId: 'child',
        submissions: [],
        proofEvidence: null,
        raw: { exitCode: 0, structuredOutput: { status: 'valid', data: {} } },
        partialText: null,
        structured: {},
        usable: true,
        reason: null,
      },
    ],
    raw: null,
    complete,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('completed negatives and unclassified incomplete results', () => {
  it.each(['plan', 'assess-spec', 'attribute-ci'] as const)(
    'does not treat an incomplete %s batch without a host stop as an interruption receipt',
    async (action) => {
      vi.mocked(resolvePublication).mockResolvedValue({ opened: { payload: { action } } } as never)
      const published = await publishNonImplementResult({ cwd: '/checkout', start, result: result(false) })
      expect(published).toEqual({ published: false, reason: 'action-uncertain' })
      expect(publishRecord).not.toHaveBeenCalled()
    },
  )
})

it('refuses a context negative whose sealed action does not match, rather than treating it as interruption', async () => {
  vi.mocked(resolvePublication).mockResolvedValue({
    opened: { payload: { action: 'plan', actionId: 'action-1', inputs: {} } },
  } as never)
  const batch = result(false)
  batch.canPublishContext = () => true
  const child = batch.children[0]
  if (child === undefined) throw new Error('Missing native child fixture')
  child.contextBlock = { missing: [], action: { actionId: 'different-action', inputs: {} as never } }

  const published = await publishNonImplementResult({ cwd: '/checkout', start, result: batch })
  expect(published).toEqual({ published: false, reason: 'action-context-binding-mismatch' })
  expect(publishRecord).not.toHaveBeenCalled()
})

describe('host-interrupted read-only producers', () => {
  it.each(['plan', 'plan-review', 'assess-spec', 'attribute-ci'] as const)(
    'retains an incomplete %s receipt from typed host interruption',
    async (action) => {
      const slots = action === 'plan-review' ? [{ slotId: 'one' }, { slotId: 'two' }] : undefined
      const context = {
        opened: {
          recordId: start.recordId,
          payload: {
            action,
            actionId: 'action-1',
            mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
            inputs: {},
            exactInputs: {},
            ...(slots === undefined ? {} : { slots }),
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
      const batch = result(false)
      batch.children = []
      const published = await publishNonImplementResult({
        cwd: '/checkout',
        start,
        result: batch,
        stop: { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' },
      })
      expect(published.published).toBe(true)
      expect(publishRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          payload: expect.objectContaining({
            action,
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
            ...(slots === undefined ? {} : { slots, contributions: [] }),
          }),
        }),
        expect.anything(),
        '/checkout',
        [],
      )
    },
  )

  it('does not publish a late result if its START resolves during publication', async () => {
    vi.mocked(resolvePublication)
      .mockResolvedValueOnce({ opened: { payload: { action: 'plan' } } } as never)
      .mockResolvedValueOnce({ reason: 'action-start-resolved' } as never)
    const published = await publishNonImplementResult({ cwd: '/checkout', start, result: result(true) })
    expect(published).toEqual({ published: false, reason: 'action-start-resolved' })
    expect(publishRecord).not.toHaveBeenCalled()
  })
})
