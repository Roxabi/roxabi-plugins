import { describe, expect, it } from 'vitest'
import {
  createReviewLoop,
  MAX_FIX_ROUNDS,
  openPr,
  parseReviewRounds,
  readReviewRounds,
  resumeReviewLoop,
} from './workflow.js'

/**
 * Every call goes through an injected client. Nothing here can reach a real `gh`,
 * so no test can open, label or merge a pull request — the same posture
 * `land.test.js` takes with `landPr(cwd, pr, { gh })`.
 */
function ghError(spec) {
  if (typeof spec === 'string') return new Error(spec)
  const { message, ...payload } = spec
  return Object.assign(new Error(message), payload)
}

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
      if (listThrows) throw ghError(listThrows)
      const responses = Array.isArray(list) ? list : [list]
      const response = responses[Math.min(listCall, responses.length - 1)]
      listCall++
      return response
    }
    if (args[0] === 'api') {
      if (createThrows) throw ghError(createThrows)
      return create
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls }
}

/**
 * The client the loop drives: label and auto-merge read-back, their removal, the
 * round marker. Injected, like every other client here — nothing labels or merges a
 * real PR.
 */
function mockLoopGh({ labels = [], comments = [], autoMerge = null } = {}) {
  const calls = []
  const present = new Set(labels)
  const posted = [...comments]
  const state = { autoMerge }
  const gh = async (_cwd, args) => {
    calls.push(args)
    const fields = args[0] === 'pr' && args[1] === 'view' ? (args.at(-1) ?? '').split(',') : []
    if (fields.includes('labels')) {
      return JSON.stringify({ labels: [...present].map((name) => ({ name })), autoMergeRequest: state.autoMerge })
    }
    if (fields.includes('comments')) {
      return JSON.stringify({ comments: posted.map((body) => ({ body })) })
    }
    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')) {
      present.delete(args[args.indexOf('--remove-label') + 1])
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
      state.autoMerge = null
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      posted.push(args[args.indexOf('--body') + 1])
      return ''
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls, labels: present, comments: posted, state }
}

const INPUT = { issue: 494, branch: 'feat/494-feature-back-half', base: 'staging', title: 'feat: back half' }

/**
 * The idempotency key, spelled out. `openPr` never opens a second PR *because* this is
 * the lookup it makes: a wrong `--head`, a dropped `--base`, `--state all` or a `--json`
 * without `number` each turn "one already open" into "none open", and the next answer is
 * a duplicate PR. So the argv is asserted element by element, not just its effect.
 */
const LOOKUP = ['pr', 'list', '--head', INPUT.branch, '--base', INPUT.base, '--state', 'open', '--json', 'number']

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
    expect(calls).toEqual([LOOKUP])
  })

  it('picks the oldest when the head somehow carries two open PRs', async () => {
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 640 }, { number: 400 }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(calls).toEqual([LOOKUP])
  })

  it('re-reads on GitHub\u2019s own 422, classified on the exit payload', async () => {
    // The realistic client failure: `gh` exits non-zero with the API's JSON body.
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 402 }])],
      createThrows: {
        message: 'gh api --method POST repos/{owner}/{repo}/pulls … failed (1)',
        exitCode: 1,
        stderr:
          'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"message":"A pull request already exists for Roxabi:feat/494-feature-back-half."}]}',
      },
    })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 402, status: 'existing' })
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP, LOOKUP])
  })

  it('does not read the race out of the title it was handed', async () => {
    // The rendered message embeds the argv, and the argv carries `title=`/`body=` —
    // caller input. A PR whose own title says "a pull request already exists" must not
    // be able to turn an unrelated 403 into a race, and re-look-up a PR that is not
    // there: the failure has to propagate.
    const input = { ...INPUT, title: 'fix: a pull request already exists on re-entry' }
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 403 }])],
      createThrows:
        'gh api --method POST … -f title=fix: a pull request already exists on re-entry failed (1): HTTP 403 — resource not accessible by integration',
    })
    await expect(openPr('/tmp/wt', input, { gh })).rejects.toThrow(/resource not accessible/)
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP])
  })

  it('does not read the race out of the body it was handed', async () => {
    const body = 'Re-entry is safe: a pull request already exists for this head, and openPr reuses it.'
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 404 }])],
      createThrows: {
        message: 'gh api --method POST … failed (1): gh: Not Found (HTTP 404)',
        stderr: 'gh: Not Found (HTTP 404)',
      },
    })
    await expect(openPr('/tmp/wt', { ...INPUT, body }, { gh })).rejects.toThrow(/HTTP 404/)
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP])
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

  it('refuses a lookup response that is not JSON at all, rather than opening a second PR', async () => {
    const { gh, calls } = mockGh({ list: 'no pull requests match your search' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no JSON/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['null', 'null'],
    ['a single object', '{"number":400}'],
  ])('refuses a lookup response that parses but is not an array (%s)', async (_label, list) => {
    // `null` and a bare object both survive `JSON.parse`; only the array check stops
    // them, and "not an array" read as "none open" opens the duplicate.
    const { gh, calls } = mockGh({ list })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no array/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['no number field', JSON.stringify([{ title: 'feat: back half' }])],
    ['a zero', '[{"number":0}]'],
    ['a negative number', '[{"number":-4}]'],
  ])('refuses a lookup entry with %s', async (_label, list) => {
    const { gh, calls } = mockGh({ list })
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

describe('the bound, measured on the PR rather than on the object', () => {
  const stopped = (options) => {
    const loop = createReviewLoop({ pr: 512, ...options })
    loop.record('red')
    loop.record('red')
    const step = loop.record('red')
    return { loop, step }
  }

  it('removes a `reviewed` label it finds on a stopped PR, and says it did', async () => {
    // The label is half of what `stop` promises: auto-merge.yml turns it into
    // `gh pr merge --auto --merge`. A stop that only *says* "unlabelled" while the
    // label sits on the PR is the merge the bound exists to prevent.
    const { loop } = stopped()
    const { gh, calls, labels } = mockLoopGh({ labels: ['reviewed', 'size:F-full'] })
    const outcome = await loop.enforceStop('/tmp/wt', { gh })
    expect(outcome.removed).toBe(true)
    expect([...labels]).toEqual(['size:F-full'])
    expect(calls).toEqual([
      ['pr', 'view', '512', '--json', 'labels,autoMergeRequest'],
      ['pr', 'edit', '512', '--remove-label', 'reviewed'],
    ])
    expect(outcome.message).toContain('unlabelled and unmerged')
    expect(outcome.message).toContain('removed')
  })

  it('disables native auto-merge left on a stopped PR, label first', async () => {
    // Once enabled, GitHub's auto-merge outlives the label: removing `reviewed` alone
    // leaves a PR that the next green run merges, under a message saying it will not.
    const { loop } = stopped()
    const { gh, calls, labels, state } = mockLoopGh({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const outcome = await loop.enforceStop('/tmp/wt', { gh })
    expect(outcome).toMatchObject({ removed: true, autoMergeDisabled: true })
    expect([...labels]).toEqual([])
    expect(state.autoMerge).toBe(null)
    expect(calls.slice(1)).toEqual([
      ['pr', 'edit', '512', '--remove-label', 'reviewed'],
      ['pr', 'merge', '512', '--disable-auto'],
    ])
    expect(outcome.message).toContain('Auto-merge was enabled on PR #512 — disabled.')
  })

  it('touches nothing when the stopped PR carries neither label nor auto-merge', async () => {
    const { loop, step } = stopped()
    const { gh, calls } = mockLoopGh({ labels: ['size:F-full'] })
    const outcome = await loop.enforceStop('/tmp/wt', { gh })
    expect(outcome).toMatchObject({ removed: false, autoMergeDisabled: false, labels: ['size:F-full'] })
    expect(calls).toEqual([['pr', 'view', '512', '--json', 'labels,autoMergeRequest']])
    expect(outcome.message).toBe(step.message)
  })

  it('refuses to enforce a stop that has not happened', async () => {
    const loop = createReviewLoop({ pr: 512 })
    const { gh, calls } = mockLoopGh()
    await expect(loop.enforceStop('/tmp/wt', { gh })).rejects.toThrow(/only follows a stop/)
    loop.record('green')
    await expect(loop.enforceStop('/tmp/wt', { gh })).rejects.toThrow(/only follows a stop/)
    expect(calls).toEqual([])
  })

  it('fails closed when the label read-back is not the shape promised', async () => {
    const { loop } = stopped()
    const gh = async () => 'gh: could not find pull request'
    await expect(loop.enforceStop('/tmp/wt', { gh })).rejects.toThrow(/returned no JSON/)
  })
})

describe('ci-failed after a green verdict', () => {
  it('re-opens the loop by spending a fix round, never by refunding one', () => {
    // §6.7's ci-failed row, executed: green → land → landPr says ci-failed → back to
    // §6.5. `record` on a closed loop throws, so without `reopen` the only move an
    // agent finds is a new loop — which hands the same PR two fresh rounds.
    const loop = createReviewLoop({ pr: 512 })
    expect(loop.record('red')).toMatchObject({ action: 'fix', fixes: 1 })
    expect(loop.record('green').action).toBe('land')

    const back = loop.reopen('ci-failed')
    expect(back).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0, reason: 'ci-failed' })
    expect(loop.closed).toBe(null)

    // The bound still holds on the far side of the CI failure.
    expect(loop.record('green').action).toBe('land')
    const spent = loop.reopen('ci-failed')
    expect(spent.action).toBe('stop')
    expect(spent.reason).toBe('ci-failed')
    expect(spent.fixes).toBe(MAX_FIX_ROUNDS)
    expect(spent.message).toContain('unlabelled and unmerged')
    expect(() => loop.record('green')).toThrow(/already closed with "stop"/)
  })

  it('costs a round even when every verdict so far was green', () => {
    const loop = createReviewLoop({ pr: 512 })
    loop.record('green')
    expect(loop.reopen('ci-failed')).toMatchObject({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
  })

  it('only re-opens a landing, and only for a CI failure', () => {
    const landed = createReviewLoop({ pr: 512 })
    expect(() => landed.reopen('timeout')).toThrow(TypeError)
    expect(() => createReviewLoop().reopen('ci-failed')).toThrow(/only follows a green verdict/)
    const red = createReviewLoop()
    red.record('red')
    expect(() => red.reopen('ci-failed')).toThrow(/only follows a green verdict/)
  })
})

describe('the count outlives the process that holds it', () => {
  it('reads the rounds a PR already carries', () => {
    expect(parseReviewRounds('nothing here')).toBe(null)
    expect(parseReviewRounds('<!-- omp-build:review-rounds reviews=3 fixes=2 -->')).toEqual({ reviews: 3, fixes: 2 })
  })

  it('takes the highest marker, so re-posting an old one refunds nothing', () => {
    const text = [
      '<!-- omp-build:review-rounds reviews=2 fixes=2 -->',
      'later, a stale copy of the first round:',
      '<!-- omp-build:review-rounds reviews=1 fixes=1 -->',
    ].join('\n')
    expect(parseReviewRounds(text)).toEqual({ reviews: 2, fixes: 2 })
  })

  it('resumes a loop on its last round instead of handing out two fresh ones', async () => {
    const { gh } = mockLoopGh({
      comments: ['## Review Fixes Applied', '<!-- omp-build:review-rounds reviews=2 fixes=2 -->\nReview bound: …'],
    })
    const loop = await resumeReviewLoop('/tmp/wt', { pr: 512, gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, remaining: loop.remaining }).toEqual({
      reviews: 2,
      fixes: 2,
      remaining: 0,
    })
    expect(loop.record('red').action).toBe('stop')
  })

  it('starts at zero on a PR that has never been reviewed', async () => {
    const { gh } = mockLoopGh({ comments: ['a plain review comment'] })
    const loop = await resumeReviewLoop('/tmp/wt', { pr: 512, gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes }).toEqual({ reviews: 0, fixes: 0 })
  })

  it('writes the count back after a verdict, where the next session can read it', async () => {
    const { gh, comments } = mockLoopGh()
    const loop = createReviewLoop({ pr: 512, gh })
    loop.record('red')
    await loop.persist('/tmp/wt')
    expect(parseReviewRounds(comments.join('\n'))).toEqual({ reviews: 1, fixes: 1 })

    const resumed = await resumeReviewLoop('/tmp/wt', { pr: 512, gh })
    expect({ reviews: resumed.reviews, fixes: resumed.fixes }).toEqual({ reviews: 1, fixes: 1 })
  })

  it('fails closed rather than reading a bad answer as "no rounds spent"', async () => {
    const gh = async () => 'gh: not found'
    await expect(readReviewRounds('/tmp/wt', 512, { gh })).rejects.toThrow(/returned no JSON/)
    await expect(resumeReviewLoop('/tmp/wt', { pr: 512, gh })).rejects.toThrow(/returned no JSON/)
    const noComments = async () => JSON.stringify({ labels: [] })
    await expect(readReviewRounds('/tmp/wt', 512, { gh: noComments })).rejects.toThrow(/carried no comments/)
  })

  it('refuses seeded counts that are not counts', () => {
    expect(() => createReviewLoop({ pr: 512, fixes: -1 })).toThrow(TypeError)
    expect(() => createReviewLoop({ pr: 512, reviews: 1.5 })).toThrow(TypeError)
  })
})
