import { describe, expect, it } from 'vitest'
import {
  armedStoppedPrs,
  type BranchFacts,
  baseFromStack,
  branchFor,
  type CheckNode,
  type ChildFacts,
  classifyBaseCi,
  type Facts,
  formatMarker,
  type Goal,
  generateObjective,
  goalRun,
  type HookRecord,
  hasScope,
  hookStatus,
  landOutcome,
  mergedLocalBranches,
  mergedStoppedPrs,
  nextStep,
  objectiveText,
  type PrFacts,
  parseEpicReview,
  parseGoalStop,
  parsePostMerge,
  type Report,
  readMarker,
  refuseForeignCommits,
  resolveTicketBranch,
  stopClass,
  ticketOfBranch,
  ticketOfSubject,
} from './epic'

const BASE = 'main'
const RUN = 'run00001'
const EARLIER = 'run00000'
const OTHER_REPO = 'Roxabi/other'

/** A full 40-char sha made of one hex digit. */
const sha = (digit: string) => digit.repeat(40)
const head = (ticket: number) => `feat/${ticket}-child-${ticket}`

const on = (number: number, state: 'OPEN' | 'CLOSED' = 'OPEN', repo?: string): ChildFacts['blockedBy'][number] =>
  repo ? { number, state, repo } : { number, state }

/** An open, framed child with no PR, branch, blocker or stop. */
function child(number: number, over: Partial<ChildFacts> = {}): ChildFacts {
  return {
    number,
    title: `feat(epic): child ${number}`,
    state: 'OPEN',
    labels: ['size:S'],
    body: '## Acceptance criteria\n\n- [ ] it works\n',
    epicFix: false,
    blockedBy: [],
    stops: [],
    prs: [],
    branches: [],
    ...over,
  }
}

function branch(name: string, over: Partial<BranchFacts> = {}): BranchFacts {
  return { name, local: true, tip: sha('a'), remoteTip: sha('a'), foreign: null, elsewhere: null, ...over }
}

/** An open PR from the child's branch into the base. */
function pr(ticket: number, over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 100 + ticket,
    state: 'OPEN',
    base: BASE,
    head: head(ticket),
    headSha: sha('a'),
    mergedAt: null,
    mergeSha: null,
    baseSha: null,
    armed: false,
    exhausted: false,
    ...over,
  }
}

/** A PR merged at `at`: `from` is the base commit it landed on, `to` its merge commit. */
const landed = (ticket: number, at: string, from: string, to: string, over: Partial<PrFacts> = {}) =>
  pr(ticket, { state: 'MERGED', mergedAt: at, baseSha: from, mergeSha: to, ...over })

function facts(children: ChildFacts[], over: Partial<Facts> = {}): Facts {
  return {
    epic: 575,
    run: RUN,
    base: BASE,
    baseSha: sha('f'),
    tree: { clean: true, branch: null },
    baseCi: { state: 'green', failed: [], pending: [] },
    landingError: null,
    children,
    reviews: [],
    hooks: [],
    ...over,
  }
}

type Case = { name: string; facts: Facts; step: Record<string, unknown>; report?: Partial<Report> }

function decides({ facts: input, step, report }: Case) {
  const got = nextStep(input)
  expect(got).toMatchObject(step)
  if (report) expect(got.report).toMatchObject(report)
}

const T1 = '2026-09-01T10:00:00Z'
const T2 = '2026-09-02T10:00:00Z'
const T3 = '2026-09-03T10:00:00Z'

/**
 * Every child done: #1 merged last but is still open (staging-train), #2 merged
 * first and closed, #3 closed without a PR. Listed out of merge order.
 */
const DONE = [
  child(1, { prs: [landed(1, T2, sha('b'), sha('c'))] }),
  child(2, { state: 'CLOSED', prs: [landed(2, T1, sha('1'), sha('2'))] }),
  child(3, { state: 'CLOSED' }),
]
/** First merged baseSha .. last merged mergeSha, by mergedAt. */
const RANGE = `${sha('1')}..${sha('c')}`
/** The epic-fix ticket, merged after the others: it moves the range end. */
const FIX = child(4, { epicFix: true, state: 'CLOSED', prs: [landed(4, T3, sha('c'), sha('d'))] })
const FIXED = `${sha('1')}..${sha('d')}`

const review = (verdict: 'clean' | 'blocking', range: string, run = RUN) => ({ run, verdict, range })
const hook = (result: HookRecord['result'], at: string, run = RUN): HookRecord => ({ run, result, sha: at })
/** All done and the final review clean for the current range. */
const reviewed = (hooks: HookRecord[]) => facts(DONE, { reviews: [review('clean', RANGE)], hooks })

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
          child(1, { state: 'CLOSED' }),
          child(2, { blockedBy: [on(1, 'CLOSED'), on(900, 'CLOSED', OTHER_REPO)] }),
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
        facts: facts([child(1, { blockedBy: [on(42)] }), child(2, { blockedBy: [on(43, 'CLOSED')] })]),
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
        name: 'no size label → no-scope',
        facts: facts([child(1, { labels: ['type:feat'] })]),
        step: { action: 'stop', ticket: 1, stop: 'no-scope' },
      },
      {
        name: 'a needs-framing heading → no-scope',
        facts: facts([child(1, { body: '## Acceptance\n\n- [ ] x\n\n## Needs framing\n' })]),
        step: { action: 'stop', ticket: 1, stop: 'no-scope' },
      },
    ])('$name', decides)
  })

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
        facts: facts(
          [child(1, { stops: [{ run: RUN, reason: 'ci-blocked' }], branches: [branch(head(1))] }), child(2)],
          { tree: { clean: true, branch: head(1) } },
        ),
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

  describe('final epic review', () => {
    it.each<Case>([
      {
        name: 'every child closed, none merged → complete',
        facts: facts([child(1, { state: 'CLOSED' }), child(2, { state: 'CLOSED' })]),
        step: { action: 'complete' },
        report: { merged: [], closed: [1, 2] },
      },
      {
        name: 'no review → review the first base .. last merge, by mergedAt',
        facts: facts(DONE),
        step: { action: 'final-review', stage: 'review', range: RANGE },
        report: { merged: [1, 2], closed: [3] },
      },
      {
        name: 'a red base does not hold the final review',
        facts: facts(DONE, { baseCi: { state: 'red', failed: ['test'], pending: [] } }),
        step: { action: 'final-review', stage: 'review', range: RANGE },
      },
      {
        name: 'a clean review from an earlier run at the current range end → hook',
        facts: facts(DONE, { reviews: [review('clean', RANGE, EARLIER)] }),
        step: { action: 'post-merge' },
      },
      {
        name: 'a clean review whose range ends before the last merge → review again',
        facts: facts(DONE, { reviews: [review('clean', `${sha('1')}..${sha('2')}`)] }),
        step: { action: 'final-review', stage: 'review', range: RANGE },
      },
      {
        name: 'blocking and no epic-fix child → open the fix ticket',
        facts: facts(DONE, { reviews: [review('blocking', RANGE)] }),
        step: { action: 'final-review', stage: 'fix-ticket', range: RANGE },
      },
      {
        name: 'the latest verdict for the range end wins',
        facts: facts(DONE, { reviews: [review('clean', RANGE, EARLIER), review('blocking', RANGE)] }),
        step: { action: 'final-review', stage: 'fix-ticket' },
      },
      {
        name: 'blocking with the fix round spent (fix closed unmerged) → drop final-review-blocking',
        facts: facts([...DONE, child(4, { epicFix: true, state: 'CLOSED' })], {
          reviews: [review('blocking', RANGE)],
        }),
        step: { action: 'drop', stop: 'final-review-blocking' },
      },
      {
        name: 'blocking on an older range end after the fix merged → review again',
        facts: facts([...DONE, FIX], { reviews: [review('blocking', RANGE)] }),
        step: { action: 'final-review', stage: 'review', range: FIXED },
      },
      {
        name: 'still blocking after the fix merged → drop final-review-blocking',
        facts: facts([...DONE, FIX], {
          reviews: [review('blocking', RANGE, EARLIER), review('blocking', FIXED)],
        }),
        step: { action: 'drop', stop: 'final-review-blocking' },
      },
      {
        name: 'clean after the fix merged → hook',
        facts: facts([...DONE, FIX], { reviews: [review('blocking', RANGE), review('clean', FIXED)] }),
        step: { action: 'post-merge' },
      },
      {
        name: 'the first merged PR without a merge base → drop driver-error',
        facts: facts([
          child(1, { state: 'CLOSED', prs: [landed(1, T1, sha('1'), sha('2'), { baseSha: null })] }),
          child(2, { state: 'CLOSED', prs: [landed(2, T2, sha('2'), sha('3'))] }),
        ]),
        step: { action: 'drop', stop: 'driver-error' },
      },
      {
        name: 'a later merged PR without a merge base does not change the range',
        facts: facts([
          child(1, { state: 'CLOSED', prs: [landed(1, T1, sha('1'), sha('2'))] }),
          child(2, { state: 'CLOSED', prs: [landed(2, T2, sha('2'), sha('3'), { baseSha: null })] }),
        ]),
        step: { action: 'final-review', stage: 'review', range: `${sha('1')}..${sha('3')}` },
      },
    ])('$name', decides)
  })

  describe('post-merge hook', () => {
    it.each<Case>([
      { name: 'no record → run it', facts: reviewed([]), step: { action: 'post-merge' } },
      {
        name: 'started then ok in this run → complete',
        facts: reviewed([hook('started', sha('f')), hook('ok', sha('f'))]),
        step: { action: 'complete' },
      },
      {
        name: 'skipped in this run → complete',
        facts: reviewed([hook('skipped', sha('f'))]),
        step: { action: 'complete' },
      },
      {
        name: 'failed in this run → drop hook-failed',
        facts: reviewed([hook('started', sha('f')), hook('failed', sha('f'))]),
        step: { action: 'drop', stop: 'hook-failed' },
      },
      {
        name: 'started without a result in this run → drop hook-failed, never a second run',
        facts: reviewed([hook('started', sha('f'))]),
        step: { action: 'drop', stop: 'hook-failed' },
      },
      {
        name: 'a failure in this run is not masked by an earlier ok at the same sha',
        facts: reviewed([hook('ok', sha('f'), EARLIER), hook('started', sha('f')), hook('failed', sha('f'))]),
        step: { action: 'drop', stop: 'hook-failed' },
      },
      {
        name: 'ok in an earlier run at the same base sha → complete',
        facts: reviewed([hook('ok', sha('f'), EARLIER)]),
        step: { action: 'complete' },
      },
      {
        name: 'skipped in an earlier run at the same base sha → complete',
        facts: reviewed([hook('skipped', sha('f'), EARLIER)]),
        step: { action: 'complete' },
      },
      {
        name: 'ok in an earlier run at another base sha → run it',
        facts: reviewed([hook('ok', sha('e'), EARLIER)]),
        step: { action: 'post-merge' },
      },
      {
        name: 'failed in an earlier run → run it again',
        facts: reviewed([hook('failed', sha('f'), EARLIER)]),
        step: { action: 'post-merge' },
      },
    ])('$name', decides)
  })
})

describe('mergedLocalBranches', () => {
  it('deletes only a local branch whose tip is exactly what merged into the base, checked out nowhere else', () => {
    const merged = (ticket: number, over: Partial<PrFacts> = {}) => [landed(ticket, T1, sha('1'), sha('2'), over)]
    const input = facts([
      child(1, { prs: merged(1), branches: [branch(head(1)), branch(head(1), { local: false })] }),
      child(2, { prs: merged(2), branches: [branch(head(2), { tip: sha('e') })] }),
      child(3, { prs: merged(3), branches: [branch(head(3), { elsewhere: '/wt/other' })] }),
      child(4, { prs: merged(4, { base: 'staging' }), branches: [branch(head(4))] }),
      child(5, { prs: [pr(5)], branches: [branch(head(5))] }),
    ])
    expect(mergedLocalBranches(input)).toEqual([{ ticket: 1, branch: head(1) }])
  })
})

describe('generateObjective', () => {
  const generate = (children: ChildFacts[], base = BASE) => generateObjective({ epic: 575, run: RUN, base, children })

  it('drops closed and merged children from the order and treats them as satisfied blockers', () => {
    const result = generate([
      child(1, { state: 'CLOSED' }),
      child(2, { prs: [landed(2, T1, sha('1'), sha('2'))] }),
      child(3, { blockedBy: [on(1, 'CLOSED'), on(2)] }),
      child(4, { blockedBy: [on(3)] }),
    ])
    expect(result).toMatchObject({ order: [3, 4], blocked: [] })
  })

  it('orders by blocked_by, not by number', () => {
    const result = generate([child(1, { blockedBy: [on(3)] }), child(3), child(2, { blockedBy: [on(1)] })])
    expect(result).toMatchObject({ order: [3, 1, 2], blocked: [] })
  })

  it('reports an open out-of-epic blocker and its dependents as blocked, not as a cycle', () => {
    const result = generate([
      child(1, { blockedBy: [on(900, 'OPEN', OTHER_REPO)] }),
      child(2, { blockedBy: [on(1)] }),
      child(3, { blockedBy: [on(42)] }),
      child(4, { blockedBy: [on(43, 'CLOSED')] }),
    ])
    expect(result).toMatchObject({
      order: [4],
      blocked: [
        { ticket: 1, blockers: [900] },
        { ticket: 2, blockers: [1] },
        { ticket: 3, blockers: [42] },
      ],
    })
  })

  it('reserves cycle for a real cycle among open children', () => {
    const result = generate([child(1, { blockedBy: [on(2)] }), child(2, { blockedBy: [on(1)] }), child(3)])
    expect(result).toEqual({ error: 'cycle: 1, 2' })
  })

  it('refuses when an open child lacks scope, naming only those', () => {
    expect(
      generate([child(1), child(2, { labels: [] }), child(3, { body: '## Acceptance\n## Needs framing\n' })]),
    ).toEqual({ error: 'missing scope: 2, 3', missing: [2, 3] })
  })

  it('ignores a closed child without scope', () => {
    expect(generate([child(1, { state: 'CLOSED', labels: [], body: '' }), child(2)])).toMatchObject({ order: [2] })
  })

  it('ignores a merged child still open under staging-train, and names only the unframed one', () => {
    const merged = child(4, { labels: [], body: '', prs: [landed(4, T1, sha('1'), sha('2'))] })
    expect(generate([merged, child(5, { labels: [] })])).toEqual({ error: 'missing scope: 5', missing: [5] })
  })

  it('refuses a run id the gate would not accept', () => {
    expect(generateObjective({ epic: 575, run: 'RUN00001', base: BASE, children: [child(1)] })).toHaveProperty('error')
  })

  it.each(['main', 'staging'])('names the epic, run and base %s, and passes its own gate', (base) => {
    const result = generate([child(1)], base)
    if (!('objective' in result)) throw new Error(`expected an objective, got ${result.error}`)
    expect(result.objective).toContain('/feature #575')
    expect(result.objective).toContain(`run=${RUN}`)
    expect(result.objective).toContain(`base=${base}`)
    expect(goalRun({ status: 'active', objective: result.objective }, 575)).toEqual({ run: RUN, base })
    expect(goalRun({ status: 'active', objective: result.objective }, 576)).toBeNull()
  })
})

describe('goalRun', () => {
  const objective = objectiveText(575, RUN, BASE)
  const active = (text: string | null): Goal => ({ status: 'active', objective: text })

  it.each<[string, Goal, { run: string; base: string } | null]>([
    ['no goal', null, null],
    ['no goal (undefined)', undefined, null],
    ['paused', { status: 'paused', objective }, null],
    ['budget-limited', { status: 'budget-limited', objective }, null],
    ['dropped', { status: 'dropped', objective }, null],
    ['complete', { status: 'complete', objective }, null],
    ['active, no objective', active(null), null],
    ['active, another epic', active(objectiveText(576, RUN, BASE)), null],
    ['active, an epic number with this one as prefix', active(objectiveText(5750, RUN, BASE)), null],
    ['active, two epics', active(`${objective} Then /feature #576.`), null],
    ['active, no run=', active('/feature #575 base=main'), null],
    ['active, two run=', active(`/feature #575 run=${RUN} run=run00002 base=main`), null],
    ['active, run with uppercase', active('/feature #575 run=RUN00001 base=main'), null],
    ['active, run too short', active('/feature #575 run=run0001 base=main'), null],
    ['active, run with punctuation', active('/feature #575 run=run0000! base=main'), null],
    ['active, no base=', active(`/feature #575 run=${RUN}`), null],
    ['active, base with ..', active(`/feature #575 run=${RUN} base=main..x`), null],
    ['active, two base=', active(`/feature #575 run=${RUN} base=main base=staging`), null],
    ['active, base with ~ (a revision, not a branch)', active(`/feature #575 run=${RUN} base=main~1`), null],
    ['active, base with ^', active(`/feature #575 run=${RUN} base=main^`), null],
    ['active, base with @{', active(`/feature #575 run=${RUN} base=main@{1}`), null],
    ['active, base with :', active(`/feature #575 run=${RUN} base=main:x`), null],
    ['active, generated objective', active(objective), { run: RUN, base: BASE }],
    [
      'active, hand-written objective',
      active(`/feature #575 (run=${RUN} base=staging)`),
      { run: RUN, base: 'staging' },
    ],
  ])('%s', (_name, goal, expected) => {
    expect(goalRun(goal, 575)).toEqual(expected)
  })
})

describe('hasScope', () => {
  it.each<[string, string[], string, boolean]>([
    ['size label and acceptance heading', ['size:S'], '## Acceptance\n- [ ] x', true],
    ['a criteria heading', ['size:M'], '### Success criteria\n', true],
    ['no size label', ['type:feat'], '## Acceptance\n', false],
    ['acceptance only in prose', ['size:S'], 'Acceptance: it works\n', false],
    ['#Acceptance without a space is no heading', ['size:S'], '#Acceptance\n', false],
    [
      'a needs-framing heading after the acceptance one',
      ['size:S'],
      '## Acceptance\n\n#### Needs Framing — why\n',
      false,
    ],
    ['needs framing only in prose', ['size:S'], '## Acceptance\nThis needs framing later.\n', true],
    ['a needs-framing heading inside a fence', ['size:S'], '## Acceptance\n```md\n## Needs framing\n```\n', true],
    ['a needs-framing heading inside a tilde fence', ['size:S'], '~~~\n## Needs framing\n~~~\n## Acceptance\n', true],
    ['an acceptance heading only inside a fence', ['size:S'], '```\n## Acceptance\n```\n', false],
    ['a needs-framing heading indented one space', ['size:S'], '## Acceptance\n ## Needs framing\n', false],
    ['a needs-framing heading indented three spaces', ['size:S'], '## Acceptance\n   ## Needs framing\n', false],
    ['an acceptance heading indented three spaces', ['size:S'], '   ## Acceptance\n', true],
    ['an acceptance line indented four spaces is code', ['size:S'], '    ## Acceptance\n', false],
    ['a needs-framing line indented four spaces is code', ['size:S'], '## Acceptance\n    ## Needs framing\n', true],
  ])('%s', (_name, labels, body, expected) => {
    expect(hasScope({ labels, body })).toBe(expected)
  })
})

describe('branch claims', () => {
  it.each<[string | null, number | null]>([
    ['feat/577-issue-triage', 577],
    ['fix/577', 577],
    ['feat/5770-x', 5770],
    ['feat/577x', null],
    ['feat/foo/577-x', null],
    ['577-x', null],
    ['main', null],
    ['', null],
    [null, null],
  ])('ticketOfBranch(%j) → %j', (name, expected) => {
    expect(ticketOfBranch(name)).toBe(expected)
  })

  it.each<[string, { ticket: number } | { error: string }]>([
    ['feat/577-issue-triage', { ticket: 577 }],
    ['feat/5770-x', { error: 'foreign ticket' }],
    ['feat/999-other', { error: 'foreign ticket' }],
    ['feat/foo/577-x', { error: 'no ticket' }],
    ['main', { error: 'no ticket' }],
  ])('resolveTicketBranch(%j, [577, 578])', (name, expected) => {
    expect(resolveTicketBranch(name, [577, 578])).toEqual(expected)
  })
})

describe('branchFor', () => {
  it.each<[string, string[], string]>([
    ['fix(driver): Handle résumé edge', [], 'fix/5-handle-resume-edge'],
    ['docs: Explain goal runs', ['bug'], 'docs/5-explain-goal-runs'],
    ['Add the epic driver', ['bug'], 'fix/5-add-the-epic-driver'],
    ['Add the epic driver', [], 'feat/5-add-the-epic-driver'],
    ['wip: something odd', [], 'feat/5-something-odd'],
    ['feat!: one two three four five six seven eight', [], 'feat/5-one-two-three-four-five-six'],
    ['🚀 !!!', [], 'feat/5'],
  ])('%j %j → %s, which claims the child', (title, labels, expected) => {
    const name = branchFor({ number: 5, title, labels })
    expect(name).toBe(expected)
    expect(resolveTicketBranch(name, [5])).toEqual({ ticket: 5 })
  })
})

describe('commit claims', () => {
  it.each<[string, number | null]>([
    ['feat(epic): add the driver (#620)', 620],
    ['Revert "feat(epic): add the driver (#620)"', 620],
    ['wip: goal-stop timeout (#620)  ', 620],
    ['fix: thing (#620) and more', null],
    ['fix: thing #620', null],
    ['Merge pull request #12 from acme/feat/620-x', null],
  ])('ticketOfSubject(%j) → %j', (subject, expected) => {
    expect(ticketOfSubject(subject)).toBe(expected)
  })

  it.each<[string, string[], { ok: true } | { error: string }]>([
    ['no commit', [], { ok: true }],
    ['every commit claims the ticket', ['feat: a (#620)', 'Revert "feat: a (#620)"'], { ok: true }],
    [
      'a commit claims another ticket',
      ['feat: a (#620)', 'feat: b (#621)', 'feat: c (#9)'],
      { error: 'foreign commit c1' },
    ],
    ['a commit claims nothing', ['feat: a (#620)', 'wip'], { error: 'foreign commit c1' }],
  ])('refuseForeignCommits: %s', (_name, subjects, expected) => {
    const commits = subjects.map((subject, index) => ({ sha: `c${index}`, ticket: ticketOfSubject(subject) }))
    expect(refuseForeignCommits(commits, 620)).toEqual(expected)
  })
})

describe('stop classes', () => {
  it.each<[string, string, 'ticket' | 'shared' | 'no-progress' | null]>([
    ['review loop stop', 'review-bound', 'ticket'],
    ['proof BLOCKED', 'proof-blocked', 'ticket'],
    ['§6.0 foreign commit', 'foreign-commit', 'ticket'],
    ['§6.0 branch mismatch', 'branch-mismatch', 'ticket'],
    ['child without scope', 'no-scope', 'ticket'],
    ['watch timeout', 'timeout', 'ticket'],
    ['ci-cancelled', 'ci-cancelled', 'ticket'],
    ['ci-blocked', 'ci-blocked', 'ticket'],
    ['stopped', 'stopped', 'ticket'],
    ['closed', 'closed', 'ticket'],
    ['base CI red', 'base-ci-red', 'shared'],
    ['dirty tree between tickets', 'dirty-tree', 'shared'],
    ['watch-failed', 'watch-failed', 'shared'],
    ['bad-landing', 'bad-landing', 'shared'],
    ['no-required-checks', 'no-required-checks', 'shared'],
    ['evaluate-only', 'evaluate-only', 'shared'],
    ['auto-merge-failed', 'auto-merge-failed', 'shared'],
    ['tracker CLI unresolvable', 'tracker-unresolvable', 'shared'],
    ['post-merge hook failure', 'hook-failed', 'shared'],
    ['final review blocking after its fix round', 'final-review-blocking', 'shared'],
    ['frontier empty while children remain open', 'no-progress', 'no-progress'],
    ['an unknown reason', 'banana', null],
  ])('%s (%s) → %s', (_trigger, reason, expected) => {
    expect(stopClass(reason)).toBe(expected)
  })

  it.each<[string, Record<string, unknown>]>([
    ['watching', { next: 'watch' }],
    ['merged', { next: 'confirm' }],
    ['ci-failed', { next: 'reopen' }],
    ['timeout', { stop: 'timeout', class: 'ticket' }],
    ['ci-cancelled', { stop: 'ci-cancelled', class: 'ticket' }],
    ['ci-blocked', { stop: 'ci-blocked', class: 'ticket' }],
    ['stopped', { stop: 'stopped', class: 'ticket' }],
    ['closed', { stop: 'closed', class: 'ticket' }],
    ['review-stopped', { stop: 'review-bound', class: 'ticket' }],
    ['watch-failed', { stop: 'watch-failed', class: 'shared' }],
    ['bad-landing', { stop: 'bad-landing', class: 'shared' }],
    ['no-required-checks', { stop: 'no-required-checks', class: 'shared' }],
    ['evaluate-only', { stop: 'evaluate-only', class: 'shared' }],
    ['auto-merge-failed', { stop: 'auto-merge-failed', class: 'shared' }],
    ['something-new', { stop: 'unknown-land-status', class: 'shared' }],
  ])('landOutcome(%s)', (status, expected) => {
    const outcome = landOutcome(status)
    expect(outcome).toEqual(expected)
    // The stop it names is recorded and classified by the same table.
    if ('stop' in outcome) expect(stopClass(outcome.stop)).toBe(outcome.class)
  })
})

describe('markers', () => {
  it('round-trips each marker with readable text below it', () => {
    const range = `${sha('1')}..${sha('2')}`
    expect(parseGoalStop(`${formatMarker('goal-stop', { run: RUN, reason: 'timeout' })}\n\nStopped: timeout.`)).toEqual(
      { run: RUN, reason: 'timeout' },
    )
    expect(parseEpicReview(`${formatMarker('epic-review', { run: RUN, verdict: 'clean', range })}\nClean.`)).toEqual({
      run: RUN,
      verdict: 'clean',
      range,
    })
    expect(parsePostMerge(`${formatMarker('post-merge', { run: RUN, result: 'ok', sha: sha('f') })}\nok`)).toEqual({
      run: RUN,
      result: 'ok',
      sha: sha('f'),
    })
    expect(readMarker(`${formatMarker('epic-fix')}\n\n## Acceptance`, 'epic-fix')).toEqual({})
  })

  it.each([
    ['a space', 'two words'],
    ['a comment close', 'x-->'],
    ['a newline', 'a\nb'],
    ['nothing', ''],
  ])('refuses to format a field value with %s', (_name, value) => {
    expect(() => formatMarker('goal-stop', { run: RUN, reason: value })).toThrow()
  })

  it('reads only the first line, so a quoted marker is not a marker', () => {
    const stop = formatMarker('goal-stop', { run: RUN, reason: 'timeout' })
    expect(parseGoalStop(`Stopped #5.\n${stop}`)).toBeNull()
    const report = `${formatMarker('goal-report', { run: RUN })}\n\nStopped:\n${stop}`
    expect(parseGoalStop(report)).toBeNull()
    expect(readMarker(report, 'goal-report')).toEqual({ run: RUN })
    expect(parseGoalStop(`> ${stop}`)).toBeNull()
    expect(parseGoalStop(`  ${stop}  \nbody`)).toEqual({ run: RUN, reason: 'timeout' })
  })

  it.each([
    ['goal-stop, run with uppercase', () => parseGoalStop('<!-- omp-build:goal-stop run=RUN00001 reason=timeout -->')],
    ['goal-stop, run too short', () => parseGoalStop('<!-- omp-build:goal-stop run=run0001 reason=timeout -->')],
    ['goal-stop, no reason', () => parseGoalStop(`<!-- omp-build:goal-stop run=${RUN} -->`)],
    ['goal-stop, another kind', () => parseGoalStop(`<!-- omp-build:post-merge run=${RUN} reason=timeout -->`)],
    [
      'epic-review, bad verdict',
      () => parseEpicReview(`<!-- omp-build:epic-review run=${RUN} verdict=green range=${sha('1')}..${sha('2')} -->`),
    ],
    [
      'epic-review, short sha',
      () => parseEpicReview(`<!-- omp-build:epic-review run=${RUN} verdict=clean range=abc1234..${sha('2')} -->`),
    ],
    [
      'epic-review, uppercase sha',
      () =>
        parseEpicReview(`<!-- omp-build:epic-review run=${RUN} verdict=clean range=${'A'.repeat(40)}..${sha('2')} -->`),
    ],
    ['epic-review, no range', () => parseEpicReview(`<!-- omp-build:epic-review run=${RUN} verdict=clean -->`)],
    [
      'epic-review, a range with three ends',
      () =>
        parseEpicReview(
          `<!-- omp-build:epic-review run=${RUN} verdict=clean range=${sha('1')}..${sha('2')}..${sha('3')} -->`,
        ),
    ],
    [
      'epic-review, bad run',
      () => parseEpicReview(`<!-- omp-build:epic-review run=r1 verdict=clean range=${sha('1')}..${sha('2')} -->`),
    ],
    ['post-merge, short sha', () => parsePostMerge(`<!-- omp-build:post-merge run=${RUN} result=ok sha=abc1234 -->`)],
    ['post-merge, no sha', () => parsePostMerge(`<!-- omp-build:post-merge run=${RUN} result=ok -->`)],
    [
      'post-merge, unknown result',
      () => parsePostMerge(`<!-- omp-build:post-merge run=${RUN} result=done sha=${sha('f')} -->`),
    ],
    [
      'post-merge, bad run',
      () => parsePostMerge(`<!-- omp-build:post-merge run=run_0001 result=ok sha=${sha('f')} -->`),
    ],
  ])('rejects %s', (_name, parse) => {
    expect(parse()).toBeNull()
  })
})

describe('baseFromStack', () => {
  const main = () => 'main'
  it.each<[string, unknown, { base: string } | { error: string }]>([
    ['trunk → the default branch', { release: { model: 'trunk' } }, { base: 'main' }],
    [
      'staging-train → staging, whatever the default branch',
      { release: { model: 'staging-train' } },
      { base: 'staging' },
    ],
    ['an unknown model is refused', { release: { model: 'promote' } }, { error: expect.stringContaining('promote') }],
    ['no release.model is refused', { release: {} }, { error: expect.stringContaining('undefined') }],
    ['release not a map is refused', { release: 'trunk' }, { error: expect.any(String) }],
    ['an empty document is refused', null, { error: expect.any(String) }],
  ])('%s', (_name, doc, expected) => {
    expect(baseFromStack(doc, main)).toEqual(expected)
  })

  it('asks for the default branch only under trunk', () => {
    let asked = 0
    const count = () => {
      asked++
      return 'main'
    }
    baseFromStack({ release: { model: 'staging-train' } }, count)
    expect(asked).toBe(0)
    baseFromStack({ release: { model: 'trunk' } }, count)
    expect(asked).toBe(1)
  })

  it.each(['main~1', '', 'a..b'])('refuses a default branch git would misread (%j)', (answer) => {
    expect(baseFromStack({ release: { model: 'trunk' } }, () => answer)).toMatchObject({ error: expect.any(String) })
  })
})

describe('classifyBaseCi', () => {
  const run = (name: string, conclusion: string | null, started: string, workflow = 'CI'): CheckNode => ({
    __typename: 'CheckRun',
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    startedAt: started,
    checkSuite: { workflowRun: { workflow: { name: workflow } } },
  })
  const status = (context: string, state: string): CheckNode => ({ __typename: 'StatusContext', context, state })

  it.each<[string, CheckNode[], string[], string, string[], string[]]>([
    ['no check → none', [], [], 'none', [], []],
    [
      'every check passing, skipped or neutral → green',
      [run('a', 'SUCCESS', '1'), run('b', 'SKIPPED', '1'), run('c', 'NEUTRAL', '1')],
      [],
      'green',
      [],
      [],
    ],
    ['a completed failure → red', [run('a', 'FAILURE', '1')], [], 'red', ['a'], []],
    [
      'timed_out and startup_failure are red',
      [run('a', 'TIMED_OUT', '1'), run('b', 'STARTUP_FAILURE', '1')],
      [],
      'red',
      ['a', 'b'],
      [],
    ],
    [
      'a green re-run outranks a stale failure',
      [run('a', 'FAILURE', '1'), run('a', 'SUCCESS', '2')],
      [],
      'green',
      [],
      [],
    ],
    [
      'a pending re-run outranks a completed failure, reported by name',
      [run('a', 'FAILURE', '2'), run('a', null, '1')],
      [],
      'pending',
      [],
      ['a'],
    ],
    [
      'cancelled is reported pending with its conclusion, never red',
      [run('a', 'CANCELLED', '1')],
      [],
      'pending',
      [],
      ['a=cancelled'],
    ],
    ['a status context in error is red', [status('ci/legacy', 'ERROR')], [], 'red', ['ci/legacy'], []],
    ['a pending status context is pending', [status('ci/legacy', 'PENDING')], [], 'pending', [], ['ci/legacy']],
    [
      'a red check outside the declared set is ignored',
      [run('lint', 'FAILURE', '1'), run('test', 'SUCCESS', '1')],
      ['test'],
      'green',
      [],
      [],
    ],
    [
      'a pending check outside the declared set is not reported',
      [run('lint', null, '1'), run('test', 'SUCCESS', '1')],
      ['test'],
      'green',
      [],
      [],
    ],
    ['a declared check that never ran → none', [run('lint', 'SUCCESS', '1')], ['test'], 'none', [], []],
    [
      'the same name in two workflows is two checks',
      [run('build', 'SUCCESS', '1'), run('build', 'FAILURE', '1', 'Release')],
      [],
      'red',
      ['build'],
      [],
    ],
  ])('%s', (_name, nodes, required, state, failed, pending) => {
    const ci = classifyBaseCi(nodes, required)
    expect(ci.state).toBe(state)
    expect(ci.failed).toEqual(failed)
    expect(ci.pending).toEqual(pending)
  })
})

describe('hookStatus', () => {
  const at = sha('f')
  const record = (run: string, result: HookRecord['result'], on = at): HookRecord => ({ run, result, sha: on })
  it.each<[string, HookRecord[], 'done' | 'failed' | 'pending', HookRecord | null]>([
    ['no record → pending', [], 'pending', null],
    ['this run ok → done, with that record', [record(RUN, 'started'), record(RUN, 'ok')], 'done', record(RUN, 'ok')],
    ['this run skipped → done', [record(RUN, 'skipped')], 'done', record(RUN, 'skipped')],
    ['this run failed → failed', [record(RUN, 'started'), record(RUN, 'failed')], 'failed', record(RUN, 'failed')],
    [
      'this run started with no result → failed, never run twice',
      [record(RUN, 'started')],
      'failed',
      record(RUN, 'started'),
    ],
    [
      'an earlier run ok at the same base → done, with that record',
      [record(EARLIER, 'ok')],
      'done',
      record(EARLIER, 'ok'),
    ],
    ['an earlier run ok at another base → pending', [record(EARLIER, 'ok', sha('e'))], 'pending', null],
    ['an earlier run failed → pending (a new run retries it)', [record(EARLIER, 'failed')], 'pending', null],
  ])('%s', (_name, hooks, state, shown) => {
    const status = hookStatus({ run: RUN, baseSha: at, hooks })
    expect(status.state).toBe(state)
    expect(status.record).toEqual(shown)
  })
})

describe('armedStoppedPrs', () => {
  it('lists only open armed PRs of children stopped this run or by a sticky marker', () => {
    const listed = armedStoppedPrs(
      facts([
        child(2, { stops: [{ run: EARLIER, reason: 'review-bound' }], prs: [pr(2, { number: 10, armed: true })] }),
        child(3, {
          stops: [{ run: RUN, reason: 'timeout' }],
          prs: [pr(3, { number: 12, armed: true, state: 'CLOSED' })],
        }),
        child(4, { prs: [pr(4, { number: 14, armed: true })] }),
        child(5, { stops: [{ run: RUN, reason: 'timeout' }], prs: [pr(5, { number: 15, armed: false })] }),
        child(6, { stops: [{ run: EARLIER, reason: 'timeout' }], prs: [pr(6, { number: 16, armed: true })] }),
        child(7, { stops: [{ run: RUN, reason: 'proof-blocked' }], prs: [pr(7, { number: 17, armed: true })] }),
      ]),
    )
    expect(listed).toEqual([
      { ticket: 2, pr: 10 },
      { ticket: 7, pr: 17 },
    ])
  })
})

describe('mergedStoppedPrs', () => {
  it('lists a stopped child PR that is MERGED onto this base even when mergeSha is null', () => {
    const listed = mergedStoppedPrs(
      facts([
        child(2, {
          stops: [{ run: EARLIER, reason: 'review-bound' }],
          prs: [pr(2, { number: 10, state: 'MERGED', mergeSha: null })],
        }),
        child(3, {
          stops: [{ run: EARLIER, reason: 'review-bound' }],
          prs: [pr(3, { number: 12, state: 'MERGED', base: 'other', mergeSha: null })],
        }),
        child(4, { prs: [pr(4, { number: 14, state: 'MERGED', mergeSha: null })] }),
      ]),
    )
    expect(listed).toEqual([{ ticket: 2, pr: 10 }])
  })
})
