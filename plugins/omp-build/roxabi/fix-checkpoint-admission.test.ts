import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import * as contracts from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwGraphObservation, UwNativeNode } from '../engine/uw-graph.ts'
import { canonicalSpec, type SpecSnapshot } from '../engine/uw-spec.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { linkedIssueBinding } from './fix-checkpoint-binding.ts'
import { authorizeFixAction } from './fix-ci-evidence.ts'
import type { FixTarget } from './fix-contract.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'
import * as checkout from './workflow-checkout.ts'

const UW: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const PR: Scope = { repository: 'acme/payments', target: 'acme/payments#99' }
const BLOCKER: Scope = { repository: 'acme/payments', target: 'acme/payments#7' }
const WAYFINDER: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const OBSERVED_AT = '2026-10-27T12:00:00.000Z'
const SHA = 'a'.repeat(40)

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(','))
  return result.value
}

function snapshot(scope: Scope): SpecSnapshot {
  const canonical = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Keep correction admission bound to native UW delivery state' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, renderIssueSpecBody(canonical, { complexity: 5 }), OBSERVED_AT),
  })
  if (parsed.status !== 'conformant') throw new Error(`expected conformant Spec, received ${parsed.status}`)
  return parsed.snapshot
}

function node(input: {
  scope: Scope
  snapshot: SpecSnapshot
  blockers?: readonly Scope[]
  native?: UwNativeNode['native']
}): UwNativeNode {
  return {
    uw: input.scope,
    title: `UW ${input.scope.target}`,
    raw: input.snapshot.raw,
    updatedAt: OBSERVED_AT,
    labels: ['size:S'],
    wayfinderLabels: [],
    parent: null,
    children: [],
    blockers: input.blockers ?? [],
    native: input.native ?? { state: 'OPEN', stateReason: null },
  }
}

function graph(root: Scope, nodes: readonly UwNativeNode[]): UwGraphObservation {
  return { status: 'complete', root, nodes, observedAt: OBSERVED_AT }
}

function pullRequestTarget(): FixTarget {
  return {
    repository: PR.repository,
    target: PR.target,
    number: 99,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: SHA,
    baseGitSHA: SHA,
  }
}

function fixture(nativeBlocker: UwNativeNode['native'], withWayfinder = false) {
  const fixtures = roxabiWorkflowFixtures()
  const ownSpec = fixtures.ownSpecFromSnapshot(UW, snapshot(UW))
  const mandate = fixtures.featureMandate(UW, {
    recordId: 'mandate-41',
    operationId: 'mandate-41-operation',
    branch: 'feature/41',
    base: 'main',
    lineageHead: SHA,
    ownSpec,
  })
  const binding = fixtures.workflowBinding(PR, mandate, 'feature/41', 'main')
  const history = fixtures.historyFrom([mandate])
  const observed = graph(UW, [
    {
      ...node({ scope: UW, snapshot: ownSpec.snapshot, blockers: [BLOCKER] }),
      children: withWayfinder ? [WAYFINDER] : [],
    },
    node({ scope: BLOCKER, snapshot: snapshot(BLOCKER), native: nativeBlocker }),
    ...(withWayfinder
      ? [
          {
            ...node({ scope: WAYFINDER, snapshot: snapshot(WAYFINDER) }),
            labels: ['wayfinder:map'],
            wayfinderLabels: ['wayfinder:map'],
            parent: UW,
          },
        ]
      : []),
  ])
  const reader = createInstalledObservedUwReadPort({ graph: observed, histories: [history] })
  const bindingRead = {
    ok: true as const,
    value: {
      binding,
      history,
      histories: [history],
      parentScopes: [],
      native: { branch: 'feature/41', base: 'main', pullRequest: PR, linkedIssueScopes: [UW] },
      observed: { head: SHA, baseTip: 'b'.repeat(40) },
      uwGraph: observed,
    },
  }
  return { bindingRead, history, reader }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fix checkpoint UW delivery admission', () => {
  it('allows default and CI correction past leaf admission with an unchanged never-accepted wayfinder', async () => {
    const leaf = fixture({ state: 'CLOSED', stateReason: 'COMPLETED' }, true)
    const read = await leaf.reader.readUw(UW)
    expect(read.accepted).toMatchObject({ status: 'accepted', value: { children: [] } })
    expect(read.admission).toMatchObject({ framed: { ok: true }, deliverable: { ok: true } })

    vi.spyOn(contracts, 'readWorkflowBinding').mockResolvedValueOnce(leaf.bindingRead)
    const binding = await linkedIssueBinding(pullRequestTarget(), { cwd: '/worktree' }, leaf.reader)
    expect(binding).toMatchObject({ ok: true, value: { currentSpec: { tier: 'S', children: [] } } })

    const git = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'correction config unavailable' }))
    vi.spyOn(checkout, 'defaultGit').mockReturnValue(git)
    const ci = await authorizeFixAction(
      {
        cwd: '/worktree',
        target: pullRequestTarget(),
        branch: 'feature/41',
        base: 'main',
        options: { cwd: '/worktree' },
      },
      leaf.history,
      null,
      [],
      'fix',
      { failedChecks: ['unit'], evidenceDigest: 'c'.repeat(64), failures: [] },
      read,
    )
    expect(ci).toMatchObject({ ok: false, diagnostics: expect.arrayContaining(['fix-config-unreadable']) })
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('refuses default-fix advancement for a CLOSED/NOT_PLANNED blocker while preserving CLOSED/COMPLETED', async () => {
    const blocked = fixture({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })
    const completed = fixture({ state: 'CLOSED', stateReason: 'COMPLETED' })
    const blockedRead = await blocked.reader.readUw(UW)
    const completedRead = await completed.reader.readUw(UW)
    expect(blockedRead.graph.nodes).toContainEqual(
      expect.objectContaining({ uw: BLOCKER, native: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } }),
    )
    expect(blockedRead.admission).toMatchObject({
      framed: { ok: true },
      deliverable: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: 'blocker-not-completed',
            location: { kind: 'native', uw: UW, connection: 'blockers' },
          }),
        ],
      },
    })
    expect(completedRead.admission).toMatchObject({ framed: { ok: true }, deliverable: { ok: true } })

    const bindingRead = vi.spyOn(contracts, 'readWorkflowBinding')
    bindingRead.mockResolvedValueOnce(completed.bindingRead).mockResolvedValueOnce(blocked.bindingRead)
    const defaultCompleted = await linkedIssueBinding(pullRequestTarget(), { cwd: '/worktree' }, completed.reader)
    const defaultBlocked = await linkedIssueBinding(pullRequestTarget(), { cwd: '/worktree' }, blocked.reader)

    expect(defaultCompleted).toMatchObject({ ok: true, value: { currentSpec: { tier: 'S', children: [] } } })
    expect(defaultBlocked).toMatchObject({ ok: false })
    if (defaultBlocked.ok) throw new Error('expected default-fix delivery refusal')
    expect(defaultBlocked.diagnostics).toEqual(
      expect.arrayContaining(['fix-own-uw-unsettled', 'blocker-not-completed']),
    )
  })

  it('refuses CI correction before its config read when the fresh UW graph has a CLOSED/NOT_PLANNED blocker', async () => {
    const blocked = fixture({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })
    const completed = fixture({ state: 'CLOSED', stateReason: 'COMPLETED' })
    const blockedRead = await blocked.reader.readUw(UW)
    const completedRead = await completed.reader.readUw(UW)
    expect(blockedRead.graph.nodes).toContainEqual(
      expect.objectContaining({ uw: BLOCKER, native: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } }),
    )
    expect(blockedRead.admission).toMatchObject({
      framed: { ok: true },
      deliverable: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: 'blocker-not-completed',
            location: { kind: 'native', uw: UW, connection: 'blockers' },
          }),
        ],
      },
    })
    expect(completedRead.admission).toMatchObject({ framed: { ok: true }, deliverable: { ok: true } })

    const git = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'correction config unavailable' }))
    vi.spyOn(checkout, 'defaultGit').mockReturnValue(git)
    const input = {
      cwd: '/worktree',
      target: pullRequestTarget(),
      branch: 'feature/41',
      base: 'main',
      options: { cwd: '/worktree' },
    }
    const liveEvidence = { failedChecks: ['unit'], evidenceDigest: 'c'.repeat(64), failures: [] }
    const ciCompleted = await authorizeFixAction(input, completed.history, null, [], 'fix', liveEvidence, completedRead)
    const ciBlocked = await authorizeFixAction(input, blocked.history, null, [], 'fix', liveEvidence, blockedRead)

    expect(ciCompleted).toMatchObject({ ok: false, diagnostics: expect.arrayContaining(['fix-config-unreadable']) })
    expect(ciBlocked).toMatchObject({ ok: false })
    if (ciBlocked.ok) throw new Error('expected CI correction delivery refusal')
    expect(ciBlocked.diagnostics).toEqual(expect.arrayContaining(['fix-own-uw-unsettled', 'blocker-not-completed']))
    expect(git).toHaveBeenCalledTimes(1)
  })
})
