import { expect, it } from 'vitest'
import { featureMandate, history, must, SCOPE } from '../../engine/__tests__/workflow-test-support.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { createUwDeliveryFactReader } from '../github-workflow/uw-delivery-facts.ts'

it('ordinary reads explicitly refuse uncovered legacy history without a repository scan', async () => {
  const calls: string[][] = []
  const reader = createUwDeliveryFactReader({
    cwd: '/fixture',
    gh: async (_cwd, args) => {
      calls.push(args)
      throw new Error('unexpected native read')
    },
  })
  const result = await reader.read(SCOPE, [history([featureMandate()])])
  expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'legacy-coverage-incomplete' }] })
  expect(calls).toEqual([])
})

it('composes a bounded new-policy read without a repository-wide scan', async () => {
  const legacy = featureMandate()
  const current = must(
    parseRecord({
      ...legacy,
      payload: { ...legacy.payload, config: { ...legacy.payload.config, productVersion: '0.18.8' } },
    }),
  )
  const calls: string[][] = []
  const reader = createUwDeliveryFactReader({
    cwd: '/fixture',
    gh: async (_cwd, args) => {
      calls.push(args)
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    },
  })
  expect(await reader.read(SCOPE, [history([current])])).toMatchObject({
    ok: true,
    value: { facts: { pullRequests: [] } },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('branch=feature/bounded')
})
