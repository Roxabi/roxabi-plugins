import { describe, expect, it } from 'vitest'
import { type Gh, type Git, refreshReviewBase } from './review-base.ts'

const BASE_TIP = 'b'.repeat(40)
const OTHER_TIP = 'c'.repeat(40)
const REPOSITORY = 'acme/app'

function fetching(calls: string[][]): Git {
  return async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'remote') return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${BASE_TIP}\n`, stderr: '' }
    return { code: 128, stdout: '', stderr: `unexpected git call ${args.join(' ')}` }
  }
}

const repository: Gh = async () => JSON.stringify({ nameWithOwner: REPOSITORY })

describe('refreshReviewBase', () => {
  it('selects the fetched base tip', async () => {
    const calls: string[][] = []

    await expect(refreshReviewBase('/tmp/worktree', 'main', fetching(calls), repository)).resolves.toEqual({
      ok: true,
      tip: BASE_TIP,
    })
    expect(calls).toEqual([
      ['remote', 'get-url', 'origin'],
      ['fetch', '--quiet', '--no-tags', 'git@github.com:acme/app.git', '+refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    ])
  })

  it('refuses an option-shaped base before any git call', async () => {
    const calls: string[][] = []

    await expect(refreshReviewBase('/tmp/worktree', '-main', fetching(calls), repository)).resolves.toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
    expect(calls).toEqual([])
  })

  it('refuses a fork origin before fetching its base', async () => {
    const calls: string[][] = []
    const gh: Gh = async (_cwd, args) =>
      JSON.stringify({
        nameWithOwner: args.at(-1) === 'nameWithOwner' && args[2] === '--json' ? REPOSITORY : 'fork/app',
      })

    await expect(refreshReviewBase('/tmp/worktree', 'main', fetching(calls), gh)).resolves.toMatchObject({
      ok: false,
      reason: 'unbound',
    })
    expect(calls).toEqual([['remote', 'get-url', 'origin']])
  })

  it('fetches the verified URL when origin changes after its repository lookup', async () => {
    const original = 'git@github.com:acme/app.git'
    let remote = original
    let tip = OTHER_TIP
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'remote') return { code: 0, stdout: `${remote}\n`, stderr: '' }
      if (args[0] === 'fetch') {
        tip = args[3] === original ? BASE_TIP : OTHER_TIP
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: `${tip}\n`, stderr: '' }
    }
    const gh: Gh = async (_cwd, args) => {
      if (args[2] === original) remote = 'git@github.com:fork/app.git'
      return JSON.stringify({ nameWithOwner: REPOSITORY })
    }

    await expect(refreshReviewBase('/tmp/worktree', 'main', git, gh)).resolves.toEqual({ ok: true, tip: BASE_TIP })
  })
})
