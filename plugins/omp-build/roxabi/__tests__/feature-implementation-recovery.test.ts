import { describe, expect, it, vi } from 'vitest'
import { criterionTarget } from '../../engine/__tests__/criterion-admission-fixture.ts'
import { admitImplementationEvidence } from '../feature-implementation-admission.ts'

const second = 'c'.repeat(40)
const later = 'd'.repeat(40)

function claim(commitSHAs: string[]) {
  return {
    outcome: 'implemented',
    commitSHAs,
    commands: [],
    criteria: [
      { target: criterionTarget('C1'), verification: 'unverified', reason: 'fresh verification has no evidence' },
    ],
    reason: 'fresh result',
  }
}

function gitMock(parents?: Record<string, string>) {
  return vi.fn(async (args: readonly string[]) => {
    switch (args[0]) {
      case 'status':
        return { stdout: '', exitCode: 0 }
      case 'rev-parse': {
        if (args[1] === 'HEAD') return { stdout: later, exitCode: 0 }
        const value = args[2]
        if (value === undefined) throw new Error('missing rev-parse argument')
        return { stdout: value.replace('^{commit}', ''), exitCode: 0 }
      }
      case 'rev-list': {
        if (parents === undefined) return { stdout: `${later} ${'a'.repeat(40)}`, exitCode: 0 }
        const value = args[3]
        if (value === undefined) throw new Error('missing rev-list argument')
        return { stdout: `${value} ${parents[value]}`, exitCode: 0 }
      }
      case 'diff-tree':
        return { stdout: 'src/file.ts\n', exitCode: 0 }
      case 'show':
        return { stdout: 'feat: bounded work (#42)', exitCode: 0 }
      default:
        throw new Error(`unexpected git call: ${args.join(' ')}`)
    }
  })
}

describe('implementation evidence after a safe stop', () => {
  it('rejects commits that precede the new START head', async () => {
    const git = gitMock()
    const admission = await admitImplementationEvidence({
      cwd: '/checkout',
      startHead: second,
      ticket: 42,
      children: [{ structured: claim([later]) }],
      git,
    })
    expect(admission.admitted).toBe(false)
  })
  it('proves new work from the current START head and retains fresh criteria', async () => {
    const parents: Record<string, string> = { [later]: second }
    const git = gitMock(parents)
    const admission = await admitImplementationEvidence({
      cwd: '/checkout',
      startHead: second,
      ticket: 42,
      children: [{ structured: claim([later]) }],
      git,
    })
    expect(admission).toMatchObject({ admitted: true, commits: [later] })
    expect(git).toHaveBeenCalledWith(['rev-list', '--parents', '-n1', later], '/checkout')
  })
})
