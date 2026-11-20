import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { recordsOf } from '../workflow-control.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

test('sealed integration refuses a late unreadable child without publishing', async () => {
  const checkout = nativeImplementationGit()
  let armed = false
  let denyNext = true
  let denied = 0
  let posts = 0
  let fetches = 0
  try {
    const [first, second, third] = checkout.merges
    if (!first || !second || !third) throw new Error('Expected three child merges')
    await checkout.publishBase(third)
    const parent = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    const initial = parent.observe()
    await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parent.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, first, second].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(third, checkout.parentHead),
        wrapGh: (gh) => async (cwd, args) => {
          if (armed && args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') posts++
          if (armed && args[0] === 'api' && args[1]?.startsWith('repos/acme/app/issues/201/comments?')) {
            denied++
            throw new Error('HTTP 403: child history permission revoked')
          }
          return gh(cwd, args)
        },
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const snapshots = async () => {
          const all: string[] = []
          for (const scope of [world.parentScope, ...world.reviews.flatMap((child) => [child.uw, child.pullRequest])]) {
            const number = scope.target.split('#')[1]
            for (let page = 1; ; page++) {
              const body = await world.gh(parent.cwd, [
                'api',
                `repos/${scope.repository}/issues/${number}/comments?per_page=100&page=${page}`,
              ])
              all.push(body)
              if ((JSON.parse(body) as unknown[]).length < 100) break
            }
          }
          return all
        }
        const refs = () => execFileSync('git', ['-C', parent.cwd, 'show-ref', '--head'], { encoding: 'utf8' })
        const beforeComments = await snapshots()
        const beforeRefs = refs()
        let expectedParent: Parameters<typeof world.operations.prepareAction>[0]['expectedIntegrationParent']
        const operations = {
          ...world.operations,
          async prepareAction(
            request: Parameters<typeof world.operations.prepareAction>[0],
            ...rest: Parameters<typeof world.operations.prepareAction> extends [unknown, ...infer R] ? R : never
          ) {
            if (request.purpose !== 'integrate') return world.operations.prepareAction(request, ...rest)
            expectedParent = request.expectedIntegrationParent
            expect(expectedParent).toBeDefined()
            expect(request.stageSources).toEqual([])
            if (!denyNext && expectedParent) {
              const stale = await world.operations.prepareAction(
                { ...request, expectedIntegrationParent: { ...expectedParent, children: [] } },
                ...rest,
              )
              expect(stale.ok).toBe(false)
            }
            const prepared = await world.operations.prepareAction(request, ...rest)
            if (!prepared.ok) return prepared
            expect(prepared.value.inputs.stageSources.length).toBeGreaterThan(0)
            expect((await world.operations.verifyAction(prepared.value.snapshot)).ok).toBe(true)
            if (denyNext) {
              armed = true
              return prepared
            }
            const supplied = await world.operations.prepareAction(
              { ...request, stageSources: prepared.value.inputs.stageSources },
              ...rest,
            )
            expect(supplied.ok).toBe(false)
            const expanded = await world.operations.prepareAction(
              { ...request, expandedContext: prepared.value.inputs.stageSources },
              ...rest,
            )
            expect(expanded.ok).toBe(false)
            return prepared
          },
          async replayActionInputs(input: Parameters<typeof world.operations.replayActionInputs>[0]) {
            if (!denyNext && input.request.purpose === 'integrate') {
              expect(input.request.expectedIntegrationParent).toBeUndefined()
              expect(input.request.stageSources).toEqual(input.reviewed.stageSources)
              expect(
                (
                  await world.operations.replayActionInputs({
                    ...input,
                    request: { ...input.request, stageSources: [] },
                  })
                ).ok,
              ).toBe(false)
              expect(
                (
                  await world.operations.replayActionInputs({
                    ...input,
                    request: { ...input.request, expectedIntegrationParent: expectedParent },
                  })
                ).ok,
              ).toBe(false)
              expect(
                (
                  await world.operations.replayActionInputs({
                    ...input,
                    reviewed: { ...input.reviewed, stageSources: [] },
                  })
                ).ok,
              ).toBe(false)
            }
            return world.operations.replayActionInputs(input)
          },
        }
        const observedGit = (async (cwd: string, args: string[], mode?: 'identity') => {
          if (armed && args[0] === 'fetch') fetches++
          if (mode === 'identity') {
            const identity = world.git as (cwd: string, args: string[], mode: 'identity') => Promise<unknown>
            return identity(cwd, args, mode)
          }
          return world.git(cwd, args)
        }) as unknown as typeof world.git
        let opened: unknown
        await expect(
          produceParentIntegration({ ...world, operations, git: observedGit }, parent, {
            initial,
            candidate: initial,
            command: 'bun test parent.test.ts',
            output: 'PASS parent integration',
            observeStart: (result) => {
              opened = result
            },
          }),
        ).rejects.toThrow()
        expect(opened).toMatchObject({ kind: 'blocked' })
        expect(denied).toBeGreaterThan(0)
        expect(fetches).toBe(0)
        expect(posts).toBe(0)
        armed = false
        denyNext = false
        expect(await snapshots()).toEqual(beforeComments)
        expect(refs()).toBe(beforeRefs)
        const cold = await world.operations.readUw(world.parentScope)
        const history = cold.histories.find((item) => item.source.scope.target === world.parentScope.target)
        if (!history) throw new Error('Parent history missing')
        expect(
          recordsOf(history).filter(
            (record) =>
              record.kind === 'action-receipt' &&
              record.payload.action === 'integrate' &&
              record.payload.phase === 'start',
          ),
        ).toEqual([])
        const positive = await produceParentIntegration({ ...world, operations, git: observedGit }, parent, {
          initial,
          candidate: initial,
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
        })
        expect(positive.opened).toMatchObject({ kind: 'action', node: 'integrate' })
      },
    )
  } finally {
    checkout.cleanup()
  }
}, 60_000)
