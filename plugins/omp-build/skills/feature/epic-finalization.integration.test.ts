import { describe, expect, it } from 'vitest'
import { projectNativeUwChildren } from '../../engine/uw-child-admission.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { nextStep } from './epic-next-step.ts'
import { summarize } from './epic-progress.ts'
import { EARLIER, facts, hook, pr, RUN } from './epic-transition.fixture.ts'
import type { EpicReview, Facts, HookRecord } from './epic-types.ts'
import { landedEpic } from './testing/epic-driver/epic-driver-landed-fixture.ts'
import { cleanupSandbox } from './testing/epic-driver/epic-driver-sandbox.ts'
import { selectorProof } from './testing/epic-driver/epic-selector-proof.ts'

// One isolated, real three-child producer supplies both independently observed cuts.
const evidence = selectorProof()

function firstChild(proof: Awaited<typeof evidence>) {
  const child = proof.children[0]
  if (!child) throw new Error('Missing first observed child')
  return child
}

async function scenario(
  options: {
    review?: 'none' | 'clean' | 'blocking'
    historical?: boolean
    earlier?: boolean
    hooks?: HookRecord[]
    baseCi?: Facts['baseCi']
    cleanTree?: boolean
    integration?: 'missing'
  } = {},
) {
  const proof = await evidence
  const children = proof.children.map((item, index) => {
    const number = Number(item.uw.target.slice(item.uw.target.lastIndexOf('#') + 1))
    const completion = proof.childCompletions[index]
    if (completion?.state !== 'complete') throw new Error('Missing same-cut child completion')
    return {
      number,
      title: item.uw.target,
      state: 'OPEN' as const,
      labels: ['size:S'],
      body: item.ownUw.accepted.snapshot.raw.body,
      ownUw: item.ownUw,
      blockedBy: [],
      stops: [],
      branches: [],
      completion: completion.state,
      // These are the actual child PR facts; these branch names do not claim a ticket.
      prs: [
        pr(number, {
          number: 301 + index,
          state: 'MERGED',
          head: 'feature/child-' + index,
          headSha: item.head,
          baseSha: item.base,
          mergeSha: item.merge,
          mergedAt: null,
        }),
      ],
    }
  })
  const blocking = options.review === 'blocking'
  const review: EpicReview = {
    run: options.earlier ? EARLIER : RUN,
    verdict: blocking ? 'blocking' : 'clean',
    range: options.historical
      ? firstChild(proof).base + '..' + firstChild(proof).merge
      : proof.code.base + '..' + proof.code.head,
    inputs: proof.inputs,
    decision: blocking ? proof.blockingDecision : proof.decision,
  }
  const input = facts(children, {
    epic: 200,
    baseSha: proof.code.head,
    parentIntegration: options.integration === 'missing' ? { ok: true, value: null } : proof.integration,
    parentCompletion: blocking ? proof.blockingCompletion : proof.completion,
    reviews: !options.review || options.review === 'none' ? [] : [review],
    hooks: options.hooks ?? [],
    ...(options.baseCi ? { baseCi: options.baseCi } : {}),
    ...(options.cleanTree === false ? { tree: { clean: false, branch: null } } : {}),
  })
  return { proof, input, range: proof.code.base + '..' + proof.code.head }
}

const red: Facts['baseCi'] = { state: 'red', failed: ['test'], pending: [] }
const pending: Facts['baseCi'] = { state: 'pending', failed: [], pending: ['build'] }
const noChecks: Facts['baseCi'] = { state: 'none', failed: [], pending: [] }

describe('nextStep finalization', () => {
  it('requires own integration even when all observed children are complete', async () => {
    const { input } = await scenario({ integration: 'missing' })
    expect(nextStep(input)).toMatchObject({ action: 'integrate', report: { closed: [201, 202, 203] } })
  })

  it('reports the actual landed ticket-claiming child as merged in its own o/r world', async () => {
    try {
      const world = await landedEpic()
      const proof = { read: await world.native.operations.readUw({ repository: 'o/r', target: 'o/r#1' }) }
      if (proof.read.observation.status !== 'complete' || !proof.read.observedReader)
        throw new Error('Incomplete actual Epic observation')
      const scope = { repository: 'o/r', target: 'o/r#2' }
      const delivery = proof.read.observation.delivery.find(
        (item) => item.uw.target === scope.target && item.uw.repository === scope.repository,
      )
      const nativePr = delivery?.pullRequests[0]
      const completion = proof.read.completion.completions.get(scopeKey(scope))
      const own = await proof.read.observedReader.readUw(scope)
      if (
        nativePr?.state !== 'MERGED' ||
        !nativePr.mergeCommit ||
        completion?.state !== 'complete' ||
        own.accepted.status !== 'accepted' ||
        !own.identity.ok ||
        own.graph.status !== 'complete'
      )
        throw new Error('Missing actual landed child facts')
      const children = projectNativeUwChildren({ uw: own.uw, graph: own.graph, accepted: own.accepted })
      if (!children.ok) throw new Error(`Landed child role unavailable: ${JSON.stringify(children.diagnostics)}`)
      const input = facts(
        [
          {
            number: 2,
            title: 'Delivered child',
            state: 'CLOSED',
            labels: ['size:S'],
            body: own.accepted.value.snapshot.raw.body,
            blockedBy: [],
            stops: [],
            branches: [],
            completion: completion.state,
            ownUw: {
              status: 'accepted',
              graphComplete: true,
              role: children.value.length ? 'parent' : 'leaf',
              accepted: own.accepted.value,
              identityAllocations: [...own.identity.value.allocations].map(([id, allocationRef]) => ({
                id,
                allocationRef,
              })),
            },
            prs: [
              pr(2, {
                number: Number(nativePr.pullRequest.target.split('#').at(-1)),
                state: nativePr.state,
                head: nativePr.branch,
                base: nativePr.base,
                headSha: nativePr.head,
                baseSha: nativePr.baseTip,
                mergeSha: nativePr.mergeCommit,
                mergedAt: null,
              }),
            ],
          },
        ],
        { epic: 1 },
      )
      expect(summarize(input)).toMatchObject({ merged: [2], closed: [] })
    } finally {
      cleanupSandbox()
    }
  })

  it.each([
    { name: 'green', options: {} },
    { name: 'red base', options: { baseCi: red } },
    { name: 'pending base', options: { baseCi: pending } },
    { name: 'dirty tree', options: { cleanTree: false } },
  ])('requests direct review at the own integration range despite $name', async ({ options }) => {
    const { input, range } = await scenario(options)
    expect(nextStep(input)).toMatchObject({ action: 'final-review', stage: 'review', range })
  })

  it('accepts a clean earlier-run review only with its captured current Parent completion', async () => {
    const { input } = await scenario({ review: 'clean', earlier: true })
    expect(nextStep(input)).toMatchObject({ action: 'post-merge' })
  })

  it('does not use a historical range as current Parent review authority (selector counterfactual)', async () => {
    const { input, range } = await scenario({ review: 'clean', historical: true })
    expect(nextStep(input)).toMatchObject({ action: 'final-review', stage: 'review', range })
  })

  it.each([0, 1])(
    'does not derive Parent range authority from child %i merge-base metadata (selector counterfactual)',
    async (index) => {
      const { input, range } = await scenario()
      const current = input.children[index]
      if (!current?.prs[0]) throw new Error('Expected observed child PR')
      current.prs[0].baseSha = null
      expect(nextStep(input)).toMatchObject({ action: 'final-review', stage: 'review', range })
    },
  )

  it('does not treat an unpinned historical decision as current review authority (selector counterfactual)', async () => {
    const { input, range } = await scenario({ review: 'clean' })
    const review = input.reviews[0]
    if (!review) throw new Error('Expected current review')
    const manifest = { ...review.inputs.manifest, deliveryData: [] }
    input.reviews = [{ ...review, inputs: { ...review.inputs, manifest } }]
    expect(nextStep(input)).toMatchObject({ action: 'final-review', stage: 'review', range })
  })

  it.each([
    { name: 'green base', options: {} },
    { name: 'red base', options: { baseCi: red } },
  ])('drops a genuinely blocking review on $name', async ({ options }) => {
    const { input, proof } = await scenario({ ...options, review: 'blocking' })
    expect(proof.blockingVerdict).toBe('Request changes')
    expect(proof.blockingCompletion.state).not.toBe('complete')
    expect(nextStep(input)).toMatchObject({ action: 'drop', stop: 'final-review-blocking' })
  })

  it('selects the latest current verdict, not an earlier clean review', async () => {
    const { input } = await scenario({ review: 'blocking' })
    const { input: clean } = await scenario({ review: 'clean', earlier: true })
    input.reviews = [...clean.reviews, ...input.reviews]
    expect(nextStep(input)).toMatchObject({ action: 'drop', stop: 'final-review-blocking' })
  })

  it('ignores a historical blocking review after the selected integration changes (selector counterfactual)', async () => {
    const { input, range } = await scenario({ review: 'blocking', historical: true })
    expect(nextStep(input)).toMatchObject({ action: 'final-review', stage: 'review', range })
  })

  it('runs the hook after a fresh clean decision', async () => {
    const { input } = await scenario({ review: 'clean' })
    expect(nextStep(input)).toMatchObject({ action: 'post-merge' })
  })

  it('refuses clean review without a completion citing its exact decision', async () => {
    const { input } = await scenario({ review: 'clean' })
    input.parentCompletion = null
    expect(nextStep(input)).toMatchObject({ action: 'drop', stop: 'driver-error' })
  })

  describe('post-merge hook', () => {
    it('runs without a prior hook record', async () => {
      const { input } = await scenario({ review: 'clean' })
      expect(nextStep(input)).toMatchObject({ action: 'post-merge' })
    })

    it.each([
      { name: 'started then ok in this run', result: 'ok' as const, earlier: false, expected: 'complete' },
      { name: 'skipped in this run', result: 'skipped' as const, earlier: false, expected: 'complete' },
      { name: 'ok in an earlier run', result: 'ok' as const, earlier: true, expected: 'complete' },
      { name: 'skipped in an earlier run', result: 'skipped' as const, earlier: true, expected: 'complete' },
      { name: 'failure in this run', result: 'failed' as const, earlier: false, expected: 'drop' },
      { name: 'failure in an earlier run', result: 'failed' as const, earlier: true, expected: 'post-merge' },
      { name: 'started without result', result: 'started' as const, earlier: false, expected: 'drop' },
    ])('$name', async ({ result, earlier, expected }) => {
      const { input, proof } = await scenario({ review: 'clean' })
      input.hooks = [hook(result, proof.code.head, earlier ? EARLIER : RUN)]
      const step = nextStep(input)
      expect(step.action).toBe(expected)
      if (expected === 'drop') expect(step).toMatchObject({ stop: 'hook-failed' })
    })

    it('does not let an earlier success mask a failure in this run', async () => {
      const { input, proof } = await scenario({ review: 'clean' })
      input.hooks = [
        hook('ok', proof.code.head, EARLIER),
        hook('started', proof.code.head),
        hook('failed', proof.code.head),
      ]
      expect(nextStep(input)).toMatchObject({ action: 'drop', stop: 'hook-failed' })
    })

    it('reruns when an earlier success is at another commit', async () => {
      const { input, proof } = await scenario({ review: 'clean' })
      input.hooks = [hook('ok', firstChild(proof).base, EARLIER)]
      expect(nextStep(input)).toMatchObject({ action: 'post-merge' })
    })

    it.each(['ok', 'skipped'] as const)('refuses a current-run %s at another commit', async (result) => {
      const { input, proof } = await scenario({ review: 'clean' })
      input.hooks = [hook(result, firstChild(proof).base)]
      expect(nextStep(input)).toMatchObject({ action: 'drop', stop: 'hook-stale' })
    })

    it('retains an earlier same-head success over a current stale success', async () => {
      const { input, proof } = await scenario({ review: 'clean' })
      input.hooks = [hook('ok', proof.code.head, EARLIER), hook('ok', firstChild(proof).base)]
      expect(nextStep(input)).toMatchObject({ action: 'complete' })
    })

    it.each([
      { name: 'red', options: { baseCi: red }, stop: 'base-ci-red' },
      { name: 'pending', options: { baseCi: pending }, stop: 'base-ci-pending' },
      { name: 'dirty', options: { cleanTree: false }, stop: 'dirty-tree' },
    ])('holds clean completion on $name, including after a successful hook', async ({ options, stop }) => {
      const { input, proof } = await scenario({ ...options, review: 'clean' })
      expect(nextStep(input)).toMatchObject({ action: 'drop', stop })
      input.hooks = [hook('ok', proof.code.head)]
      expect(nextStep(input)).toMatchObject({ action: 'drop', stop })
    })

    it('runs the hook with no configured base checks', async () => {
      const { input } = await scenario({ review: 'clean', baseCi: noChecks })
      expect(nextStep(input)).toMatchObject({ action: 'post-merge' })
    })
  })
})
