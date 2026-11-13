import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import * as contracts from '../contracts.ts'
import { fixturePreparedAction, fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../testing/uw-completion-observation.ts'
import {
  authenticatedPlanFixtures,
  BODY,
  SCOPE,
} from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import * as delivery from './delivery-action.ts'
import * as engine from './feature-engine.ts'
import { planAction } from './feature-plan-start.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { defaultGit } from './workflow-checkout.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-worktree-'))
  roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(cwd, 'tracked'), 'original\n')
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  return { cwd, git, head: git('rev-parse', 'HEAD') }
}

it.each(['clean', 'unstaged', 'staged', 'deleted', 'untracked', 'ignored'] as const)(
  'observes a %s worktree with real Git',
  async (state) => {
    const { cwd, git, head } = repository()
    if (state === 'unstaged' || state === 'staged') writeFileSync(join(cwd, 'tracked'), 'changed\n')
    if (state === 'staged') git('add', 'tracked')
    if (state === 'deleted') rmSync(join(cwd, 'tracked'))
    if (state === 'untracked') {
      git('config', 'status.showUntrackedFiles', 'no')
      writeFileSync(join(cwd, 'new-file'), 'new\n')
    }
    if (state === 'ignored') writeFileSync(join(cwd, 'ignored'), 'ignored\n')
    const result = await delivery.observeCleanHeadCode(defaultGit(), cwd, SCOPE.repository)
    if (state === 'clean' || state === 'ignored') {
      expect(result).toEqual({
        ok: true,
        code: { repository: SCOPE.repository, base: head, head, referenceCommit: head },
      })
    } else {
      expect(result).toEqual({ ok: false, reason: 'code-worktree-dirty' })
    }
  },
)

it('refuses a non-repository and a failed or thrown status observation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-no-git-'))
  roots.push(cwd)
  expect(await delivery.observeCleanHeadCode(defaultGit(), cwd, SCOPE.repository)).toEqual({
    ok: false,
    reason: 'code-unobserved',
  })
  const repo = repository()
  for (const failure of ['exit', 'throw'] as const) {
    const git = defaultGit()
    expect(
      await delivery.observeCleanHeadCode(
        async (dir, args) => {
          if (args[0] !== 'status') return git(dir, args)
          if (failure === 'throw') throw new Error('status unavailable')
          return { code: 1, stdout: '', stderr: 'status unavailable' }
        },
        repo.cwd,
        SCOPE.repository,
      ),
    ).toEqual({ ok: false, reason: 'code-unobserved' })
  }
})

it.each(['draft', 'amendment', 'review'] as const)(
  'admits clean %s planning and refuses dirty planning before preparation or publication',
  async (phase) => {
    const repo = repository()
    const base = roxabiWorkflowFixtures()
    const mandate = base.featureMandate(SCOPE, { body: BODY })
    const fixtures = authenticatedPlanFixtures(mandate, [base.historyFrom([mandate])]).workflow
    const draft = fixtures.planDraftRecords(mandate)
    const review = fixtures.planReviewRecord(mandate, 'act-plan-1', fixtures.publishedPlanDigest(), [
      fixtures.blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      fixtures.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const records =
      phase === 'draft'
        ? [mandate]
        : phase === 'review'
          ? [mandate, ...draft]
          : [mandate, ...draft, fixtures.planReviewStart(mandate, 'act-plan-1', fixtures.publishedPlanDigest()), review]
    const fixtureHistory = fixtures.historyFrom(records)
    const history = decodeHistory({ ...fixtureHistory.source, stopAuthor: 'github-actions[bot]' })
    const date = '2026-10-27T12:00:00.000Z'
    const observation = await observedUwWithoutPullRequests({
      graph: {
        status: 'complete',
        root: SCOPE,
        observedAt: date,
        nodes: [
          {
            uw: SCOPE,
            title: 'Plan',
            raw: rawSource(SCOPE.target, BODY, date),
            updatedAt: date,
            labels: ['size:S'],
            wayfinderLabels: [],
            parent: null,
            children: [],
            blockers: [],
            native: { state: 'OPEN', stateReason: null },
          },
        ],
      },
      histories: [history],
      catalogues: fixtureHostReviewClassCatalogues(),
    })
    const evidence = {
      issue: history,
      pullRequest: null,
      parents: [],
      causal: { histories: observation.histories, catalogues: observation.catalogues, observation },
    }
    const prepared = fixturePreparedAction()
    roots.push(join(prepared.snapshot.indexPath, '..'))
    const prepare = vi.fn(async (_request: UwActionRequest) => ({ ok: true as const, value: prepared }))
    const operations = fixtureUwOperations(prepare)
    const publish = vi.spyOn(engine, 'publishRecord').mockResolvedValue({ ok: true })
    vi.spyOn(delivery, 'confirmStartReadback').mockResolvedValue({ ok: true })
    const gh = async () => ''
    writeFileSync(join(repo.cwd, 'tracked'), 'dirty\n')
    const dirty = await planAction(contracts, evidence, history, gh, repo.cwd, SCOPE, mandate, operations, defaultGit())
    expect(dirty).toMatchObject({ kind: 'blocked', reason: 'code-worktree-dirty' })
    expect(prepare).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    repo.git('checkout', '--', 'tracked')
    const clean = await planAction(contracts, evidence, history, gh, repo.cwd, SCOPE, mandate, operations, defaultGit())
    expect(clean.kind).toBe('action')
    if (clean.kind !== 'action') throw new Error(JSON.stringify(clean))
    expect(clean.followUp.tasks.tasks.map((task) => task.agent)).toEqual(
      phase === 'review' ? ['R-workflow-plan-architect', 'R-workflow-plan-adversarial'] : ['R-workflow-plan'],
    )
    expect(prepare).toHaveBeenCalledTimes(phase === 'review' ? 2 : 1)
    for (const [request] of prepare.mock.calls) {
      expect(request.code).toEqual({
        repository: SCOPE.repository,
        base: repo.head,
        head: repo.head,
        referenceCommit: repo.head,
      })
    }
    expect(publish).toHaveBeenCalledTimes(1)
  },
)
