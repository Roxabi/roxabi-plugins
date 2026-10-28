import { describe, expect, it } from 'vitest'
import type { CheckNode } from './epic-ci'
import { baseFromStack, classifyBaseCi } from './epic-ci'
import { refuseForeignCommits, resolveTicketBranch, ticketOfBranch, ticketOfSubject } from './epic-claims'
import { hookStatus } from './epic-finalization'
import { frameEpic } from './epic-frame'
import { BASE_NAME, branchFor, RUN_ID } from './epic-naming'
import { armedStoppedPrs, mergedLocalBranches, mergedStoppedPrs } from './epic-progress'
import { landOutcome, stopClass } from './epic-stops'
import {
  BASE,
  branch,
  child,
  EARLIER,
  facts,
  head,
  landed,
  OTHER_REPO,
  on,
  pr,
  RUN,
  refusedOwnUw,
  sha,
  T1,
  T2,
} from './epic-transition.fixture'
import type { ChildFacts, HookRecord, PrFacts } from './epic-types'

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

describe('frameEpic', () => {
  const frame = (children: ChildFacts[], base = BASE) => frameEpic({ base, children })

  it('drops completed and merged children from the order, but only native completion relieves a blocker', () => {
    expect(
      frame([
        child(1, { state: 'CLOSED', stateReason: 'COMPLETED' }),
        child(2, { prs: [landed(2, T1, sha('1'), sha('2'))] }),
        child(3, { blockedBy: [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED' }, on(2)] }),
        child(4, { blockedBy: [on(3)] }),
      ]),
    ).toEqual({
      order: [],
      blocked: [
        { ticket: 3, blockers: [2] },
        { ticket: 4, blockers: [3] },
      ],
    })
  })

  it('orders by blocked_by, not by number', () => {
    expect(frame([child(1, { blockedBy: [on(3)] }), child(3), child(2, { blockedBy: [on(1)] })])).toEqual({
      order: [3, 1, 2],
      blocked: [],
    })
  })

  it('reports an open out-of-epic blocker and its dependents as blocked, not as a cycle', () => {
    expect(
      frame([
        child(1, { blockedBy: [on(900, 'OPEN', OTHER_REPO)] }),
        child(2, { blockedBy: [on(1)] }),
        child(3, { blockedBy: [on(42)] }),
        child(4, { blockedBy: [{ number: 43, state: 'CLOSED', stateReason: 'COMPLETED' }] }),
      ]),
    ).toEqual({
      order: [4],
      blocked: [
        { ticket: 1, blockers: [900] },
        { ticket: 2, blockers: [1] },
        { ticket: 3, blockers: [42] },
      ],
    })
  })

  it('reserves cycle for a real cycle among open children', () => {
    expect(frame([child(1, { blockedBy: [on(2)] }), child(2, { blockedBy: [on(1)] }), child(3)])).toEqual({
      error: 'cycle: 1, 2',
    })
  })

  it('refuses only open children whose shared UW observation is unsettled', () => {
    expect(
      frame([
        child(1),
        child(2, { ownUw: refusedOwnUw('incomplete') }),
        child(3, { ownUw: refusedOwnUw('unsettled') }),
      ]),
    ).toEqual({
      error: 'unsettled own UW: #2 (graph-incomplete), #3 (own-spec-unaccepted)',
      missing: [2, 3],
    })
  })

  it('ignores a closed child with an incomplete UW observation', () => {
    expect(frame([child(1, { state: 'CLOSED', ownUw: refusedOwnUw('incomplete') }), child(2)])).toEqual({
      order: [2],
      blocked: [],
    })
  })

  it('ignores a merged child still open under staging-train, and names only the unsettled one', () => {
    const merged = child(4, { ownUw: refusedOwnUw('incomplete'), prs: [landed(4, T1, sha('1'), sha('2'))] })
    expect(frame([merged, child(5, { ownUw: refusedOwnUw('changed-child', 'material-change-pending') })])).toEqual({
      error: 'unsettled own UW: #5 (material-change-pending)',
      missing: [5],
    })
  })
})

describe('mandate identity', () => {
  it('accepts an 8-character run id and a branch base, not a revision', () => {
    expect(RUN_ID.test(RUN)).toBe(true)
    expect(RUN_ID.test('RUN00001')).toBe(false)
    expect(RUN_ID.test('run0001')).toBe(false)
    expect(RUN_ID.test('run0000!')).toBe(false)
    expect(BASE_NAME.test('main')).toBe(true)
    expect(BASE_NAME.test('staging')).toBe(true)
    expect(BASE_NAME.test('main..x')).toBe(false)
    expect(BASE_NAME.test('main~1')).toBe(false)
    expect(BASE_NAME.test('main^')).toBe(false)
    expect(BASE_NAME.test('main@{1}')).toBe(false)
    expect(BASE_NAME.test('main:x')).toBe(false)
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
    ['review input refused at landing', 'review-input-refused', 'ticket'],
    ['base blocked at landing', 'base-blocked', 'ticket'],
    ['§6.0 foreign commit', 'foreign-commit', 'ticket'],
    ['§6.0 branch mismatch', 'branch-mismatch', 'ticket'],
    ['child without scope', 'no-scope', 'ticket'],
    ['watch timeout', 'timeout', 'ticket'],
    ['ci-cancelled', 'ci-cancelled', 'ticket'],
    ['ci-blocked', 'ci-blocked', 'ticket'],
    ['stopped', 'stopped', 'ticket'],
    ['closed', 'closed', 'ticket'],
    ['PR behind its base', 'behind', 'ticket'],
    ['base CI red', 'base-ci-red', 'shared'],
    ['dirty tree between tickets', 'dirty-tree', 'shared'],
    ['watch-failed', 'watch-failed', 'shared'],
    ['bad-landing', 'bad-landing', 'shared'],
    ['no-required-checks', 'no-required-checks', 'shared'],
    ['evaluate-only', 'evaluate-only', 'shared'],
    ['auto-merge-failed', 'auto-merge-failed', 'shared'],
    ['tracker CLI unresolvable', 'tracker-unresolvable', 'shared'],
    ['post-merge hook failure', 'hook-failed', 'shared'],
    ['base CI pending at finalization', 'base-ci-pending', 'shared'],
    ['hook recorded at another commit', 'hook-stale', 'shared'],
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
    ['review-input-refused', { stop: 'review-input-refused', class: 'ticket' }],
    ['base-blocked', { stop: 'base-blocked', class: 'ticket' }],
    ['behind', { stop: 'behind', class: 'ticket' }],
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
  it.each<[string, HookRecord[], 'done' | 'failed' | 'pending' | 'stale', HookRecord | null]>([
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
    [
      'this run ok at another base → stale, with that record',
      [record(RUN, 'ok', sha('e'))],
      'stale',
      record(RUN, 'ok', sha('e')),
    ],
    [
      'this run skipped at another base → stale',
      [record(RUN, 'skipped', sha('e'))],
      'stale',
      record(RUN, 'skipped', sha('e')),
    ],
    [
      'an earlier ok at this base is done even when this run is ok elsewhere',
      [record(EARLIER, 'ok'), record(RUN, 'ok', sha('e'))],
      'done',
      record(EARLIER, 'ok'),
    ],
    ['an earlier skipped at this base → done', [record(EARLIER, 'skipped')], 'done', record(EARLIER, 'skipped')],
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
        child(7, { stops: [{ run: RUN, reason: 'review-input-refused' }], prs: [pr(7, { number: 17, armed: true })] }),
      ]),
    )
    expect(listed).toEqual([
      { ticket: 2, pr: 10 },
      { ticket: 7, pr: 17 },
    ])
  })
})

describe('mergedStoppedPrs', () => {
  it('exempts a historical stopped delivery without mutating the input facts', () => {
    const input = facts([
      child(2, {
        stops: [{ run: EARLIER, reason: 'review-bound' }],
        prs: [landed(2, T1, sha('1'), sha('2'), { number: 10 })],
      }),
    ])
    const before = structuredClone(input)
    expect(mergedStoppedPrs(input)).toEqual([])
    expect(input).toEqual(before)
  })

  it.each([
    ['delivery first', [10, 14]],
    ['ambiguous merge first', [14, 10]],
  ])('keeps an unconfirmable same-child merge when the confirmed delivery is %s', (_name, order) => {
    const delivery = landed(2, T1, sha('1'), sha('2'), { number: 10 })
    const ambiguous = pr(2, { number: 14, state: 'MERGED', mergeSha: null })
    const prs = order.map((number) => (number === 10 ? delivery : ambiguous))
    const input = facts([child(2, { stops: [{ run: EARLIER, reason: 'review-bound' }], prs })])
    expect(mergedStoppedPrs(input)).toEqual([{ ticket: 2, pr: 14 }])
  })

  it('exempts only the canonical first delivery when a stopped child has two confirmed merges', () => {
    const input = facts([
      child(2, {
        stops: [{ run: EARLIER, reason: 'review-bound' }],
        prs: [landed(2, T1, sha('1'), sha('2'), { number: 10 }), landed(2, T2, sha('2'), sha('3'), { number: 14 })],
      }),
    ])
    expect(mergedStoppedPrs(input)).toEqual([{ ticket: 2, pr: 14 }])
  })

  it('keeps an exhausted armed PR for stopped-child disarm when another PR is confirmed delivered', () => {
    const input = facts([
      child(2, {
        stops: [{ run: EARLIER, reason: 'review-bound' }],
        prs: [landed(2, T1, sha('1'), sha('2'), { number: 10 }), pr(2, { number: 14, armed: true, exhausted: true })],
      }),
    ])
    expect(mergedStoppedPrs(input)).toEqual([])
    expect(armedStoppedPrs(input)).toEqual([{ ticket: 2, pr: 14 }])
  })

  it('does not classify a stopped child’s closed unmerged PR as a merged reconciliation problem', () => {
    const input = facts([
      child(2, {
        stops: [{ run: EARLIER, reason: 'review-bound' }],
        prs: [pr(2, { number: 10, state: 'CLOSED' })],
      }),
    ])
    expect(mergedStoppedPrs(input)).toEqual([])
  })

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
