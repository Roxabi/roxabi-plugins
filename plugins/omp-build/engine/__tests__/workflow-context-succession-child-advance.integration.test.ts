import { expect, test } from 'vitest'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { authenticatedChildAdvance } from '../workflow-context-succession-child-advance.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

test('accepts only first-parent advances accounted for by exact delivered accepted children', async () => {
  const checkout = nativeImplementationGit()
  try {
    const [first, second, third] = checkout.merges
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('Missing child merge fixture')
    await checkout.publishBase(third)
    const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parentCheckout.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, first, second].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(third, checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const accepted = resolveAcceptedSpec(world.parent, world.observation.histories)
        if (!accepted.ok) throw new Error('Parent accepted Spec unavailable')
        const issue = world.observation.histories.find(
          (history) => history.source.scope.target === world.parentScope.target,
        )
        if (issue === undefined) throw new Error('Parent history unavailable')
        const evidence = {
          issue,
          pullRequest: null,
          parents: world.observation.histories.filter((history) => history !== issue),
          causal: {
            histories: world.observation.histories,
            catalogues: world.observation.catalogues,
            observation: world.observation,
          },
        }
        const succession = {
          replacementAccepted: accepted.spec,
          baselineCode: {
            repository: world.parentScope.repository,
            base: world.p0,
            head: world.p0,
            referenceCommit: world.p0,
          },
        }
        const check = (head: string, observed = world.observation, spec = succession) =>
          authenticatedChildAdvance(
            {
              ...evidence,
              causal: {
                ...evidence.causal,
                histories: observed.histories,
                catalogues: observed.catalogues,
                observation: observed,
              },
            },
            world.parent,
            spec,
            head,
          )
        expect(check(third)).toBe(true)
        expect(check(first)).toBe(true)
        const rogue = 'f'.repeat(40)
        const unrelated = {
          ...world.observation,
          delivery: world.observation.delivery.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  commits: [
                    ...item.commits,
                    { code: { repository: world.parentScope.repository, commit: rogue }, parents: [third] },
                  ],
                }
              : item,
          ),
        }
        expect(check(rogue, unrelated)).toBe(false)
        const wrongVersion = {
          ...succession,
          replacementAccepted: {
            ...accepted.spec,
            children: accepted.spec.children.map((child, index) =>
              index === 0 ? { ...child, specVersion: 'e'.repeat(64) } : child,
            ),
          },
        }
        expect(check(first, world.observation, wrongVersion)).toBe(true)
        const foreignMerge = {
          ...world.observation,
          delivery: world.observation.delivery.map((item) => ({
            ...item,
            pullRequests: item.pullRequests.map((pr) =>
              pr.mergeCommit === first ? { ...pr, state: 'OPEN' as const, mergeCommit: null } : pr,
            ),
          })),
        }
        expect(check(first, foreignMerge)).toBe(false)
        const missingAncestry = {
          ...world.observation,
          delivery: world.observation.delivery.map((item) => ({
            ...item,
            commits: item.commits.filter((commit) => commit.code.commit !== second),
          })),
        }
        expect(check(third, missingAncestry)).toBe(false)
        const partial = {
          ...world.observation,
          delivery: world.observation.delivery.filter((item) => item.uw.target !== world.reviews[2]?.uw.target),
        }
        expect(check(first, partial)).toBe(true)
        expect(check(third, partial)).toBe(false)
      },
    )
  } finally {
    checkout.cleanup()
  }
}, 60_000)
