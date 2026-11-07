import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import * as contracts from '../../dist/contracts.js'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { deliverCreatedSister } from '../../testing/sister-delivery-fixture.ts'
import { linkedIssueBinding } from '../fix-checkpoint-binding.ts'
import { authorizeFixAction } from '../fix-ci-evidence.ts'
import type { FixTarget } from '../fix-contract.ts'
import { withRoxabiGitHubPolicy } from '../github-policy.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'

const PR = { repository: 'acme/app', target: 'acme/app#44' }
const SHA = 'a'.repeat(40)
const target: FixTarget = {
  ...PR,
  number: 44,
  kind: 'pull-request',
  state: 'open',
  candidateGitSHA: SHA,
  baseGitSHA: SHA,
}

type BoundaryEvidence =
  | 'intact'
  | 'missing-identity'
  | 'forged-identity'
  | 'missing-source'
  | 'forged-source'
  | 'conflicting-root'

function mutateBoundaryEvidence(
  evidence: BoundaryEvidence,
  world: Awaited<ReturnType<typeof installedMultiSisterFixture>>,
  authentic: Awaited<ReturnType<ReturnType<typeof createInstalledUwReadPort>['readUw']>>,
  source: (typeof authentic.histories)[number],
): void {
  if (evidence === 'missing-identity') world.comments.set(43, [])
  if (evidence === 'missing-source') world.comments.set(44, [])
  if (evidence === 'forged-identity') {
    const history = authentic.histories.find((item) => item.source.scope.target === 'acme/app#43')
    const identity = history && contracts.recordsOf(history).find((record) => record.kind === 'spec-identity')
    if (identity?.kind !== 'spec-identity') throw new Error('first sister identity unavailable')
    world.comments.set(43, [nativeComment(801, wire({ ...identity, operationId: 'forged-operation' }))])
  }
  if (evidence === 'forged-source') {
    const decision = contracts.recordsOf(source).find((record) => record.kind === 'decision')
    if (decision?.kind !== 'decision') throw new Error('review decision unavailable')
    const retained = (world.comments.get(44) ?? []).filter((comment) => !comment.body.includes('kind=decision'))
    const forged = {
      ...decision,
      operationId: 'forged-source-operation',
      payload: {
        ...decision.payload,
        judgment: {
          ...decision.payload.judgment,
          causes: decision.payload.judgment.causes.map((cause) => ({ ...cause, title: 'Forged source cause' })),
        },
      },
    }
    world.comments.set(44, [...retained, nativeComment(802, wire(forged))])
  }
  if (evidence === 'conflicting-root') {
    const retained = (world.comments.get(42) ?? []).filter((comment) => !comment.body.includes('kind=debt-receipt'))
    world.comments.set(42, retained)
  }
}

it.each([
  'intact',
  'missing-identity',
  'forged-identity',
  'missing-source',
  'forged-source',
  'conflicting-root',
] as const)(
  'uses complete authenticated UW evidence for default and CI correction after sister receipts: %s',
  async (evidence) => {
    const world = await installedMultiSisterFixture(1)
    expect((await world.operations.createSister(world.request(0))).status).toBe('created')
    const first = world.issues.get(43)
    if (!first) throw new Error('actual sister issue must exist')
    await deliverCreatedSister(world)
    first.state = 'CLOSED'
    first.stateReason = 'COMPLETED'
    const github = withRoxabiGitHubPolicy({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
    const reader = createInstalledUwReadPort(github)
    const authentic = await reader.readUw(world.context.original)
    expect(authentic.admission.deliverable, JSON.stringify(authentic.admission)).toMatchObject({ ok: true })
    const original = authentic.histories.find((history) => history.source.scope.target === 'acme/app#42')
    const source = authentic.histories.find((history) => history.source.scope.target === PR.target)
    const binding = source && contracts.recordsOf(source).find((record) => record.kind === 'workflow-binding')
    if (!original || !source || binding?.kind !== 'workflow-binding')
      throw new Error('complete UW read must retain authenticated origin and review source')
    expect(authentic.histories.map((history) => history.source.scope.target)).toEqual(
      expect.arrayContaining(['acme/app#42', 'acme/app#43', 'acme/app#44']),
    )
    mutateBoundaryEvidence(evidence, world, authentic, source)
    const observed =
      evidence === 'intact' || evidence === 'conflicting-root' ? authentic : await reader.readUw(world.context.original)
    const freshRoot = await contracts.readComposedWorkflowHistory([world.context.original], github)
    if (!freshRoot.ok) throw new Error(`current binding history unreadable: ${JSON.stringify(freshRoot.diagnostics)}`)
    const bindingHistory = freshRoot.histories[0]
    const selectedReader = { readUw: async () => observed }
    const result = await linkedIssueBinding(target, github, selectedReader)
    const noRepository = mkdtempSync(join(tmpdir(), 'omp-no-config-'))
    const ci = await authorizeFixAction(
      { cwd: noRepository, target, branch: 'feat/42-save', base: 'main', options: github },
      source,
      bindingHistory,
      [],
      'fix',
      { failedChecks: ['unit'], evidenceDigest: 'c'.repeat(64), failures: [] },
      observed,
    ).finally(() => rmSync(noRepository, { recursive: true, force: true }))
    if (evidence === 'intact') {
      expect(result.ok, JSON.stringify(result)).toBe(true)
      // The deliberately unavailable configuration is the next independent boundary;
      // reaching it proves admission passed, not that CI authorization succeeded.
      expect(ci.ok).toBe(false)
      if (!ci.ok) expect(ci.diagnostics.some((diagnostic) => diagnostic.startsWith('fix-config-'))).toBe(true)
    } else {
      expect(result.ok, JSON.stringify(result)).toBe(false)
      expect(ci).toMatchObject({ ok: false, diagnostics: expect.arrayContaining(['fix-own-uw-unsettled']) })
    }
  },
)

it('preserves a genuinely unlinked standalone pull request when no workflow binding exists', async () => {
  const world = await installedMultiSisterFixture(1)
  world.comments.set(44, [])
  world.setLinked(false)
  const github = withRoxabiGitHubPolicy({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
  const reader = createInstalledUwReadPort(github)
  const result = await linkedIssueBinding(target, github, reader)
  expect(result).toMatchObject({
    ok: true,
    value: { history: null, currentSpec: null, branch: 'feat/42-save', base: 'main' },
  })
})

it('does not treat a natively linked managed issue with a missing binding as standalone', async () => {
  const world = await installedMultiSisterFixture(1)
  world.comments.set(44, [])
  const github = withRoxabiGitHubPolicy({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
  const result = await linkedIssueBinding(target, github, createInstalledUwReadPort(github))
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining(['fix-binding-unreadable', 'fix-linked-uw-managed']),
  })
})

it('reconstructs CI and default authority with committed configuration under the Bun runtime', () => {
  const script = fileURLToPath(new URL('../../testing/fix-cause-ci-bun-fixture.ts', import.meta.url))
  execFileSync('bun', [script], { encoding: 'utf8', stdio: 'pipe' })
})
