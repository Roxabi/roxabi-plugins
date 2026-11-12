import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
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
type Held = { entered: () => void; released: Promise<void> }
type State = {
  comments: NativeComment[]
  charged: number
  validators: (string | null)[]
  fault: Error | null
  held: Held | null
}

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

/** A failed `gh api --include` call: its error text and the response it printed before failing. */
function failedCall(status: string, etag: string): Error {
  return Object.assign(new Error(`Command failed: gh api\ngh: ${status}`), {
    stdout: `HTTP/2.0 502 Bad Gateway\r\nEtag: ${etag}\r\n\r\n{"message":"Server Error"}`,
    stderr: `gh: ${status}\n`,
  })
}

/** GitHub decides at request time; the returned thunk delivers that decision, possibly later. */
function answer(state: State, signal: NotModifiedSignal, validator: string | null, etag: string): () => string {
  const fault = state.fault
  if (fault !== null)
    return () => {
      throw fault
    }
  if (validator === etag) return () => notModified(signal, etag)
  state.charged += 1
  const output = `HTTP/2.0 200 OK\nContent-Type: application/json\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(state.comments)}`
  return () => output
}

/**
 * GitHub as `gh api --include` reports it: one validator per representation, and a body-less 304
 * while that validator still matches. Only a 200 is charged to the quota.
 */
function github(issue: number, signal: NotModifiedSignal = 'stdout') {
  const state: State = { comments: [comment(1), comment(2)], charged: 0, validators: [], fault: null, held: null }
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
        const deliver = answer(state, signal, validator, etag())
        const held = state.held
        state.held = null
        if (held !== null) {
          held.entered()
          await held.released
        }
        return deliver()
      },
    })
  /** Keep the next call's answer in transit until released. */
  const hold = () => {
    let entered = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    state.held = { entered, released }
    return { started, release }
  }
  return { state, etag, read, hold }
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
    native.state.fault = failedCall('Bad Gateway (HTTP 502)', native.etag())
    const failed = await native.read()
    expect(failed.complete).toBe(false)
    expect(failed.comments).toEqual([])
    expect(failed.diagnostics.map((entry) => entry.code)).toEqual(['github-read-failed'])
    expect(failed.diagnostics[0]?.message).toContain('HTTP 502')
  })

  it('keeps the newest history retained when an older overlapping read is confirmed late', async () => {
    const native = github(107)
    await native.read()
    const late = native.hold()
    const older = native.read()
    await late.started
    native.state.comments = [comment(1), comment(2), comment(3)]
    const newer = await native.read()
    late.release()
    expect((await older).comments).toHaveLength(2)
    expect(newer.comments).toHaveLength(3)
    const after = await native.read()
    expect(after).toEqual(newer)
    expect(native.state.validators.at(-1)).toBe(native.etag())
    expect(native.state.charged).toBe(2)
  })

  it('never offers one credential the validator retained under another', async () => {
    const native = github(108)
    try {
      vi.stubEnv('GH_TOKEN', 'credential-a')
      await native.read()
      vi.stubEnv('GH_TOKEN', 'credential-b')
      const other = await native.read()
      expect(other.complete).toBe(true)
      expect(native.state.validators).toEqual([null, null])
      expect(native.state.charged).toBe(2)
    } finally {
      vi.unstubAllEnvs()
    }
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
