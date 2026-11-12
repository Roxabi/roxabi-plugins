import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { githubScope, readGitHubHistory } from '../github/transport.ts'

type NativeComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

function comment(id: number, body = `comment ${id}`): NativeComment {
  return {
    id,
    body,
    user: { login: 'operator' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  }
}

type NotModifiedSignal = 'stdout' | 'message' | 'success'

function sentValidator(args: readonly string[]): string | null {
  const header = args.indexOf('--header')
  return header < 0 ? null : String(args[header + 1]).replace(/^If-None-Match: /, '')
}

/** `gh` fails on a 304: its output carries the status, or only its error text, or it does not fail. */
function notModified(signal: NotModifiedSignal, etag: string): string {
  const unchanged = `HTTP/2.0 304 Not Modified\nEtag: ${etag}\r\n\r\n`
  if (signal === 'success') return unchanged
  const failure = new Error('Command failed: gh api\ngh: HTTP 304')
  throw signal === 'message' ? failure : Object.assign(failure, { stdout: unchanged })
}

/**
 * GitHub as `gh api --include` reports it: one validator per representation, and a body-less 304
 * while that validator still matches. Only a 200 is charged to the quota.
 */
function github(issue: number, signal: NotModifiedSignal = 'stdout') {
  const state = {
    comments: [comment(1), comment(2)],
    charged: 0,
    validators: [] as (string | null)[],
    fault: null as string | null,
  }
  const etag = () => {
    const digest = createHash('sha256').update(JSON.stringify(state.comments)).digest('hex')
    return `W/"${digest}"`
  }
  const read = () =>
    readGitHubHistory(githubScope('acme/app', issue), {
      cwd: '/fixture',
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        const validator = sentValidator(args)
        state.validators.push(validator)
        if (state.fault !== null) throw new Error(state.fault)
        if (validator === etag()) return notModified(signal, etag())
        state.charged += 1
        return `HTTP/2.0 200 OK\nContent-Type: application/json\r\nEtag: ${etag()}\r\n\r\n${JSON.stringify(state.comments)}`
      },
    })
  return { state, etag, read }
}

describe('GitHub history revalidation', () => {
  it.each([
    [101, 'stdout'],
    [102, 'message'],
    [106, 'success'],
  ] as const)(
    'charges an unchanged history once and reads the same comments again; issue %i via %s',
    async (issue, signal) => {
      const native = github(issue, signal)
      const first = await native.read()
      const second = await native.read()
      expect(first.complete).toBe(true)
      expect(second).toEqual(first)
      expect(second.comments.map((entry) => entry.body)).toEqual(['comment 1', 'comment 2'])
      expect(native.state.charged).toBe(1)
      expect(native.state.validators).toEqual([null, native.etag()])
    },
  )

  it('reads the current history once GitHub stops confirming the retained one', async () => {
    const native = github(103)
    await native.read()
    native.state.comments = [comment(1, 'edited'), comment(2), comment(3)]
    const changed = await native.read()
    expect(changed.complete).toBe(true)
    expect(changed.comments.map((entry) => entry.body)).toEqual(['edited', 'comment 2', 'comment 3'])
    const confirmed = await native.read()
    expect(confirmed).toEqual(changed)
    expect(native.state.charged).toBe(2)
  })

  it('reports a failed read as incomplete instead of answering from the retained history', async () => {
    const native = github(104)
    await native.read()
    native.state.fault = 'gh: Bad Gateway (HTTP 502)'
    const failed = await native.read()
    expect(failed.complete).toBe(false)
    expect(failed.comments).toEqual([])
    expect(failed.diagnostics).toEqual([{ code: 'github-read-failed', message: 'gh: Bad Gateway (HTTP 502)' }])
  })

  it('keeps reading in full through a transport that reports no validator', async () => {
    const calls: string[][] = []
    const read = () =>
      readGitHubHistory(githubScope('acme/app', 105), {
        cwd: '/fixture',
        readAuthor: 'operator',
        gh: async (_cwd, args) => {
          calls.push(args)
          return JSON.stringify([comment(calls.length)])
        },
      })
    expect((await read()).comments.map((entry) => entry.body)).toEqual(['comment 1'])
    expect((await read()).comments.map((entry) => entry.body)).toEqual(['comment 2'])
    expect(calls.some((args) => args.includes('--header'))).toBe(false)
  })
})
