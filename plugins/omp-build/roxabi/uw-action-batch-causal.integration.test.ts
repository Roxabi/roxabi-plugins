import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Gh } from '../adapters/github/types.ts'
import { fixtureCatalogueGhResponse, fixtureReviewCatalogueReads } from '../testing/action-input-fixtures.ts'
import { reviewBatchCohortFixture } from '../testing/review-batch-cohort-fixture.ts'
import { seedMandate } from '../testing/review-gate-arrangement.ts'
import {
  cleanupReviewGateFixture,
  type ReviewGateFixture,
  setupReviewGateFixture,
} from '../testing/review-gate-fixture.ts'
import { AUTOMATION } from '../testing/review-gate-gh.ts'
import { readProductionActionFactsBatch } from './uw-action-batch-facts.ts'
import type { ReviewActionBatch, UwActionRequest } from './uw-action-contract.ts'
import { prepareReviewActions } from './uw-action-review-batch.ts'
import { createProductionActionPorts } from './uw-input-readers.ts'

const repository = 'acme/app'
const uw = { repository, target: 'acme/app#42' }
const pullRequest = { repository, target: 'acme/app#7' }
afterEach(cleanupReviewGateFixture)

function gateResponse(fixture: ReviewGateFixture, args: string[]): string {
  const target =
    args[0] === 'pr'
      ? [...args, '--repo', repository]
      : args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
        ? ['repo', 'view', repository, ...args.slice(2)]
        : args
  const result = spawnSync('gh', target, { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
  return String(result.stdout).trim()
}

function nativeTransport(fixture: ReviewGateFixture, cohort: ReturnType<typeof reviewBatchCohortFixture>) {
  const visits: number[] = []
  const catalogueRequests: string[][] = []
  let unavailable = false
  const gh: Gh = async (_cwd, args) => {
    if (args.includes('graphql') || args.some((arg) => arg.includes('/git/blobs/'))) catalogueRequests.push([...args])
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const number = Number(/issues\/(\d+)\/comments/.exec(endpoint)?.[1])
    const comments = cohort.comments.get(number)
    if (comments !== undefined) {
      visits.push(number)
      if (number === 43 && unavailable) throw new Error('recursive history unavailable')
      return JSON.stringify(comments)
    }
    return gateResponse(fixture, args)
  }
  return {
    gh,
    visits,
    catalogueRequests,
    failIdentityRead: () => {
      unavailable = true
    },
  }
}

function request(fixture: ReviewGateFixture, expandedContext: UwActionRequest['expandedContext']): UwActionRequest {
  return {
    actionId: 'cohort-spec',
    purpose: 'review',
    subject: { kind: 'uw', uw, pullRequest, binding: null },
    code: { repository, base: fixture.base, head: fixture.head, referenceCommit: fixture.head },
    stageSources: [],
    expandedContext,
  }
}

function batch(first: UwActionRequest): ReviewActionBatch {
  const chunks = [{ index: 0, delta: [], diff: 'native patch', files: [], digest: 'native digest' }]
  return {
    actions: [
      { request: first, projection: { taskName: 'spec', assignedChunk: null, contextWindow: 100_000, chunks } },
      {
        request: { ...first, actionId: 'cohort-panel' },
        projection: { taskName: 'panel-0-tester', assignedChunk: 0, contextWindow: 100_000, chunks },
      },
    ],
  }
}

function expectCatalogueCut(requests: readonly string[][], fixture: ReviewGateFixture): void {
  const recursiveRef = fixtureReviewCatalogueReads()[0]?.ref
  if (recursiveRef === undefined) throw new Error('Recursive catalogue fixture is missing')
  expect(fixture.pin).not.toBe(recursiveRef.commit)
  const lookups = requests.filter((args) => args.includes('graphql'))
  expect(lookups).toHaveLength(2)
  for (const commit of [fixture.pin, recursiveRef.commit]) {
    const matching = lookups.filter(
      (args) =>
        args.includes('owner=Roxabi') &&
        args.includes('name=roxabi-plugins') &&
        args.includes(`expression=${commit}:${recursiveRef.path}`),
    )
    expect(matching).toHaveLength(1)
  }
  const blobs = requests.flatMap((args) => args.filter((arg) => arg.includes('/git/blobs/')))
  expect(blobs).toHaveLength(2)
  expect(blobs[0]).toBe(blobs[1])
}

it('discovers an authenticated recursive scope once per production fact cut and rebuilds its catalogue on later cuts', async () => {
  const fixture = setupReviewGateFixture()
  await seedMandate(fixture)
  const cohort = reviewBatchCohortFixture()
  const transport = nativeTransport(fixture, cohort)
  const first = request(fixture, cohort.recursiveExpandedContext)
  const capture = () =>
    readProductionActionFactsBatch([first, { ...first, actionId: 'cohort-panel' }], {
      cwd: fixture.candidate,
      gh: transport.gh,
      readAuthor: AUTOMATION,
    })
  const observed = await capture()
  expect(observed.ok, JSON.stringify(observed)).toBe(true)
  if (!observed.ok) throw new Error('native recursive cohort refused')
  expect(observed.value.map((item) => item.actionId)).toEqual(['cohort-spec', 'cohort-panel'])
  expect(observed.value[0]?.facts).toEqual(observed.value[1]?.facts)
  expect(observed.value[0]?.facts.spec.kind).toBe('accepted')
  expect(transport.visits.filter((number) => number === 44)).toHaveLength(1)
  expect(transport.visits.filter((number) => number === 43)).toHaveLength(1)
  expectCatalogueCut(transport.catalogueRequests, fixture)
  const firstCutRequests = transport.catalogueRequests.length
  const later = await capture()
  expect(later).toEqual(observed)
  expect(transport.visits.filter((number) => number === 44)).toHaveLength(2)
  expect(transport.visits.filter((number) => number === 43)).toHaveLength(2)
  expectCatalogueCut(transport.catalogueRequests.slice(firstCutRequests), fixture)
})

it.each(['missing', 'foreign', 'unavailable'] as const)(
  'replays selected external identity after confirmation and refuses %s evidence with unchanged primary histories',
  async (mode) => {
    const fixture = setupReviewGateFixture()
    await seedMandate(fixture)
    const cohort = reviewBatchCohortFixture()
    const transport = nativeTransport(fixture, cohort)
    const ports = createProductionActionPorts({
      cwd: fixture.candidate,
      gh: transport.gh,
      readAuthor: AUTOMATION,
      artifactsDir: path.join(fixture.root, 'artifacts'),
      pluginPin: {
        repository: 'Roxabi/roxabi-plugins',
        commit: fixture.pin,
        installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
      },
    })
    const nativeBatch = ports.readCurrentActionFactsBatch
    if (nativeBatch === undefined) throw new Error('production fact batch is unavailable')
    let cuts = 0
    const primary = [
      await transport.gh(fixture.candidate, ['api', 'repos/acme/app/issues/42/comments']),
      await transport.gh(fixture.candidate, ['api', 'repos/acme/app/issues/7/comments']),
    ]
    const result = await prepareReviewActions(batch(request(fixture, cohort.expandedContext)), {
      ...ports,
      readCurrentActionFactsBatch: async (...args) => {
        cuts++
        if (cuts === 2) {
          if (mode === 'missing') cohort.removeIdentity()
          else if (mode === 'unavailable') transport.failIdentityRead()
          else {
            const comments = cohort.comments.get(43)
            if (comments === undefined) throw new Error('recursive identity missing from fixture')
            cohort.comments.set(
              43,
              comments.map((comment) => ({ ...comment, user: { login: 'foreign' } })),
            )
          }
        }
        return nativeBatch(...args)
      },
    })
    expect(cuts).toBe(2)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('changed selected identity unexpectedly confirmed')
    expect(result.diagnostics.length).toBeGreaterThan(0)
    const after = [
      await transport.gh(fixture.candidate, ['api', 'repos/acme/app/issues/42/comments']),
      await transport.gh(fixture.candidate, ['api', 'repos/acme/app/issues/7/comments']),
    ]
    expect(after).toEqual(primary)
    expect(transport.visits.filter((number) => number === 43).length).toBeGreaterThan(1)
  },
)
