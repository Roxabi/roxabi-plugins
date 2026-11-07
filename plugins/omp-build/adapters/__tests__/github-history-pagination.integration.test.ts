import { describe, expect, it } from 'vitest'
import type { History } from '../../engine/history-schema.ts'
import { githubScope, readGitHubHistory } from '../github/transport.ts'

type NativeComment = {
  id: number | null
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

function comment(id: number): NativeComment {
  return {
    id,
    body: `comment ${id}`,
    user: { login: id === 101 || id === 201 ? 'operator' : 'other' },
    created_at: `created-${id}`,
    updated_at: `updated-${id}`,
  }
}

// Mutable external GitHub page-number server; the actual adapter is under test.
function server(count: number, hook?: (page: number, visit: number, comments: NativeComment[]) => string | undefined) {
  const comments = Array.from({ length: count }, (_, index) => comment(index + 1))
  const visits = new Map<number, number>()
  return {
    comments,
    read: () =>
      readGitHubHistory(githubScope('acme/app', 42), {
        cwd: '/fixture',
        readAuthor: 'operator',
        gh: async (_cwd, args) => {
          const page = Number(new URL(String(args[1]), 'https://api.github.com').searchParams.get('page'))
          const visit = (visits.get(page) ?? 0) + 1
          visits.set(page, visit)
          const override = hook?.(page, visit, comments)
          return override ?? JSON.stringify(comments.slice((page - 1) * 100, page * 100))
        },
      }),
  }
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => String(index + 1))
const observedIds = (history: History) => history.comments.map((entry) => entry.nativeId)
const codes = (history: History) => history.diagnostics.map((entry) => entry.code)

function verificationFault(fault: string): string | undefined {
  if (fault === 'verification error') throw new Error('unavailable')
  if (fault === 'verification non-array') return '{}'
  if (fault === 'verification non-object') return JSON.stringify(Array.from({ length: 100 }, () => null))
  return undefined
}

describe('GitHub history pagination integrity', () => {
  it('preserves every stable native identity and revision across pages', async () => {
    const history = await server(120).read()
    expect(history.complete).toBe(true)
    expect(codes(history)).toEqual([])
    expect(observedIds(history)).toEqual(ids(120))
    expect(
      history.comments.map(({ body, author, createdAt, updatedAt }) => ({ body, author, createdAt, updatedAt })),
    ).toEqual(
      Array.from({ length: 120 }, (_, index) => {
        const native = comment(index + 1)
        return {
          body: native.body,
          author: native.user.login,
          createdAt: native.created_at,
          updatedAt: native.updated_at,
        }
      }),
    )
  })

  it('holds the receipt race with a ghost and omitted boundary comment as partial evidence', async () => {
    const history = await server(120, (page, visit, comments) => {
      if (page === 2 && visit === 1) comments.shift()
      return undefined
    }).read()
    expect(history.complete).toBe(false)
    expect(codes(history)).toContain('github-pagination-changed')
    expect(observedIds(history)).toContain('1')
    expect(observedIds(history)).not.toContain('101')
    expect(observedIds(history)).toContain('102')
  })

  it.each([
    [101, 2, '101'],
    [201, 3, '201'],
  ])('holds when deletion hides a record at an empty boundary', async (count, boundary, target) => {
    const history = await server(Number(count), (page, visit, comments) => {
      if (page === boundary && visit === 1) comments.splice(4, 1)
      return undefined
    }).read()
    expect(history.complete).toBe(false)
    expect(codes(history)).toContain('github-pagination-changed')
    expect(observedIds(history)).not.toContain(target)
  })

  it('holds when two deletions hide both record parts', async () => {
    const history = await server(102, (page, visit, comments) => {
      if (page === 2 && visit === 1) comments.splice(0, 2)
      return undefined
    }).read()
    expect(history.complete).toBe(false)
    expect(codes(history)).toContain('github-pagination-changed')
    expect(observedIds(history)).not.toContain('101')
    expect(observedIds(history)).not.toContain('102')
  })

  it('stops at the first changed boundary before a second deletion', async () => {
    let laterDeletion = false
    const history = await server(220, (page, visit, comments) => {
      if (page === 2 && visit === 1) comments.shift()
      if (page === 3 && visit === 1) {
        laterDeletion = true
        comments.shift()
      }
      return undefined
    }).read()
    expect(history.complete).toBe(false)
    expect(codes(history)).toContain('github-pagination-changed')
    expect(laterDeletion).toBe(false)
    expect(observedIds(history)).not.toContain('101')
  })

  it.each(['before terminal page', 'after terminal page'])('does not hold for an append %s', async (when) => {
    const history = await server(120, (page, visit, comments) => {
      if (
        (when === 'before terminal page' && page === 2 && visit === 1) ||
        (when === 'after terminal page' && page === 1 && visit === 2)
      )
        comments.push(comment(121))
      return undefined
    }).read()
    expect(history.complete).toBe(true)
    expect(observedIds(history)).toEqual(when === 'before terminal page' ? ids(121) : ids(120))
  })

  it.each(['body', 'author', 'created_at', 'updated_at'] as const)(
    'holds when previous page %s changes in its window',
    async (field) => {
      const history = await server(120, (page, visit, comments) => {
        if (page === 1 && visit === 2) {
          const item = comments[4]
          if (field === 'author') item.user.login = 'different'
          else item[field] = 'changed'
        }
        return undefined
      }).read()
      expect(history.complete).toBe(false)
      expect(codes(history)).toContain('github-pagination-changed')
      expect(history.comments[4]?.body).toBe('comment 5')
    },
  )

  it.each(['before', 'after'])('retains the terminal revision observed %s its fetch', async (when) => {
    const history = await server(120, (page, visit, comments) => {
      if ((when === 'before' && page === 2 && visit === 1) || (when === 'after' && page === 1 && visit === 2)) {
        comments[109].body = 'edited'
        comments[109].updated_at = 'edited-at'
      }
      return undefined
    }).read()
    expect(history.complete).toBe(true)
    expect(history.comments[109]).toMatchObject(
      when === 'before'
        ? { body: 'edited', updatedAt: 'edited-at' }
        : { body: 'comment 110', updatedAt: 'updated-110' },
    )
  })

  it('accepts deletion from the terminal page before it is read', async () => {
    const history = await server(120, (page, visit, comments) => {
      if (page === 2 && visit === 1) comments.splice(109, 1)
      return undefined
    }).read()
    expect(history.complete).toBe(true)
    expect(observedIds(history)).toEqual(ids(120).filter((id) => id !== '110'))
  })

  it.each(['next-page error', 'verification error', 'verification non-array', 'verification non-object'])(
    'retains partial comments for %s',
    async (fault) => {
      const history = await server(120, (page, visit) => {
        if (fault === 'next-page error' && page === 2 && visit === 1) throw new Error('unavailable')
        if (page === 1 && visit === 2) return verificationFault(fault)
        return undefined
      }).read()
      expect(history.complete).toBe(false)
      expect(observedIds(history)).toEqual(ids(fault === 'next-page error' ? 100 : 120))
      expect(codes(history)).toContain(fault.includes('error') ? 'github-read-failed' : 'invalid-github-response')
    },
  )

  it('does not certify a previous page without native identity', async () => {
    const fixture = server(101)
    fixture.comments[4].id = null
    const history = await fixture.read()
    expect(history.complete).toBe(false)
    expect(codes(history)).toContain('github-pagination-changed')
    expect(history.comments[4]?.nativeId).toBeNull()
    expect(observedIds(history)).toContain('101')
  })

  it.each([0, 99, 100, 250])('preserves complete membership for %s stable comments', async (count) => {
    const history = await server(count).read()
    expect(history.complete).toBe(true)
    expect(observedIds(history)).toEqual(ids(count))
  })
})
