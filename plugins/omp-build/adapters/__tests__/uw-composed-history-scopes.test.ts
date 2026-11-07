import { expect, it } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { validateComposedWorkflowHistories } from '../github-workflow/history.ts'

it('keeps equal record IDs on different repository-scoped UWs distinct', () => {
  const fixtures = roxabiWorkflowFixtures()
  const first = fixtures.featureMandate({ repository: 'acme/app', target: 'acme/app#42' }, { recordId: 'same-mandate' })
  const second = fixtures.featureMandate(
    { repository: 'other/app', target: 'other/app#42' },
    { recordId: 'same-mandate' },
  )
  const result = validateComposedWorkflowHistories([fixtures.historyFrom([first]), fixtures.historyFrom([second])])
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.records.filter((record) => record.recordId === 'same-mandate')).toHaveLength(2)
})

it('does not erase a semantic conflict in an otherwise incomplete history', () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate({ repository: 'acme/app', target: 'acme/app#42' })
  const history = fixtures.historyFrom([mandate])
  const operation = history.operations.find((entry) => entry.record?.recordId === mandate.recordId)
  if (!operation) throw new Error('missing mandate operation')
  const partial = {
    ...history,
    source: { ...history.source, complete: false },
    operations: [...history.operations, { ...operation, status: 'conflict' as const, record: null }],
  }
  const result = validateComposedWorkflowHistories([partial])
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe('ambiguous')
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(['incomplete', 'ambiguous']))
  }
})
