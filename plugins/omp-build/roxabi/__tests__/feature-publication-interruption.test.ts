import { describe, expect, it, vi } from 'vitest'
import { proveAuthorizedBranch } from '../feature-publication.ts'
import type { GitRunner } from '../workflow-checkout.ts'

const branch = 'feat/42-save'
const tip = 'a'.repeat(40)

function branchGit(remoteTip: string, pushCode = 0, pushStderr = 'connection lost') {
  const calls: string[][] = []
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') {
      return { code: 0, stdout: args[1] === '--abbrev-ref' ? branch : tip, stderr: '' }
    }
    if (args[0] === 'ls-remote') return { code: 0, stdout: `${remoteTip}\trefs/heads/${branch}\n`, stderr: '' }
    if (args[0] === 'push') return { code: pushCode, stdout: '', stderr: pushCode === 0 ? '' : pushStderr }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  return { git, calls }
}

describe('implementation branch effect authority', () => {
  it('does not accept an already-remote tip after authority is withdrawn', async () => {
    const { git, calls } = branchGit(tip)
    const authority = vi.fn(async () => ({ ok: false as const, reason: 'implementation-authority-withdrawn' }))

    const result = await proveAuthorizedBranch(git, '/checkout', branch, tip, {
      effect: authority,
      beforePush: authority,
    })

    expect(authority).toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      reason: 'implementation-authority-withdrawn',
      confirmedRemote: { branch, tip },
    })
    expect(calls.some(([command]) => command === 'push')).toBe(false)
  })

  it('retains the already-observed tip when authority throws', async () => {
    const { git, calls } = branchGit(tip)
    const cause = new Error('authority unreadable')
    const authority = async () => {
      throw cause
    }
    await expect(
      proveAuthorizedBranch(git, '/checkout', branch, tip, {
        effect: authority,
        beforePush: authority,
      }),
    ).rejects.toMatchObject({ cause, confirmedRemote: { branch, tip } })
    expect(calls.some(([command]) => command === 'push')).toBe(false)
  })

  it('does not push when authority is withdrawn before a required push', async () => {
    const { git, calls } = branchGit('b'.repeat(40))
    const denied = async () => ({ ok: false as const, reason: 'implementation-authority-withdrawn' })
    const result = await proveAuthorizedBranch(git, '/checkout', branch, tip, { effect: denied, beforePush: denied })

    expect(result).toMatchObject({ ok: false })
    expect(calls.some(([command]) => command === 'push')).toBe(false)
  })

  it.each([
    [
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n",
      "git push: fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    ],
    ['', 'git push: no stderr'],
  ])('distinguishes a failed push from a remote mismatch and reports git stderr %j', async (stderr, detail) => {
    const { git, calls } = branchGit('b'.repeat(40), 1, stderr)
    const allowed = async () => ({ ok: true as const })
    const result = await proveAuthorizedBranch(git, '/checkout', branch, tip, { effect: allowed, beforePush: allowed })

    expect(result).toEqual({ ok: false, reason: 'implementation-push-failed', detail })
    expect(calls.filter(([command]) => command === 'push')).toHaveLength(1)
  })

  it('distinguishes an unconfirmed remote tip after a successful push', async () => {
    const { git, calls } = branchGit('b'.repeat(40))
    const allowed = async () => ({ ok: true as const })
    const result = await proveAuthorizedBranch(git, '/checkout', branch, tip, { effect: allowed, beforePush: allowed })

    expect(result).toEqual({ ok: false, reason: 'implementation-remote-unconfirmed' })
    expect(calls.filter(([command]) => command === 'push')).toHaveLength(1)
    expect(calls.filter(([command]) => command === 'ls-remote')).toHaveLength(2)
  })

  it('pushes the verified SHA, never the symbolic HEAD', async () => {
    const { git, calls } = branchGit('b'.repeat(40))
    const allowed = async () => ({ ok: true as const })
    await proveAuthorizedBranch(git, '/checkout', branch, tip, { effect: allowed, beforePush: allowed })

    expect(calls.filter(([command]) => command === 'push')).toEqual([
      ['push', 'origin', `${tip}^{commit}:refs/heads/${branch}`],
    ])
  })
})
