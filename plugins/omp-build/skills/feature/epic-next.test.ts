import { describe, it } from 'vitest'
import { branchFor } from './epic-naming'
import {
  branch,
  type Case,
  child,
  decides,
  facts,
  head,
  OTHER_REPO,
  on,
  pr,
  refusedOwnUw,
  sha,
} from './epic-transition.fixture'

describe('nextStep', () => {
  describe('order and blockers', () => {
    it.each<Case>([
      {
        name: 'fresh start → the first child in blocked_by order, on a branchFor name',
        facts: facts([
          child(1, { blockedBy: [on(3)] }),
          child(3, { blockedBy: [on(2)] }),
          child(2, { title: 'fix(driver): Handle résumé edge' }),
        ]),
        step: { action: 'start', ticket: 2, branch: 'fix/2-handle-resume-edge' },
        report: {
          stopped: [],
          skipped: [
            { ticket: 1, blockers: [3] },
            { ticket: 3, blockers: [2] },
          ],
        },
      },
      {
        name: 'independent children → the lowest number first',
        facts: facts([child(5), child(4)]),
        step: { action: 'start', ticket: 4, branch: 'feat/4-child-4' },
      },
      {
        name: 'closed in-epic and out-of-epic blockers → the child is actionable',
        facts: facts([
          child(1, { state: 'CLOSED', stateReason: 'COMPLETED' }),
          child(2, {
            blockedBy: [
              { number: 1, state: 'CLOSED', stateReason: 'COMPLETED' },
              { number: 900, state: 'CLOSED', stateReason: 'COMPLETED', repo: OTHER_REPO },
            ],
          }),
        ]),
        step: { action: 'start', ticket: 2, branch: 'feat/2-child-2' },
        report: { closed: [1], skipped: [] },
      },
      {
        name: 'an open out-of-epic blocker → that child skipped, the independent one started',
        facts: facts([child(1, { blockedBy: [on(900, 'OPEN', OTHER_REPO)] }), child(2)]),
        step: { action: 'start', ticket: 2 },
        report: { skipped: [{ ticket: 1, blockers: [900] }] },
      },
      {
        name: 'a blocker in another repo is not the sibling with the same number',
        facts: facts([child(1, { state: 'CLOSED' }), child(2, { blockedBy: [on(1, 'OPEN', OTHER_REPO)] }), child(3)]),
        step: { action: 'start', ticket: 3 },
        report: { closed: [1], skipped: [{ ticket: 2, blockers: [1] }] },
      },
      {
        name: 'a same-repo blocker outside the epic counts by its own state',
        facts: facts([
          child(1, { blockedBy: [on(42)] }),
          child(2, { blockedBy: [{ number: 43, state: 'CLOSED', stateReason: 'COMPLETED' }] }),
        ]),
        step: { action: 'start', ticket: 2 },
        report: { skipped: [{ ticket: 1, blockers: [42] }] },
      },
    ])('$name', decides)
  })

  describe('target priority', () => {
    const plain = child(1)
    const branched = child(2, { branches: [branch(head(2))] })
    const withPr = child(3, { prs: [pr(3)], branches: [branch(head(3))] })
    const current = child(4, { branches: [branch(head(4))] })

    it.each<Case>([
      {
        name: "HEAD's own child beats an open PR",
        facts: facts([plain, branched, withPr, current], { tree: { clean: true, branch: head(4) } }),
        step: { action: 'resume', ticket: 4, branch: head(4), pr: null },
      },
      {
        name: 'an open PR beats an existing branch',
        facts: facts([plain, branched, withPr, current]),
        step: { action: 'resume', ticket: 3, branch: head(3), pr: { number: 103 } },
      },
      {
        name: 'an existing branch beats order',
        facts: facts([plain, branched]),
        step: { action: 'resume', ticket: 2, branch: head(2), pr: null },
      },
      {
        name: 'nothing started → order',
        facts: facts([child(2), plain]),
        step: { action: 'start', ticket: 1, branch: head(1) },
      },
    ])('$name', decides)
  })

  describe('resume and branch checks', () => {
    it.each<Case>([
      {
        name: 'an open PR is resumed on its head',
        facts: facts([child(1, { prs: [pr(1, { armed: true })], branches: [branch(head(1), { local: false })] })]),
        step: { action: 'resume', ticket: 1, branch: head(1), pr: { number: 101, armed: true } },
      },
      {
        name: 'the same branch local and on origin is one claim',
        facts: facts([child(1, { branches: [branch(head(1)), branch(head(1), { local: false })] })]),
        step: { action: 'resume', ticket: 1, branch: head(1), pr: null },
      },
      {
        name: 'an open PR into another base → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1, { base: 'staging' })], branches: [branch(head(1))] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'an open PR whose head claims another ticket → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1, { head: 'feat/2-other' })], branches: [branch('feat/2-other')] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'two open PRs → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1), pr(1, { number: 201 })], branches: [branch(head(1))] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'two branches claiming the child → branch-mismatch',
        facts: facts([child(1, { branches: [branch(head(1)), branch('fix/1-other', { local: false })] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'an open PR plus a stray second branch → resume on the PR head',
        facts: facts([
          child(1, { prs: [pr(1)], branches: [branch(head(1)), branch('fix/1-stray', { local: false })] }),
        ]),
        step: { action: 'resume', ticket: 1, branch: head(1), pr: { number: 101 } },
      },
      {
        name: 'a closed unmerged PR on the existing branch → branch-mismatch, never a second PR on that head',
        facts: facts([child(1, { prs: [pr(1, { state: 'CLOSED' })], branches: [branch(head(1))] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'a closed unmerged PR on the head a start would create → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1, { state: 'CLOSED', head: branchFor(child(1)) })] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'a closed PR on another head does not block the start',
        facts: facts([child(1, { prs: [pr(1, { state: 'CLOSED', head: 'feat/1-abandoned' })] })]),
        step: { action: 'start', ticket: 1, branch: branchFor(child(1)) },
      },
      {
        name: 'an open PR whose head is on no branch → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1)] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'the branch checked out in another worktree → branch-mismatch',
        facts: facts([child(1, { branches: [branch(head(1), { elsewhere: '/wt/other' })] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'a foreign commit on the branch → foreign-commit',
        facts: facts([child(1, { prs: [pr(1)], branches: [branch(head(1), { foreign: sha('9') })] })]),
        step: { action: 'stop', ticket: 1, stop: 'foreign-commit' },
      },
      {
        name: 'an open PR whose head is not the origin tip the guard checked → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1, { headSha: sha('f') })], branches: [branch(head(1))] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'an open PR on a branch never pushed → branch-mismatch',
        facts: facts([child(1, { prs: [pr(1)], branches: [branch(head(1), { remoteTip: null })] })]),
        step: { action: 'stop', ticket: 1, stop: 'branch-mismatch' },
      },
      {
        name: 'a local branch ahead of origin without a PR is resumed',
        facts: facts([child(1, { branches: [branch(head(1), { tip: sha('c'), remoteTip: sha('a') })] })]),
        step: { action: 'resume', ticket: 1, branch: head(1), pr: null },
      },
      {
        name: 'an incomplete shared UW observation → no-scope',
        facts: facts([child(1, { ownUw: refusedOwnUw('incomplete') })]),
        step: { action: 'stop', ticket: 1, stop: 'no-scope' },
      },
      {
        name: 'a changed child commitment → no-scope',
        facts: facts([child(1, { ownUw: refusedOwnUw('changed-child', 'material-change-pending') })]),
        step: { action: 'stop', ticket: 1, stop: 'no-scope' },
      },
    ])('$name', decides)
  })
})
