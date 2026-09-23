import { describe, expect, it } from 'vitest'
import { evaluateRequiredRollup, landPr, parseRequiredContexts } from './workflow.js'

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

function mockLand({ rollupSequence = [], mergeThrows = null, disableThrows = null, timeout = 60_000 } = {}) {
  let t = 0
  const calls = []
  let poll = 0
  const gh = async (_cwd, args) => {
    calls.push(args)
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

const rollupOf = (conclusion) => ({
  state: 'OPEN',
  statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion }],
})

const call = (calls, predicate) => calls.findIndex(predicate)
const removesLabel = (a) => a[1] === 'edit' && a.includes('--remove-label') && a.includes('reviewed')
const disablesAuto = (a) => a[1] === 'merge' && a.includes('--disable-auto')

describe('landPr', () => {
  it('required=[] → no-required-checks, never labels', async () => {
    const { calls, land } = mockLand()
    const result = await land([])
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(labeled(calls)).toBe(false)
  })

  it('missing required context → pending then timeout, no label', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ],
      timeout: 30_000,
    })
    const result = await land(['ci', 'trufflehog'])
    expect(result.status).toBe('timeout')
    expect(labeled(calls)).toBe(false)
  })

  it('required ci SKIPPED → ci-skipped, no label', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SKIPPED' }],
        },
      ],
    })
    const result = await land(['ci'])
    expect(result).toEqual({ status: 'ci-skipped', skipped: ['ci'] })
    expect(labeled(calls)).toBe(false)
  })

  it('wrong-case check name → pending then timeout, no label', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ],
      timeout: 30_000,
    })
    const result = await land(['ci'])
    expect(result.status).toBe('timeout')
    expect(labeled(calls)).toBe(false)
  })

  it('non-required SKIPPED + required SUCCESS → label then merged', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [
            { name: 'classify', status: 'COMPLETED', conclusion: 'SKIPPED' },
            { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        },
        { state: 'MERGED', statusCheckRollup: [] },
      ],
    })
    const result = await land(['ci'])
    expect(result).toEqual({ status: 'merged' })
    expect(labeled(calls)).toBe(true)
  })

  it('required ci FAILURE → ci-failed, no label', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
        },
      ],
    })
    const result = await land(['ci'])
    expect(result).toEqual({ status: 'ci-failed', failed: ['ci'] })
    expect(labeled(calls)).toBe(false)
  })

  it('ready + auto-merge throws boom → auto-merge-failed', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ],
      mergeThrows: 'boom',
    })
    const result = await land(['ci'])
    expect(result).toEqual({ status: 'auto-merge-failed' })
    expect(labeled(calls)).toBe(true)
  })

  it('ready + auto-merge already enabled → continues to merged', async () => {
    const { calls, land } = mockLand({
      rollupSequence: [
        {
          state: 'OPEN',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
        { state: 'MERGED', statusCheckRollup: [] },
      ],
      mergeThrows: 'Pull request auto-merge is already enabled',
    })
    const result = await land(['ci'])
    expect(result).toEqual({ status: 'merged' })
    expect(labeled(calls)).toBe(true)
  })

  it('closed under us → closed, never labels', async () => {
    const { calls, land } = mockLand({ rollupSequence: [{ state: 'CLOSED', statusCheckRollup: [] }] })
    expect(await land(['ci'])).toEqual({ status: 'closed' })
    expect(labeled(calls)).toBe(false)
  })

  it.each([
    ['FAILURE', { status: 'ci-failed', failed: ['ci'] }],
    ['SKIPPED', { status: 'ci-skipped', skipped: ['ci'] }],
  ])('armed, then required ci %s → label removed, auto-merge disabled, then reported', async (conclusion, expected) => {
    // A strict-policy update-branch re-runs CI after the label is written. Returning
    // with the gate armed lets the next push merge before its re-review: the label
    // makes auto-merge.yml re-enable auto-merge on every synchronize.
    const { calls, land } = mockLand({ rollupSequence: [rollupOf('SUCCESS'), rollupOf(conclusion)] })
    expect(await land(['ci'])).toEqual({ ...expected, disarmed: true })
    const armed = call(calls, (a) => a[1] === 'merge' && a.includes('--auto'))
    const unlabelled = call(calls, removesLabel)
    const disabled = call(calls, disablesAuto)
    expect(armed).toBeGreaterThan(-1)
    // Label first: while it is on, a check_suite completion re-enables auto-merge.
    expect(unlabelled).toBeGreaterThan(armed)
    expect(disabled).toBeGreaterThan(unlabelled)
  })

  it('never disarms a gate it did not arm', async () => {
    const { calls, land } = mockLand({ rollupSequence: [rollupOf('FAILURE')] })
    expect(await land(['ci'])).toEqual({ status: 'ci-failed', failed: ['ci'] })
    expect(calls.some(removesLabel) || calls.some(disablesAuto)).toBe(false)
  })

  it('throws when disarming fails, instead of reporting a disarmed PR', async () => {
    const { land } = mockLand({ rollupSequence: [rollupOf('SUCCESS'), rollupOf('FAILURE')], disableThrows: 'boom' })
    await expect(land(['ci'])).rejects.toThrow('boom')
  })
})
