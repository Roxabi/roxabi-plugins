import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyCiWatchExit, disarmReviewedBeforePush, landPr, parseRequiredContexts } from './workflow.js'

/** A checkout with the given files, relative path → content. */
function checkout(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'land-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

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

function mockLand({
  rollupSequence = [],
  mergeThrows = null,
  disableThrows = null,
  timeout = 60_000,
  states = ['OPEN'],
  autoMerges = [null],
} = {}) {
  let t = 0
  const calls = []
  let poll = 0
  let statePoll = 0
  const gh = async (_cwd, args) => {
    calls.push(args)
    const jsonAt = args.indexOf('--json')
    const fields = jsonAt === -1 ? [] : String(args[jsonAt + 1] ?? '').split(',')
    if (args[0] === 'pr' && args[1] === 'view' && fields.includes('state')) {
      const state = states[Math.min(statePoll, states.length - 1)] ?? 'OPEN'
      const autoMergeRequest = autoMerges[Math.min(statePoll, autoMerges.length - 1)] ?? null
      statePoll++
      return JSON.stringify({ state, autoMergeRequest })
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
      landPr(checkout(), pr, {
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

  it('an explicit native landing still asks protection and rulesets', async () => {
    const calls = []
    const gh = async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ baseRefName: 'main' })
      if (args[0] === 'api') throw new Error('HTTP 403')
      return ''
    }
    const cwd = checkout({ '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' })
    const result = await landPr(cwd, 7, { gh, landing: { mode: 'native', required_checks: [] } })
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(calls).toContainEqual(['api', 'repos/acme/app/branches/main/protection/required_status_checks'])
    expect(calls).toContainEqual(['api', 'repos/acme/app/rules/branches/main'])
    expect(labeled(calls)).toBe(false)
  })
})

describe('applyCiWatchExit', () => {
  const view = ['pr', 'view', '7', '--json', 'state,autoMergeRequest']

  it.each([
    [4, 'stopped'],
    [5, 'timeout'],
  ])('exit %s → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'merge-on-green', gh })).toEqual({ status })
    expect(calls).toEqual([])
  })

  it('exit 6 is evaluate-only and leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 6, { mode: 'merge-on-green', gh })).toEqual({
      status: 'evaluate-only',
    })
    expect(calls).toEqual([])
  })

  it('exit 0 on a merged PR is merged', async () => {
    const { gh, calls } = mockLand({ states: ['MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 0, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([view])
  })

  it('exit 0 on an unmerged PR is stopped', async () => {
    const { gh, calls } = mockLand({ states: ['OPEN'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 0, { mode: 'native', gh })).toEqual({ status: 'stopped' })
    expect(calls).toEqual([view])
  })

  it.each([1, 2, 3])('exit %s on a closed PR is stopped without disarm', async (code) => {
    const { gh, calls } = mockLand({ states: ['CLOSED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'native', gh })).toEqual({ status: 'stopped' })
    expect(calls).toEqual([view])
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
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
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
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
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
    expect(calls).toEqual([['pr', 'view', '7', '--json', 'state,autoMergeRequest']])
  })

  it('a merge that wins during disable-auto is merged', async () => {
    const { gh, calls } = mockLand({ disableThrows: 'already merged', states: ['OPEN', 'MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
    ])
  })

  it('a disable-auto error with no auto-merge is already disarmed', async () => {
    const { gh, calls } = mockLand({ disableThrows: 'already off', states: ['OPEN', 'OPEN'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 2, { mode: 'native', gh })).toEqual({
      status: 'ci-cancelled',
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
    ])
  })

  it('rethrown disable-auto failure when auto-merge is still set', async () => {
    const { gh } = mockLand({
      disableThrows: 'nope',
      states: ['OPEN', 'OPEN'],
      autoMerges: [null, { enabledAt: 't' }],
    })
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
