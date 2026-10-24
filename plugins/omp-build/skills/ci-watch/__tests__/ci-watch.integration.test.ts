import { execFileSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture } from './ci-watch-fixtures.ts'

const SCRIPT = join(import.meta.dirname, '..', 'ci-watch.sh')

function classifyMerge(...args: string[]): string {
  return execFileSync(SCRIPT, ['--classify-merge-state', ...args], { encoding: 'utf8' }).trim()
}

function classifyChecks(json: string): string {
  return execFileSync(SCRIPT, ['--classify-checks'], { encoding: 'utf8', input: json }).trim()
}

function checksOf(rollup: unknown[]): string {
  return execFileSync(SCRIPT, ['--checks-of'], {
    encoding: 'utf8',
    input: JSON.stringify({ statusCheckRollup: rollup }),
  })
}

function classifyRollup(rollup: unknown[]): string {
  return execFileSync(SCRIPT, ['--classify-checks'], { encoding: 'utf8', input: checksOf(rollup) }).trim()
}

function exitOf(args: string[]): number {
  try {
    execFileSync(SCRIPT, args, { encoding: 'utf8' })
    return 0
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status
    throw error
  }
}

describe('ci-watch CLI refusals', () => {
  it.each([
    ['an unknown flag', ['7', '--nope']],
    ['a bogus merge mode', ['7', '--merge-mode', 'bogus', '--repo', 'acme/app']],
    ['a bad timeout', ['7', '--timeout', 'bogus', '--repo', 'acme/app']],
    ['a fractional UTC second', ['7', '--since', '2026-09-29T10:00:00.123Z', '--repo', 'acme/app']],
    ['no PR', []],
  ])('%s exits 70', (_label, args) => {
    expect(exitOf(args)).toBe(70)
  })

  it.each(['--timeout', '--interval', '--merge-mode', '--repo', '--since'] as const)(
    '%s without a value exits 70, not a verdict',
    (flag) => {
      expect(exitOf(['7', flag])).toBe(70)
    },
  )

  it('refuses a missing jq before calling GitHub', () => {
    const box = fixture('no-jq')
    for (const command of ['bash', 'gh', 'bun'] as const) {
      const real = execFileSync('/bin/bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim()
      symlinkSync(real, join(box.bin, command))
    }
    try {
      execFileSync(SCRIPT, ['7', '--repo', 'acme/app'], { encoding: 'utf8', env: { ...process.env, PATH: box.bin } })
      expect.unreachable('expected exit 70')
    } catch (error) {
      const failed = error as { status?: number; stderr?: string }
      expect(failed.status).toBe(70)
      expect(String(failed.stderr ?? '')).toContain("'jq' is required but not found on PATH")
    }
  })
})

describe('ci-watch pure merge classification', () => {
  it('prioritizes terminal, behind, deadline, and eligibility outcomes independently', () => {
    expect(classifyMerge('MERGED', 'BEHIND', 'merge-on-green', 'true', '9999', '1800')).toBe('0')
    expect(classifyMerge('CLOSED', 'BEHIND', 'merge-on-green', 'true', '9999', '1800')).toBe('4')
    expect(classifyMerge('OPEN', 'BEHIND', 'native', 'false', '9999', '1800')).toBe('7')
    expect(classifyMerge('OPEN', 'BLOCKED', 'merge-on-green', 'true', '1800', '1800')).toBe('5')
    expect(classifyMerge('OPEN', 'CLEAN', 'merge-on-green', 'false', '10', '1800')).toBe('4')
    expect(classifyMerge('OPEN', 'CLEAN', 'native', 'false', '10', '1800')).toBe('0')
  })

  it('never converts an OPEN behind PR into WATCH or deadline in either mode', () => {
    for (const [elapsed, timeout] of [
      ['10', '1800'],
      ['1799', '1800'],
      ['1800', '1800'],
      ['9999', '1800'],
    ] as const) {
      for (const mode of ['merge-on-green', 'native'] as const) {
        expect(classifyMerge('OPEN', 'BEHIND', mode, 'true', elapsed, timeout)).toBe('7')
      }
    }
    expect(classifyMerge('OPEN', 'BEHIND', 'merge-on-green', 'false', '10', '1800')).toBe('7')
    expect(classifyMerge('OPEN', 'BEHIND', 'native', 'false', '10', '1800')).toBe('7')
  })

  it('keeps blocked and unstable states watchable before their deadline', () => {
    for (const state of ['BLOCKED', 'UNSTABLE']) {
      expect(classifyMerge('OPEN', state, 'merge-on-green', 'true', '10', '1800')).toBe('WATCH')
      expect(classifyMerge('OPEN', state, 'merge-on-green', 'true', '1800', '1800')).toBe('5')
    }
  })

  it('maps dirty to unmerged', () => {
    expect(classifyMerge('OPEN', 'DIRTY', 'merge-on-green', 'true', '10', '1800')).toBe('4')
  })
})

describe('ci-watch check classification', () => {
  it('treats skipped and neutral as passing while pending and failures outrank them', () => {
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]')).toBe('GREEN')
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"Skipped"}]')).toBe('GREEN')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"lint","status":"COMPLETED","conclusion":"NEUTRAL"}]',
      ),
    ).toBe('GREEN')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"IN_PROGRESS","conclusion":""},{"name":"skip","status":"COMPLETED","conclusion":"SKIPPED"}]',
      ),
    ).toBe('PENDING')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"lint","status":"COMPLETED","conclusion":"FAILURE"}]',
      ),
    ).toBe('FAIL')
    expect(classifyChecks('[]')).toBe('PENDING')
  })
})

describe('ci-watch rollup normalization', () => {
  it.each([
    ['SUCCESS', 'completed', 'success', 'GREEN'],
    ['PENDING', 'in_progress', '', 'PENDING'],
    ['EXPECTED', 'in_progress', '', 'PENDING'],
    ['FAILURE', 'completed', 'failure', 'FAIL'],
    ['ERROR', 'completed', 'failure', 'FAIL'],
    ['BLOCKED', 'completed', 'BLOCKED', 'OTHER'],
  ])('maps status %s to an independent visible conclusion', (state, status, conclusion, verdict) => {
    const rollup = [{ context: 'coverage', state }]
    expect(JSON.parse(checksOf(rollup))).toEqual([{ name: 'coverage', status, conclusion }])
    expect(classifyRollup(rollup)).toBe(verdict)
  })

  it('leaves a check-run entry unchanged while normalizing commit statuses', () => {
    expect(JSON.parse(checksOf([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]))).toEqual([
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ])
  })

  it('keeps a pending status ahead of a passing check', () => {
    expect(
      classifyRollup([
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { context: 'coverage', state: 'PENDING' },
      ]),
    ).toBe('PENDING')
  })

  it('selects the fresh rerun over a stale cancelled result', () => {
    const rollup = [
      {
        name: 'Validate PR Title',
        status: 'COMPLETED',
        conclusion: 'CANCELLED',
        workflowName: 'PR',
        startedAt: '2026-09-29T10:00:00Z',
      },
      {
        name: 'Validate PR Title',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        workflowName: 'PR',
        startedAt: '2026-09-29T10:00:05Z',
      },
    ]
    expect(JSON.parse(checksOf(rollup))).toEqual([
      { name: 'Validate PR Title', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ])
    expect(classifyRollup(rollup)).toBe('GREEN')
  })

  it('keeps a fresh in-progress rerun pending over its stale cancellation', () => {
    expect(
      classifyRollup([
        {
          name: 'ci',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          workflowName: 'CI',
          startedAt: '2026-09-29T10:00:00Z',
        },
        { name: 'ci', status: 'IN_PROGRESS', conclusion: '', workflowName: 'CI', startedAt: '2026-09-29T10:00:05Z' },
      ]),
    ).toBe('PENDING')
  })
})
