import { describe, it } from 'vitest'
import {
  type Case,
  child,
  DONE,
  decides,
  EARLIER,
  FIX,
  FIXED,
  facts,
  hook,
  landed,
  RANGE,
  review,
  reviewed,
  sha,
  T1,
  T2,
} from './epic-transition.fixture'

describe('nextStep finalization', () => {
  describe('final epic review', () => {
    it.each<Case>([
      {
        name: 'every child closed, none merged → complete',
        facts: facts([child(1, { state: 'CLOSED' }), child(2, { state: 'CLOSED' })]),
        step: { action: 'complete' },
        report: { merged: [], closed: [1, 2] },
      },
      {
        name: 'every child closed, none merged, red base → drop base-ci-red',
        facts: facts([child(1, { state: 'CLOSED' }), child(2, { state: 'CLOSED' })], {
          baseCi: { state: 'red', failed: ['test'], pending: [] },
        }),
        step: { action: 'drop', stop: 'base-ci-red' },
      },
      {
        name: 'every child closed, none merged, pending base → drop base-ci-pending',
        facts: facts([child(1, { state: 'CLOSED' })], {
          baseCi: { state: 'pending', failed: [], pending: ['build'] },
        }),
        step: { action: 'drop', stop: 'base-ci-pending' },
      },
      {
        name: 'every child closed, none merged, dirty tree → drop dirty-tree',
        facts: facts([child(1, { state: 'CLOSED' })], { tree: { clean: false, branch: null } }),
        step: { action: 'drop', stop: 'dirty-tree' },
      },
      {
        name: 'nothing merged, this run ok at another commit → drop hook-stale, not complete',
        facts: facts([child(1, { state: 'CLOSED' })], { hooks: [hook('ok', sha('a'))] }),
        step: { action: 'drop', stop: 'hook-stale' },
      },
      {
        name: 'nothing merged, this run hook failed → drop hook-failed, not complete',
        facts: facts([child(1, { state: 'CLOSED' })], { hooks: [hook('failed', sha('f'))] }),
        step: { action: 'drop', stop: 'hook-failed' },
      },
      {
        name: 'every child closed, none merged, no base checks → complete',
        facts: facts([child(1, { state: 'CLOSED' })], { baseCi: { state: 'none', failed: [], pending: [] } }),
        step: { action: 'complete' },
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
        name: 'a pending base does not hold the final review',
        facts: facts(DONE, { baseCi: { state: 'pending', failed: [], pending: ['build'] } }),
        step: { action: 'final-review', stage: 'review', range: RANGE },
      },
      {
        name: 'a dirty tree does not hold the final review',
        facts: facts(DONE, { tree: { clean: false, branch: null } }),
        step: { action: 'final-review', stage: 'review', range: RANGE },
      },
      {
        name: 'a red base does not hold the fix ticket',
        facts: facts(DONE, {
          reviews: [review('blocking', RANGE)],
          baseCi: { state: 'red', failed: ['test'], pending: [] },
        }),
        step: { action: 'final-review', stage: 'fix-ticket', range: RANGE },
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
      {
        name: 'clean review, base CI red → drop base-ci-red, the hook does not run',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          baseCi: { state: 'red', failed: ['test'], pending: [] },
        }),
        step: { action: 'drop', stop: 'base-ci-red' },
        report: { baseCi: { state: 'red', failed: ['test'], pending: [] } },
      },
      {
        name: 'clean review, base CI pending → drop base-ci-pending',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          baseCi: { state: 'pending', failed: [], pending: ['build=cancelled'] },
        }),
        step: { action: 'drop', stop: 'base-ci-pending' },
      },
      {
        name: 'clean review, dirty tree → drop dirty-tree',
        facts: facts(DONE, { reviews: [review('clean', RANGE)], tree: { clean: false, branch: null } }),
        step: { action: 'drop', stop: 'dirty-tree' },
      },
      {
        name: 'hook already ok at the current base, then the base goes red → drop, not complete',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          hooks: [hook('ok', sha('f'))],
          baseCi: { state: 'red', failed: ['test'], pending: [] },
        }),
        step: { action: 'drop', stop: 'base-ci-red' },
      },
      {
        name: 'hook already ok at the current base, dirty tree → drop, not complete',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          hooks: [hook('ok', sha('f'))],
          tree: { clean: false, branch: null },
        }),
        step: { action: 'drop', stop: 'dirty-tree' },
      },
      {
        name: 'hook already ok at the current base, base CI pending → drop, not complete',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          hooks: [hook('ok', sha('f'))],
          baseCi: { state: 'pending', failed: [], pending: ['build'] },
        }),
        step: { action: 'drop', stop: 'base-ci-pending' },
      },
      {
        name: 'this run ok at another commit → drop hook-stale, not a re-run',
        facts: reviewed([hook('ok', sha('a'))]),
        step: { action: 'drop', stop: 'hook-stale' },
      },
      {
        name: 'this run skipped at another commit → drop hook-stale, not a re-run',
        facts: reviewed([hook('skipped', sha('a'))]),
        step: { action: 'drop', stop: 'hook-stale' },
      },
      {
        name: 'an earlier ok at the current base still completes when this run recorded ok elsewhere',
        facts: reviewed([hook('ok', sha('f'), EARLIER), hook('ok', sha('a'))]),
        step: { action: 'complete' },
      },
      {
        name: 'base CI none after a clean review still runs the hook',
        facts: facts(DONE, {
          reviews: [review('clean', RANGE)],
          baseCi: { state: 'none', failed: [], pending: [] },
        }),
        step: { action: 'post-merge' },
      },
    ])('$name', decides)
  })
})
