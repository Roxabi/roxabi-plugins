import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const auth = require('./head-authorization.cjs')
const core = require('../../vendor/kit-head-authorization/index.cjs')
const policy = { repositoryId: 1, operatorIds: [9], appId: 10, botUserId: 11 }
const repo = { owner: 'acme', repo: 'app' }
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)

function commentProof(state, args) {
  const id = args.find((arg) => arg.startsWith('id=')).slice(3)
  const comment = state.comments.find((c) => c.node_id === id)
  return JSON.stringify({
    data: {
      node: {
        id,
        fullDatabaseId: String(comment.id),
        lastEditedAt: state.edited ? '2026-01-01T00:00:00Z' : null,
        repository: { fullDatabaseId: '1' },
        pullRequest: { fullDatabaseId: '2', number: 7 },
      },
    },
  })
}

function postComment(state, args) {
  state.posts++
  const body = args.find((arg) => arg.startsWith('body=')).slice(5)
  const id = state.comments.length ? state.comments.at(-1).id + 1 : 1
  state.comments.push({
    id,
    node_id: `node${id}`,
    body,
    user: { id: 9, type: 'User' },
    performed_via_github_app: null,
    created_at: '2026-01-01T00:00:00Z',
  })
  state.afterPost?.()
  if (state.lost) throw new Error('lost response')
  return '{}'
}

function commentPage(state, page) {
  if (page === state.failPage) throw new Error('page failed')
  const next =
    !state.omitNext && state.comments.length > page * 100
      ? `Link: <https://api.github.com/repos/acme/app/issues/7/comments?per_page=100&page=${page + 1}>; rel="next"\r\n`
      : ''
  return `HTTP/2 200\r\nContent-Type: application/json\r\n${next}\r\n${JSON.stringify(state.comments.slice((page - 1) * 100, page * 100))}`
}

function scopeResponse(state, args) {
  const endpoint = args[1]
  if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
  if (endpoint === 'repos/acme/app') return JSON.stringify({ id: 1 })
  if (endpoint === 'repos/acme/app/pulls/7')
    return JSON.stringify({
      id: 2,
      number: 7,
      user: { id: 12 },
      head: { sha: head },
      base: { sha: base, ref: 'main', repo: { id: 1 } },
    })
  if (endpoint === 'repos/acme/app/git/ref/heads/main')
    return JSON.stringify({ ref: 'refs/heads/main', object: { sha: state.base } })
  if (endpoint === 'user') return JSON.stringify({ id: 9, type: 'User' })
  return null
}

function fixture() {
  const state = {
    comments: [],
    posts: 0,
    lost: false,
    failPage: 0,
    edited: false,
    base,
    omitNext: false,
    afterPost: null,
  }
  const gh = async (_cwd, args) => {
    const endpoint = args[1]
    const scope = scopeResponse(state, args)
    if (scope !== null) return scope
    if (endpoint === 'graphql') return commentProof(state, args)
    if (args[1] === '--method') return postComment(state, args)
    const match = (args[1] === '--include' ? args[2] : endpoint)?.match(/comments\?per_page=100&page=(\d+)/)
    if (match) return commentPage(state, Number(match[1]))
    throw new Error(`unexpected gh call ${args.join(' ')}`)
  }
  return { state, gh, repo, prNumber: 7, policy }
}

const issue = (f, snapshot, operationId = 'grant-1') =>
  auth.issueAuthorization({ ...f, snapshot, lane: 'reviewed', source: 'native', evidence: 'review', operationId })

describe('GitHub authorization adapter', () => {
  it('captures, reconciles a lost POST exactly once, and withdraws', async () => {
    const f = fixture()
    const snapshot = await auth.captureAuthorization(f)
    f.state.lost = true
    const receipt = await issue(f, snapshot)
    expect(receipt.record.headSha).toBe(head)
    expect(receipt.createdAt).toBe('2026-01-01T00:00:00Z')
    expect(f.state.posts).toBe(1)
    expect((await auth.readAuthorization(f)).allowed).toBe(true)
    f.state.lost = false
    await auth.withdrawAuthorization({ ...f, operationId: 'withdraw-1', reason: 'stop' })
    expect(await auth.readAuthorization(f)).toMatchObject({ allowed: false, reason: 'withdrawn' })
    await expect(issue(f, snapshot, 'stale')).rejects.toThrow('snapshot moved')
  })

  it('enumerates beyond 100 and fails closed on a later page failure', async () => {
    const f = fixture()
    for (let id = 1; id <= 100; id++)
      f.state.comments.push({ id, node_id: `node${id}`, body: 'ordinary', user: { id: 9, type: 'User' } })
    const snapshot = await auth.captureAuthorization(f)
    await issue(f, snapshot)
    expect((await auth.readAuthorization(f)).allowed).toBe(true)
    f.state.failPage = 2
    await expect(auth.readAuthorization(f)).rejects.toThrow('page failed')
  })

  it('continues a full page even without a next link and sees a later withdrawal', async () => {
    const f = fixture()
    const snapshot = await auth.captureAuthorization(f)
    await issue(f, snapshot)
    for (let id = 2; id <= 100; id++)
      f.state.comments.push({ id, body: 'ordinary', user: { id: 9, type: 'User' }, performed_via_github_app: null })
    await auth.withdrawAuthorization({ ...f, operationId: 'withdraw', reason: 'stop' })
    f.state.omitNext = true
    expect((await auth.readAuthorization(f)).allowed).toBe(false)
    f.state.failPage = 2
    await expect(auth.readAuthorization(f)).rejects.toThrow()
  })

  it('captures the live branch tip rather than cached pull base and applies source-specific base binding', async () => {
    const f = fixture()
    const before = await auth.captureAuthorization(f)
    f.state.base = 'c'.repeat(40)
    expect((await auth.captureAuthorization(f)).scope.baseSha).toBe('c'.repeat(40))
    await auth.issueAuthorization({
      ...f,
      snapshot: before,
      lane: 'reviewed',
      source: 'manual',
      evidence: 'human',
      operationId: 'manual',
    })
    expect((await auth.readAuthorization(f)).allowed).toBe(true)
    const native = await auth.captureAuthorization(f)
    f.state.base = 'd'.repeat(40)
    await expect(
      auth.issueAuthorization({
        ...f,
        snapshot: native,
        lane: 'reviewed',
        source: 'native',
        evidence: 'native',
        operationId: 'native',
        requireBaseSha: true,
      }),
    ).rejects.toThrow()
    expect(f.state.posts).toBe(1)
  })

  it('confirms independent reviewed issuance across a base advance during publication', async () => {
    const f = fixture()
    const snapshot = await auth.captureAuthorization(f)
    f.state.afterPost = () => {
      f.state.base = 'c'.repeat(40)
    }
    await auth.issueAuthorization({
      ...f,
      snapshot,
      lane: 'reviewed',
      source: 'manual',
      evidence: 'human',
      operationId: 'manual',
    })
    expect((await auth.readAuthorization(f)).allowed).toBe(true)
  })

  it('denies edited records and malformed trusted markers', async () => {
    const f = fixture()
    await issue(f, await auth.captureAuthorization(f))
    f.state.edited = true
    expect((await auth.readAuthorization(f)).allowed).toBe(false)
    f.state.edited = false
    f.state.comments.push({
      id: 2,
      node_id: 'node2',
      body: `${core.PREFIX}{}`,
      user: { id: 9, type: 'User' },
      performed_via_github_app: null,
    })
    expect(await auth.readAuthorization(f)).toMatchObject({
      allowed: false,
      reason: 'malformed authorization',
      previous: 2,
    })
  })
  it('distinguishes absent policy from partial or unreadable repository variables', async () => {
    const response =
      (variables, total = variables.length) =>
      async () =>
        `HTTP/2 200\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ total_count: total, variables })}`
    expect(await auth.policyFromRepository({ repo, gh: response([]) })).toBeNull()
    await expect(
      auth.policyFromRepository({ repo, gh: response([{ name: 'HEAD_AUTH_APP_ID', value: '10' }]) }),
    ).rejects.toThrow('incomplete repository authorization policy')
    await expect(auth.policyFromRepository({ repo, gh: response([], 1) })).rejects.toThrow(
      'incomplete repository variables',
    )
    await expect(
      auth.policyFromRepository({
        repo,
        gh: async () => {
          throw new Error('403')
        },
      }),
    ).rejects.toThrow('403')
  })
})
