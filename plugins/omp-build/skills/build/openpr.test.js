import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitPush, createReviewLoop, detectPrincipal, landPr, MAX_FIX_ROUNDS, openPr, run } from './workflow.js'

/**
 * Every call goes through an injected client. Nothing here can reach a real `gh`,
 * so no test can open, label or merge a pull request — the same posture
 * `land.test.js` takes with `landPr(cwd, pr, { gh })`.
 */
function mockGh({
  list = '[]',
  create = JSON.stringify({ number: 512 }),
  listThrows = null,
  createThrows = null,
} = {}) {
  const calls = []
  let listCall = 0
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list') {
      if (listThrows) throw new Error(listThrows)
      const responses = Array.isArray(list) ? list : [list]
      const response = responses[Math.min(listCall, responses.length - 1)]
      listCall++
      return response
    }
    if (args[0] === 'api') {
      if (createThrows) throw new Error(createThrows)
      return create
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls }
}

describe('expand–contract (#494 adds, #497 removes)', () => {
  it('keeps every seam mode 2 and the old driver import from this module', () => {
    // `skills/build/SKILL.md` does `const { run } = await import(…/workflow.js)`
    // and `skills/feature/SKILL.md` §6.0 imports the five below. Both are runtime
    // imports in a live session: nothing else here observes an early deletion.
    const surface = { commitPush, createReviewLoop, detectPrincipal, landPr, openPr, run }
    expect(Object.fromEntries(Object.entries(surface).map(([name, fn]) => [name, typeof fn]))).toEqual({
      commitPush: 'function',
      createReviewLoop: 'function',
      detectPrincipal: 'function',
      landPr: 'function',
      openPr: 'function',
      run: 'function',
    })
    expect(readFileSync(join(import.meta.dirname, 'SKILL.md'), 'utf8')).toContain('const { run } = await import(')
  })
})

const INPUT = { issue: 494, branch: 'feat/494-feature-back-half', base: 'staging', title: 'feat: back half' }

function created(calls) {
  return calls.filter((args) => args[0] === 'api')
}

function fieldOf(args, key) {
  const i = args.findIndex((arg) => typeof arg === 'string' && arg.startsWith(`${key}=`))
  return i === -1 ? null : args[i].slice(key.length + 1)
}

describe('openPr', () => {
  it('returns the number the client reported, not a number read out of text', async () => {
    const { gh, calls } = mockGh({ create: JSON.stringify({ html_url: 'https://x/pull/999', number: 512 }) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 512, status: 'created' })
    // `html_url` carries a number too, and it comes first in the response: anything
    // that reads digits out of the text rather than the `number` field returns 999.
    expect(created(calls)).toHaveLength(1)
    expect(fieldOf(created(calls)[0], 'head')).toBe('feat/494-feature-back-half')
    expect(fieldOf(created(calls)[0], 'base')).toBe('staging')
  })

  it('links the ticket with a closing keyword the promote harvester reads', async () => {
    const { gh, calls } = mockGh()
    await openPr('/tmp/wt', { ...INPUT, body: 'Back half of the cycle.' }, { gh })
    expect(fieldOf(created(calls)[0], 'body')).toBe('Back half of the cycle.\n\nCloses #494')
  })

  it('does not duplicate a closing keyword the caller already wrote', async () => {
    const { gh, calls } = mockGh()
    await openPr('/tmp/wt', { ...INPUT, body: 'Fixes #494 — the back half.' }, { gh })
    expect(fieldOf(created(calls)[0], 'body')).toBe('Fixes #494 — the back half.')
  })

  it('reuses the PR already open for that head, and opens nothing', async () => {
    // Re-running mode 2 after a crash must not put a second PR on one branch.
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 400 }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(created(calls)).toEqual([])
  })

  it('picks the oldest when the head somehow carries two open PRs', async () => {
    const { gh } = mockGh({ list: JSON.stringify([{ number: 640 }, { number: 400 }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
  })

  it('re-reads instead of failing when another opener wins the race', async () => {
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 401 }])],
      createThrows: 'gh api failed (1): A pull request already exists for Roxabi:feat/494-feature-back-half.',
    })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 401, status: 'existing' })
    expect(created(calls)).toHaveLength(1)
  })

  it('propagates the client error when the create fails for any other reason', async () => {
    const { gh } = mockGh({ createThrows: 'gh api failed (1): HTTP 403 — resource not accessible' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/HTTP 403/)
  })

  it('propagates the client error when the lookup itself fails', async () => {
    const { gh, calls } = mockGh({ listThrows: 'gh pr list failed (1): could not resolve to a Repository' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/could not resolve/)
    expect(created(calls)).toEqual([])
  })

  it('refuses a create response that carries no number', async () => {
    const { gh } = mockGh({ create: JSON.stringify({ html_url: 'https://x/pull/512' }) })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/carried no PR number/)
  })

  it('refuses a create response that is not JSON', async () => {
    const { gh } = mockGh({ create: 'https://github.com/Roxabi/roxabi-plugins/pull/512' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no JSON/)
  })

  it('refuses a lookup response that is not a JSON array, rather than opening a second PR', async () => {
    const { gh, calls } = mockGh({ list: 'no pull requests match your search' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no JSON/)
    expect(created(calls)).toEqual([])
  })

  it('refuses a lookup entry with no number', async () => {
    const { gh, calls } = mockGh({ list: JSON.stringify([{ title: 'feat: back half' }]) })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/no PR number/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['issue', { ...INPUT, issue: 0 }],
    ['issue', { ...INPUT, issue: 'the back half' }],
    ['branch', { ...INPUT, branch: '' }],
    ['base', { ...INPUT, base: undefined }],
    ['title', { ...INPUT, title: '   ' }],
  ])('refuses a missing %s before reaching the client', async (_label, input) => {
    const { gh, calls } = mockGh()
    await expect(openPr('/tmp/wt', input, { gh })).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })
})

describe('createReviewLoop', () => {
  it('lands on the first green without a fix round', () => {
    const loop = createReviewLoop({ pr: 512 })
    expect(loop.record('green')).toEqual({ action: 'land', reviews: 1, fixes: 0 })
  })

  it('lands after one red and one fix', () => {
    const loop = createReviewLoop({ pr: 512 })
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    expect(loop.record('green')).toEqual({ action: 'land', reviews: 2, fixes: 1 })
  })

  it('stops on the third red, naming what the operator now has', () => {
    const loop = createReviewLoop({ pr: 512 })
    expect(loop.record('red').action).toBe('fix')
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    const stop = loop.record('red')
    expect(stop.action).toBe('stop')
    expect(stop).toMatchObject({ reason: 'review-bound', reviews: 3, fixes: 2 })
    expect(stop.message).toContain('PR #512')
    expect(stop.message).toContain('unlabelled and unmerged')
    expect(stop.message).toContain('reviewed')
  })

  it('never yields land after the bound, however many verdicts arrive', () => {
    // The defect: an agent that keeps re-reviewing until something comes back green.
    const loop = createReviewLoop({ pr: 512 })
    loop.record('red')
    loop.record('red')
    expect(loop.record('red').action).toBe('stop')
    expect(() => loop.record('green')).toThrow(/already closed with "stop"/)
    expect(loop.closed).toBe('stop')
  })

  it('refuses a further verdict once it has landed', () => {
    const loop = createReviewLoop()
    expect(loop.record('green').action).toBe('land')
    expect(() => loop.record('red')).toThrow(/already closed with "land"/)
  })

  it('counts rounds itself, so a caller cannot restart them', () => {
    const loop = createReviewLoop()
    loop.record('red')
    loop.record('red')
    expect(loop.reviews).toBe(2)
    expect(loop.fixes).toBe(2)
    expect(loop.record('red').action).toBe('stop')
  })

  it.each(['review: green', 'GREEN ✅', '', 'maybe', null, undefined, 3])(
    'refuses %o as a verdict rather than guessing one',
    (verdict) => {
      const loop = createReviewLoop()
      expect(() => loop.record(verdict)).toThrow(TypeError)
      expect(loop.reviews).toBe(0)
    },
  )

  it('accepts the verdict word whatever its case or padding', () => {
    expect(createReviewLoop().record('  Green ').action).toBe('land')
    expect(createReviewLoop().record('RED').action).toBe('fix')
  })

  it('bounds at two fix rounds', () => {
    expect(MAX_FIX_ROUNDS).toBe(2)
    const loop = createReviewLoop()
    let rounds = 0
    let step = loop.record('red')
    while (step.action === 'fix') {
      rounds++
      step = loop.record('red')
    }
    expect(rounds).toBe(MAX_FIX_ROUNDS)
    expect(step.action).toBe('stop')
  })

  it('says how many rounds are left after each red', () => {
    const loop = createReviewLoop({ maxFixRounds: 1 })
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 0 })
    expect(loop.record('red').action).toBe('stop')
  })

  it('refuses a bound that is not a count', () => {
    expect(() => createReviewLoop({ maxFixRounds: -1 })).toThrow(TypeError)
    expect(() => createReviewLoop({ maxFixRounds: 1.5 })).toThrow(TypeError)
  })
})
