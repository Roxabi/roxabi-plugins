import { expect, it } from 'vitest'
import { featureMandate, history, must, SCOPE } from '../../engine/__tests__/workflow-test-support.ts'
import { buildRecord, parseRecord } from '../../engine/record-construction.ts'
import type { Scope } from '../../engine/record-values.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
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

it('shares each branch enumeration across covered homes in one observation', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const second: Scope = { repository: SCOPE.repository, target: 'acme/app#43' }
  const coveredHome = (scope: Scope, destination: string) => {
    const initial = fixtures.featureMandate(scope, { recordId: 'initial', operationId: 'initial-op', branch: 'shared' })
    if (initial.kind !== 'mandate') throw new Error('Expected mandate fixture')
    const first = must(
      parseRecord({
        ...initial,
        payload: { ...initial.payload, config: { ...initial.payload.config, productVersion: '0.18.8' } },
      }),
    )
    if (first.kind !== 'mandate') throw new Error('Expected first mandate')
    const predecessor = { scope, kind: 'mandate' as const, recordId: first.recordId }
    const successor = must(
      parseRecord({
        ...first,
        recordId: 'successor',
        operationId: 'successor-op',
        inputs: [...first.inputs, first.recordId],
        payload: { ...first.payload, branch: destination, antecedent: predecessor },
      }),
    )
    const control = must(
      buildRecord({
        ...scope,
        version: 1,
        recordId: 'control',
        runId: 'control',
        operationId: 'control-op',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'control',
          mandate: predecessor,
          predecessor,
          successor: { scope, kind: 'mandate', recordId: successor.recordId },
        },
      }),
    )
    return history([first, successor, control], scope)
  }
  const homes = [coveredHome(SCOPE, 'a'), coveredHome(second, 'b')]
  const calls: string[][] = []
  const reader = createUwDeliveryFactReader({
    cwd: '/fixture',
    gh: async (_cwd, args) => {
      calls.push(args)
      return JSON.stringify({
        data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      })
    },
  })
  expect(await reader.read(SCOPE, homes)).toMatchObject({ ok: true, value: { facts: { pullRequests: [] } } })
  expect(await reader.read(second, homes)).toMatchObject({ ok: true, value: { facts: { pullRequests: [] } } })
  expect(calls).toHaveLength(3)
  expect(calls.map((args) => args.find((arg) => arg.startsWith('branch='))).sort()).toEqual([
    'branch=a',
    'branch=b',
    'branch=shared',
  ])
})
