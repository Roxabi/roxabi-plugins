import { expect, it, vi } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { loadContracts } from '../feature-engine.ts'
import { readFreshUwCausalContext } from '../fix-uw-histories.ts'

vi.mock('../feature-engine.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadContracts: vi.fn(),
  defaultGh: vi.fn(),
}))
vi.mock('../fix-uw-histories.ts', () => ({ readFreshUwCausalContext: vi.fn() }))

it('reports an unavailable causal read as unreadable, not as an invalid resolution index', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const mandate = fixtures.featureMandate(scope)
  const opened = fixtures.planDraftRecords(mandate)[0]
  if (opened === undefined) throw new Error('Missing plan START fixture')
  const history = fixtures.historyFrom([mandate, opened])
  const startResolution = vi.fn()
  const readComposedWorkflowHistory = vi.fn(async (..._args: unknown[]) => ({ ok: true, histories: [history] }))
  vi.mocked(loadContracts).mockResolvedValue({
    readComposedWorkflowHistory,
    startResolution,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: false,
    diagnostics: ['fix-own-uw-unsettled', 'fix-completion-observation-unavailable'],
    reasons: ['uw-read-failed: unavailable'],
  } as never)
  const result = await resolvePublication({
    cwd: '/checkout',
    gh: async () => '',
    start: { scope, recordId: opened.recordId, kind: 'action-receipt' },
    result: {
      batch: { operationId: opened.payload.actionId, tasks: { context: '', tasks: [] } },
      children: [],
      raw: null,
      complete: true,
    },
  })
  expect(result).toEqual({ reason: 'action-authority-unreadable' })
  expect(readComposedWorkflowHistory).toHaveBeenCalledTimes(2)
  for (const [, options] of readComposedWorkflowHistory.mock.calls)
    expect(options).toMatchObject({ cwd: '/checkout', stopAuthor: 'github-actions[bot]' })
  expect(startResolution).not.toHaveBeenCalled()
})
