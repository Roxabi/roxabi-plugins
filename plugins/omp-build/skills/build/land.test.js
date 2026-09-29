import { describe, expect, it } from 'vitest'
import {
  applyCiWatchExit,
  disarmReviewedBeforePush,
  evaluateRequiredRollup,
  landPr,
  parseLanding,
  parseRequiredContexts,
} from './workflow.js'

describe('parseRequiredContexts', () => {
  it('parses classic contexts and checks', () => {
    const json = JSON.stringify({
      contexts: ['ci', 'lint'],
      checks: [{ context: 'trufflehog' }],
    })
    expect([...parseRequiredContexts(json)].sort()).toEqual(['ci', 'lint', 'trufflehog'])
  })

  it('parses ruleset required_status_checks rules', () => {
    const json = JSON.stringify([
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'ci' }, { context: 'Review' }] },
      },
    ])
    expect([...parseRequiredContexts(json)].sort()).toEqual(['Review', 'ci'])
  })

  it('returns empty set on invalid json', () => {
    expect(parseRequiredContexts('not-json').size).toBe(0)
  })
})

describe('evaluateRequiredRollup', () => {
  it('empty required → no-required-checks', () => {
    expect(evaluateRequiredRollup([], [])).toEqual({ ready: false, status: 'no-required-checks' })
  })

  it('all required SUCCESS → ok', () => {
    const checks = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    expect(evaluateRequiredRollup(checks, ['ci'])).toEqual({ ready: true, status: 'ok' })
  })
})

function mockLand({
  rollupSequence = [],
  mergeThrows = null,
  disableThrows = null,
  timeout = 60_000,
  states = ['OPEN'],
} = {}) {
  let t = 0
  const calls = []
  let poll = 0
  let statePoll = 0
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.includes('state')) {
      const state = states[Math.min(statePoll, states.length - 1)] ?? 'OPEN'
      statePoll++
      return JSON.stringify({ state })
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const entry = rollupSequence[Math.min(poll, rollupSequence.length - 1)]
      poll++
      return JSON.stringify(entry)
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
      if (disableThrows) throw new Error(disableThrows)
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeThrows) throw new Error(mergeThrows)
      return ''
    }
    return ''
  }
  return {
    gh,
    calls,
    land: (requiredContexts, pr = 1) =>
      landPr('/tmp/wt', pr, {
        requiredContexts,
        gh,
        now: () => t,
        sleep: (ms) => {
          t += ms
        },
        timeout,
      }),
  }
}

function labeled(calls) {
  return calls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--add-label') && a.includes('reviewed'))
}

const call = (calls, predicate) => calls.findIndex(predicate)
const removesLabel = (a) => a[1] === 'edit' && a.includes('--remove-label') && a.includes('reviewed')
const disablesAuto = (a) => a[1] === 'merge' && a.includes('--disable-auto')

describe('parseLanding', () => {
  it('absent mode with the workflow file is merge-on-green', () => {
    expect(parseLanding('runtime: bun\n', { mergeOnGreenWorkflow: true }).mode).toBe('merge-on-green')
  })

  it('absent mode without the workflow file stays native', () => {
    expect(parseLanding('runtime: bun\n').mode).toBe('native')
  })
})

describe('landPr', () => {
  it('native required=[] → no-required-checks, never labels', async () => {
    const { calls, land } = mockLand()
    const result = await land([])
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(labeled(calls)).toBe(false)
  })

  it('merge-on-green with declared checks never returns no-required-checks', async () => {
    const { calls, gh } = mockLand()
    const result = await landPr('/tmp/wt', 7, {
      gh,
      requiredContexts: [],
      landing: { mode: 'merge-on-green', required_checks: ['ci'] },
    })
    expect(result.status).toBe('watching')
    expect(result.mode).toBe('merge-on-green')
    expect(result.watch).toContain('--merge-mode merge-on-green')
    expect(labeled(calls)).toBe(true)
    expect(calls.some((a) => a.includes('--auto'))).toBe(false)
  })

  it('native arms the label and auto-merge, then hands off the watch', async () => {
    const { calls, gh } = mockLand()
    const result = await landPr('/tmp/wt', 7, {
      gh,
      landing: { mode: 'native', required_checks: ['ci'] },
    })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(labeled(calls)).toBe(true)
    expect(calls.some((a) => a[1] === 'merge' && a.includes('--auto'))).toBe(true)
  })

  it('native auto-merge boom returns auto-merge-failed after arming', async () => {
    const { calls, gh } = mockLand({ mergeThrows: 'boom' })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      landing: { mode: 'native', required_checks: ['ci'] },
    })
    expect(result).toEqual({ status: 'auto-merge-failed', armed: true })
    expect(labeled(calls)).toBe(true)
  })
})

describe('applyCiWatchExit', () => {
  it.each([
    [0, 'merged'],
    [4, 'stopped'],
    [5, 'timeout'],
  ])('exit %s → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'merge-on-green', gh })).toEqual({ status })
    expect(calls.some(removesLabel)).toBe(false)
  })

  it('exit 1 on merge-on-green removes reviewed and does not disable auto-merge', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'merge-on-green', gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(calls.some(removesLabel)).toBe(true)
    expect(calls.some(disablesAuto)).toBe(false)
  })

  it('exit 1 on native removes the label before disabling auto-merge', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(call(calls, disablesAuto)).toBeGreaterThan(call(calls, removesLabel))
  })

  it.each([
    [2, 'ci-cancelled'],
    [3, 'ci-blocked'],
  ])('exit %s on merge-on-green disarms reviewed only → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'merge-on-green', gh })).toEqual({
      status,
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
    ])
  })

  it.each([
    [2, 'ci-cancelled'],
    [3, 'ci-blocked'],
  ])('exit %s on native removes the label then disables auto-merge → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'native', gh })).toEqual({
      status,
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
    ])
  })

  it('an unmapped exit leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 9, { mode: 'native', gh })).toEqual({
      status: 'watch-failed',
      code: 9,
    })
    expect(calls).toEqual([])
  })

  it('a merged PR is not disarmed', async () => {
    const { gh, calls } = mockLand({ states: ['MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 3, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([['pr', 'view', '7', '--json', 'state']])
  })

  it('a merge that wins during disable-auto is merged', async () => {
    const { gh, calls } = mockLand({ disableThrows: 'already merged', states: ['OPEN', 'MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
      ['pr', 'view', '7', '--json', 'state'],
    ])
  })

  it('rethrown disable-auto failure when the PR is still open', async () => {
    const { gh } = mockLand({ disableThrows: 'nope', states: ['OPEN', 'OPEN'] })
    await expect(applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).rejects.toThrow(/nope/)
  })

  it('exit 70 leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 70, { mode: 'native', gh })).toEqual({
      status: 'watch-failed',
      code: 70,
    })
    expect(calls).toEqual([])
  })
})

describe('disarmReviewedBeforePush', () => {
  it('removes reviewed before the push that follows it', async () => {
    const { gh, calls } = mockLand()
    let removedBeforePush = false
    await disarmReviewedBeforePush('/tmp/wt', 7, {
      gh,
      push: async () => {
        removedBeforePush = calls.some(removesLabel)
      },
    })
    expect(removedBeforePush).toBe(true)
  })
})
