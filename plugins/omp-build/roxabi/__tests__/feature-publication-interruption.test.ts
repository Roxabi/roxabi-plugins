import { describe, expect, it, vi } from 'vitest'
import { proveAuthorizedBranch } from '../feature-publication.ts'
import type { GitRunner } from '../workflow-checkout.ts'

const branch = 'feat/42-save'
const tip = 'a'.repeat(40)

function pushUrlRead(pushUrls: string[] | null) {
  return pushUrls === null
    ? { code: 2, stdout: '', stderr: "error: No such remote 'origin'" }
    : { code: 0, stdout: `${pushUrls.join('\n')}\n`, stderr: '' }
}

function branchGit(remoteTip: string, pushCode = 0, pushStderr = 'connection lost', pushUrls: string[] | null = null) {
  const calls: string[][] = []
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') {
      return { code: 0, stdout: args[1] === '--abbrev-ref' ? branch : tip, stderr: '' }
    }
    if (args[0] === 'ls-remote') return { code: 0, stdout: `${remoteTip}\trefs/heads/${branch}\n`, stderr: '' }
    if (args[0] === 'push') return { code: pushCode, stdout: '', stderr: pushCode === 0 ? '' : pushStderr }
    if (args.join(' ') === 'remote get-url --push --all origin') return pushUrlRead(pushUrls)
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

  const withheld = 'git push: stderr withheld (a push URL of origin carries a credential)'
  it.each([
    [['git@github.com:o/r.git'], 'connection lost\n', 'git push: connection lost'],
    [['git@github.com:o/r.git'], '', 'git push: no stderr'],
    [
      ['https://github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
      "git push: fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    ],
    [['https://x-access-token:ghs_secret@github.com/o/r.git'], 'ghs_secret', withheld],
    [['https://ghs_secret@github.com/o/r.git'], 'ghs_secret', withheld],
    [['https://example.com/o/r.git?access_token=ghs_secret'], 'ghs_secret', withheld],
    [['ssh://git:ghs_secret@example.com/o/r.git'], 'ghs_secret', withheld],
    [['git@github.com:o/r.git', 'https://x:ghs_secret@mirror.example/o/r.git'], 'ghs_secret', withheld],
    [null, 'ghs_secret', 'git push: stderr withheld (push URL unreadable)'],
  ])('reports a failed push to %j without exposing a URL credential', async (pushUrls, stderr, detail) => {
    const { git, calls } = branchGit('b'.repeat(40), 1, stderr, pushUrls)
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
})
