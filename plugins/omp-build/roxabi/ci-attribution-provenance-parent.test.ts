import { afterEach, expect, it, vi } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { sisterSpecWorld } from '../testing/multi-sister-spec-fixture.ts'
import { observedUwWithoutPullRequests } from '../testing/uw-completion-observation.ts'
import { authorizeFixAction } from './fix-ci-evidence.ts'
import { ROXABI_STOP_AUTHOR, withRoxabiGitHubPolicy } from './github-policy.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'
import * as checkout from './workflow-checkout.ts'

afterEach(() => vi.restoreAllMocks())

it('refuses CI admission for an accepted parent with a native child before config or publication', async () => {
  const world = sisterSpecWorld(true)
  if (!world.parentHistory || world.nativeGraph.status !== 'complete')
    throw new Error('accepted-parent-fixture-missing')
  const graph = { ...world.nativeGraph, root: world.parentScope }
  const options = withRoxabiGitHubPolicy({ cwd: '/worktree', readAuthor: 'automation' })
  const parentHistory = decodeHistory({ ...world.parentHistory.source, stopAuthor: ROXABI_STOP_AUTHOR })
  const childHistory = decodeHistory({ ...world.own.source, stopAuthor: ROXABI_STOP_AUTHOR })
  const observation = await observedUwWithoutPullRequests({
    graph,
    histories: [parentHistory, childHistory],
    catalogues: fixtureHostReviewClassCatalogues(),
  })
  const read = await createInstalledObservedUwReadPort({ observation }).readUw(world.parentScope)
  expect(read.graph.status).toBe('complete')
  expect(read.accepted).toMatchObject({ status: 'accepted', value: { children: [{ scope: world.uw }] } })
  expect(graph.nodes.find((node) => node.uw.target === world.parentScope.target)?.children).toContainEqual(world.uw)
  const git = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'must not read config' }))
  vi.spyOn(checkout, 'defaultGit').mockReturnValue(git)
  const head = 'a'.repeat(40)
  const result = await authorizeFixAction(
    {
      cwd: '/worktree',
      target: { ...world.pr, number: 44, kind: 'pull-request', state: 'open', candidateGitSHA: head, baseGitSHA: head },
      branch: 'feature/41',
      base: 'main',
      options,
    },
    parentHistory,
    null,
    [],
    'fix-ci',
    { failedChecks: ['unit'], evidenceDigest: 'c'.repeat(64), failures: [] },
    read,
  )
  expect(result).toEqual({ ok: false, diagnostics: ['fix-own-uw-unsettled', 'current-child-projection-incomplete'] })
  expect(git).not.toHaveBeenCalled()
})
