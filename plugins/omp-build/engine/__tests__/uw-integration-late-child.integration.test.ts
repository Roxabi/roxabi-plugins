import { execFileSync } from 'node:child_process'
import { expect, test, vi } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import { projectWriterRetryHistory } from '../../adapters/github-workflow/writer-retry-observation.ts'
import * as featureEngine from '../../roxabi/feature-engine.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import type { History } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { recordsOf } from '../workflow-control.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

function assertRetryProjection(
  rawHome: History,
  originalHome: History,
  record: CanonicalRecord,
  body: string | undefined,
) {
  const observed = decodeHistory(rawHome)
  expect(projectWriterRetryHistory(observed, { record, observed })).toEqual(decodeHistory(originalHome))
  const prefix = rawHome.comments.find((comment) => comment.body === body)
  const other = rawHome.comments.find((comment) => comment.body !== body)
  if (!prefix?.nativeId || !other) throw new Error('Expected retained fragment and earlier native comment')
  const missingId = decodeHistory({
    ...rawHome,
    comments: rawHome.comments.map((comment) => (comment === prefix ? { ...comment, nativeId: null } : comment)),
  })
  expect(projectWriterRetryHistory(missingId, { record, observed: missingId })).toBeNull()
  const repeatedId = decodeHistory({
    ...rawHome,
    comments: rawHome.comments.map((comment) =>
      comment === other ? { ...comment, nativeId: prefix.nativeId } : comment,
    ),
  })
  expect(projectWriterRetryHistory(repeatedId, { record, observed: repeatedId })).toBeNull()
}

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

test.each(['before-writer', 'after-receipt'] as const)(
  'refuses parent integration when a child is reclassified %s',
  async (changeAt) => {
    const checkout = nativeImplementationGit()
    let reclassify: (() => void) | undefined
    let armed = false
    let posts = 0
    let writerReached = false
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
            const result = await gh(cwd, args)
            if (armed && args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
              posts++
              if (changeAt === 'after-receipt') {
                armed = false
                if (!reclassify) throw new Error('Missing child reclassification')
                reclassify()
              }
            }
            return result
          },
        },
        [{ id: 'C1', statement: 'Save keeps the selected region' }],
        'planned',
        async (world) => {
          reclassify = () => {
            world.observeGraph({
              ...world.observation.graph,
              nodes: world.observation.graph.nodes.map((node) =>
                node.uw.target === 'acme/app#201' ? { ...node, labels: ['size:F-lite'] } : node,
              ),
            })
          }
          const operations = {
            ...world.operations,
            async prepareAction(
              request: Parameters<typeof world.operations.prepareAction>[0],
              ...rest: Parameters<typeof world.operations.prepareAction> extends [unknown, ...infer R] ? R : never
            ) {
              const prepared = await world.operations.prepareAction(request, ...rest)
              if (request.purpose === 'integrate' && prepared.ok) armed = true
              return prepared
            },
          }
          const originalLoadContracts = featureEngine.loadContracts
          const spy =
            changeAt === 'before-writer'
              ? vi.spyOn(featureEngine, 'loadContracts').mockImplementation(async () => {
                  const contracts = await originalLoadContracts()
                  if ('missing' in contracts) return contracts
                  return {
                    ...contracts,
                    publishConfirmedWorkflowRecord: async (...args) => {
                      const record = args[0]
                      if (
                        record.kind === 'action-receipt' &&
                        record.payload.phase === 'start' &&
                        record.payload.action === 'integrate'
                      ) {
                        writerReached = true
                        if (!reclassify) throw new Error('Missing child reclassification')
                        reclassify()
                      }
                      return contracts.publishConfirmedWorkflowRecord(...args)
                    },
                  }
                })
              : undefined
          let opened: unknown
          try {
            await expect(
              produceParentIntegration({ ...world, operations }, parent, {
                initial,
                candidate: initial,
                command: 'bun test parent.test.ts',
                output: 'PASS parent integration',
                observeStart: (result) => {
                  opened = result
                },
              }),
            ).rejects.toThrow()
          } finally {
            spy?.mockRestore()
          }
          if (changeAt === 'before-writer') expect(writerReached).toBe(true)
          expect(opened).toMatchObject({ kind: 'blocked' })
          const current = await world.operations.readUw(world.parentScope)
          expect(current.observation.status).toBe('complete')
          if (current.observation.status !== 'complete') throw new Error('Current observation incomplete')
          expect(current.observation.graph.nodes.find((node) => node.uw.target === 'acme/app#201')?.labels).toEqual([
            'size:F-lite',
          ])
          const history = current.histories.find((item) => item.source.scope.target === world.parentScope.target)
          if (!history) throw new Error('Parent history missing')
          const starts = recordsOf(history).filter(
            (record) =>
              record.kind === 'action-receipt' &&
              record.payload.action === 'integrate' &&
              record.payload.phase === 'start',
          )
          expect(starts).toHaveLength(changeAt === 'before-writer' ? 0 : 1)
          expect(posts).toBe(changeAt === 'before-writer' ? 0 : 1)
        },
      )
    } finally {
      checkout.cleanup()
    }
  },
  60_000,
)

test('resumes the same ordinary integration START after a retained multipart prefix', async () => {
  const checkout = nativeImplementationGit()
  let interrupt = false
  const posted: string[] = []
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
          if (interrupt && args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
            if (posted.length === 1) throw new Error('Interrupted transport')
            const response = await gh(cwd, args)
            posted.push(args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '')
            return response
          }
          return gh(cwd, args)
        },
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const originalLoadContracts = featureEngine.loadContracts
        const capture: { record?: CanonicalRecord; externalHistories?: readonly featureEngine.History[] } = {}
        const spy = vi.spyOn(featureEngine, 'loadContracts').mockImplementation(async () => {
          const contracts = await originalLoadContracts()
          if ('missing' in contracts) return contracts
          return {
            ...contracts,
            publishConfirmedWorkflowRecord: async (...args) => {
              const record = args[0]
              if (
                record.kind === 'action-receipt' &&
                record.payload.phase === 'start' &&
                record.payload.action === 'integrate'
              ) {
                capture.record = record
                capture.externalHistories = args[3]
                throw new Error('Captured integration draft')
              }
              return contracts.publishConfirmedWorkflowRecord(...args)
            },
          }
        })
        try {
          await expect(
            produceParentIntegration(world, parent, {
              initial,
              candidate: initial,
              command: 'bun test parent.test.ts',
              output: 'PASS parent integration',
            }),
          ).rejects.toThrow('Captured integration draft')
        } finally {
          spy.mockRestore()
        }
        if (!capture.record) throw new Error('Integration draft not captured')
        const contracts = await originalLoadContracts()
        if ('missing' in contracts) throw new Error(`Missing engine ${contracts.missing}`)
        const before = await world.operations.readUw(world.parentScope)
        const history = before.histories.find((item) => item.source.scope.target === world.parentScope.target)
        if (!history) throw new Error('Parent history missing')
        // A long valid run ID makes this otherwise genuine START span multiple GitHub comments.
        const draft = { ...capture.record, runId: `retry-${'x'.repeat(70_000)}` }
        const built = contracts.buildRecord(draft)
        if (!built.ok) throw new Error('Integration draft is invalid')
        const readOptions = withRoxabiGitHubPolicy({ cwd: parent.cwd, gh: world.gh })
        const originalHome = await readGitHubHistory(world.parentScope, readOptions)
        expect(originalHome.complete).toBe(true)
        const comments = async (gh = world.gh) => {
          const all: { id: number; body: string }[] = []
          for (let page = 1; ; page++) {
            const batch = JSON.parse(
              await gh(parent.cwd, ['api', `repos/acme/app/issues/200/comments?per_page=100&page=${page}`]),
            ) as { id: number; body: string }[]
            all.push(...batch)
            if (batch.length < 100) return all
          }
        }
        interrupt = true
        const interrupted = await featureEngine.publishRecord(
          contracts,
          history,
          draft,
          world.gh,
          parent.cwd,
          capture.externalHistories,
        )
        expect(interrupted.ok).toBe(false)
        expect(posted).toHaveLength(1)
        expect(posted[0]).toMatch(/part=1\/[2-9]/)
        const retained = (await comments()).find((comment) => comment.body === posted[0])
        expect(retained).toBeDefined()
        interrupt = false
        const rawHome = await readGitHubHistory(world.parentScope, readOptions)
        expect(rawHome.complete).toBe(true)
        assertRetryProjection(rawHome, originalHome, built.value, posted[0])
        const retryPosts: string[] = []
        const retryGh: typeof world.gh = async (cwd, args) => {
          if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
            retryPosts.push(args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '')
          }
          return world.gh(cwd, args)
        }
        const originalGraph = world.observation.graph
        world.observeGraph({
          ...originalGraph,
          nodes: originalGraph.nodes.map((node) =>
            node.uw.target === 'acme/app#201' ? { ...node, labels: ['size:F-lite'] } : node,
          ),
        })
        const refused = await featureEngine.publishRecord(
          contracts,
          history,
          draft,
          retryGh,
          parent.cwd,
          capture.externalHistories,
        )
        expect(refused).toMatchObject({
          ok: false,
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-authority-withdrawn' })]),
        })
        expect(retryPosts).toEqual([])
        const afterRefusal = await comments(retryGh)
        expect(afterRefusal.find((comment) => comment.id === retained?.id)).toEqual(retained)
        expect(afterRefusal.filter((comment) => comment.body === posted[0])).toHaveLength(1)
        world.observeGraph(originalGraph)
        expect(
          await featureEngine.publishRecord(contracts, history, draft, retryGh, parent.cwd, capture.externalHistories),
        ).toEqual({ ok: true })
        const total = Number(posted[0]?.match(/part=1\/(\d+)/)?.[1])
        expect(retryPosts).toHaveLength(total - 1)
        for (let index = 0; index < retryPosts.length; index++) {
          expect(retryPosts[index]).toContain(`part=${index + 2}/${total} `)
        }
        expect(retryPosts).not.toContain(posted[0])
        const after = await comments(retryGh)
        expect(after.find((comment) => comment.id === retained?.id)).toEqual(retained)
        expect(after.filter((comment) => comment.body === posted[0])).toHaveLength(1)
        const cold = await world.operations.readUw(world.parentScope)
        const coldHistory = cold.histories.find((item) => item.source.scope.target === world.parentScope.target)
        if (!coldHistory) throw new Error('Parent history missing')
        const starts = recordsOf(coldHistory).filter(
          (record) =>
            record.kind === 'action-receipt' &&
            record.payload.action === 'integrate' &&
            record.payload.phase === 'start',
        )
        expect(starts).toHaveLength(1)
        expect(starts[0]).toMatchObject({
          recordId: draft.recordId,
          operationId: draft.operationId,
          runId: draft.runId,
        })
      },
    )
  } finally {
    checkout.cleanup()
  }
}, 60_000)
