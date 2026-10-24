import { describe, it } from 'vitest'
import type { Case } from './epic-transition.fixture'
import {
  branch,
  child,
  decides,
  EARLIER,
  facts,
  head,
  landed,
  OTHER_REPO,
  on,
  pr,
  RUN,
  sha,
  T1,
} from './epic-transition.fixture'

describe('stops across runs', () => {
  it.each<Case>([
    {
      name: 'a current-run stop is skipped with its dependent; the independent child continues',
      facts: facts([
        child(1, { stops: [{ run: RUN, reason: 'timeout' }] }),
        child(2, { blockedBy: [on(1)] }),
        child(3),
      ]),
      step: { action: 'start', ticket: 3 },
      report: {
        stopped: [{ ticket: 1, reason: 'timeout', sticky: false }],
        skipped: [{ ticket: 2, blockers: [1] }],
      },
    },
    {
      name: 'a current-run behind stop is skipped with its dependent; the independent child continues',
      facts: facts([child(1, { stops: [{ run: RUN, reason: 'behind' }] }), child(2, { blockedBy: [on(1)] }), child(3)]),
      step: { action: 'start', ticket: 3 },
      report: {
        stopped: [{ ticket: 1, reason: 'behind', sticky: false }],
        skipped: [{ ticket: 2, blockers: [1] }],
      },
    },
    {
      name: 'an earlier-run behind stop is retried by a fresh run',
      facts: facts([child(1, { stops: [{ run: EARLIER, reason: 'behind' }] }), child(2, { blockedBy: [on(1)] })]),
      step: { action: 'start', ticket: 1 },
      report: { stopped: [], skipped: [{ ticket: 2, blockers: [1] }] },
    },
    {
      name: 'an earlier-run non-sticky stop is retried',
      facts: facts([child(1, { stops: [{ run: EARLIER, reason: 'timeout' }] }), child(2, { blockedBy: [on(1)] })]),
      step: { action: 'start', ticket: 1 },
      report: { stopped: [], skipped: [{ ticket: 2, blockers: [1] }] },
    },
    {
      name: 'a review-bound stop from an earlier run stays stopped, even with an open PR',
      facts: facts([
        child(1, { stops: [{ run: EARLIER, reason: 'review-bound' }], prs: [pr(1)], branches: [branch(head(1))] }),
        child(2),
      ]),
      step: { action: 'start', ticket: 2 },
      report: { stopped: [{ ticket: 1, reason: 'review-bound', sticky: true }] },
    },
    {
      name: 'an open PR with its review bound spent stays stopped without a marker',
      facts: facts([child(1, { prs: [pr(1, { exhausted: true })], branches: [branch(head(1))] }), child(2)]),
      step: { action: 'start', ticket: 2 },
      report: { stopped: [{ ticket: 1, reason: 'review-bound', sticky: true }] },
    },
    {
      name: "HEAD on a stopped child's branch does not make it the target",
      facts: facts([child(1, { stops: [{ run: RUN, reason: 'ci-blocked' }], branches: [branch(head(1))] }), child(2)], {
        tree: { clean: true, branch: head(1) },
      }),
      step: { action: 'start', ticket: 2 },
    },
  ])('$name', decides)
})

describe('merged children', () => {
  it.each<Case>([
    {
      name: 'merged into the base with the issue still open (staging-train) → done',
      facts: facts([child(1, { prs: [landed(1, T1, sha('1'), sha('2'))] }), child(2, { blockedBy: [on(1)] })]),
      step: { action: 'start', ticket: 2 },
      report: { merged: [1], skipped: [] },
    },
    {
      name: 'merged into another base → not done',
      facts: facts([
        child(1, { prs: [landed(1, T1, sha('1'), sha('2'), { base: 'staging' })] }),
        child(2, { blockedBy: [on(1)] }),
      ]),
      step: { action: 'start', ticket: 1 },
      report: { merged: [], skipped: [{ ticket: 2, blockers: [1] }] },
    },
    {
      name: 'merged from a branch claiming another ticket → not done',
      facts: facts([
        child(1, { prs: [landed(1, T1, sha('1'), sha('2'), { head: 'feat/9-other' })] }),
        child(2, { blockedBy: [on(1)] }),
      ]),
      step: { action: 'start', ticket: 1 },
      report: { merged: [] },
    },
    {
      name: 'MERGED with no merge commit → not done',
      facts: facts([
        child(1, { prs: [landed(1, T1, sha('1'), sha('2'), { mergeSha: null })] }),
        child(2, { blockedBy: [on(1)] }),
      ]),
      step: { action: 'start', ticket: 1 },
      report: { merged: [] },
    },
  ])('$name', decides)
})

describe('shared state before a ticket', () => {
  it.each<Case>([
    {
      name: 'a dirty detached tree → drop dirty-tree',
      facts: facts([child(1)], { tree: { clean: false, branch: null } }),
      step: { action: 'drop', stop: 'dirty-tree' },
    },
    {
      name: "a dirty tree on a finished child's branch → drop dirty-tree",
      facts: facts([child(1, { state: 'CLOSED' }), child(2)], { tree: { clean: false, branch: head(1) } }),
      step: { action: 'drop', stop: 'dirty-tree' },
    },
    {
      name: "a dirty tree on a stopped child's branch → drop dirty-tree",
      facts: facts([child(1, { stops: [{ run: RUN, reason: 'timeout' }], branches: [branch(head(1))] }), child(2)], {
        tree: { clean: false, branch: head(1) },
      }),
      step: { action: 'drop', stop: 'dirty-tree' },
    },
    {
      name: "a dirty tree on the target's own branch → resume",
      facts: facts([child(1, { branches: [branch(head(1))] }), child(2)], {
        tree: { clean: false, branch: head(1) },
      }),
      step: { action: 'resume', ticket: 1, branch: head(1) },
    },
    {
      name: 'a red base → drop base-ci-red',
      facts: facts([child(1)], { baseCi: { state: 'red', failed: ['test'], pending: [] } }),
      step: { action: 'drop', stop: 'base-ci-red' },
      report: { baseCi: { state: 'red', failed: ['test'], pending: [] } },
    },
    {
      name: 'an unreadable landing → drop bad-landing, whatever the children',
      facts: facts([child(1)], { landingError: 'landing.mode must be native or merge-on-green' }),
      step: { action: 'drop', stop: 'bad-landing' },
    },
    {
      name: 'an unreadable landing drops even once every child is done',
      facts: facts([child(1, { state: 'CLOSED' })], { landingError: 'bad' }),
      step: { action: 'drop', stop: 'bad-landing' },
    },
    {
      name: 'a pending base → proceed and report it',
      facts: facts([child(1)], { baseCi: { state: 'pending', failed: [], pending: ['build'] } }),
      step: { action: 'start', ticket: 1 },
      report: { baseCi: { state: 'pending', failed: [], pending: ['build'] } },
    },
    {
      name: 'no base checks → proceed',
      facts: facts([child(1)], { baseCi: { state: 'none', failed: [], pending: [] } }),
      step: { action: 'start', ticket: 1 },
    },
  ])('$name', decides)
})

describe('no progress', () => {
  it.each<Case>([
    {
      name: 'only stopped and blocked children open → drop no-progress',
      facts: facts([
        child(1, { stops: [{ run: RUN, reason: 'timeout' }] }),
        child(2, { blockedBy: [on(1)] }),
        child(3, { blockedBy: [on(900, 'OPEN', OTHER_REPO)] }),
      ]),
      step: { action: 'drop', stop: 'no-progress' },
      report: {
        stopped: [{ ticket: 1, reason: 'timeout', sticky: false }],
        skipped: [
          { ticket: 2, blockers: [1] },
          { ticket: 3, blockers: [900] },
        ],
      },
    },
    {
      name: 'only a sticky stop open → drop no-progress',
      facts: facts([child(1, { state: 'CLOSED' }), child(2, { stops: [{ run: EARLIER, reason: 'review-bound' }] })]),
      step: { action: 'drop', stop: 'no-progress' },
    },
  ])('$name', decides)
})
