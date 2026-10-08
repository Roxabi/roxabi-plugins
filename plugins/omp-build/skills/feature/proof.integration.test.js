import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOW = join(import.meta.dirname, 'workflow.js')
const BRANCH = 'feat/751-proof'
const ISSUE = 751
const MOVED = 'b'.repeat(40)
const CHECK = { steps: 'open the gate', url: 'https://example.test/gate', observed: 'the gate is shut' }

const DRIVER = `
const [mod, cwd, raw] = process.argv.slice(1)
const scenario = JSON.parse(raw)
const { openPr, landPr } = await import(mod)
const calls = []
let listCall = 0
let commentReads = 0
let headReads = 0
const gh = async (_cwd, args) => {
  calls.push(args)
  if (args[0] === 'api' && args[1] === 'user') return 'omp-bot'
  if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
  if (args[0] === 'pr' && args[1] === 'list') {
    const pages = scenario.list || ['[]']
    const page = pages[Math.min(listCall, pages.length - 1)]
    listCall++
    return page
  }
  if (args[0] === 'api' && args.some((arg) => String(arg).includes('/comments'))) {
    commentReads++
    const moved = scenario.moveAfterCommentReads != null && commentReads > scenario.moveAfterCommentReads
    const bodies = moved ? scenario.movedComments || [] : scenario.comments || []
    return JSON.stringify([bodies.map((body, index) => ({ user: { login: 'omp-bot' }, body, created_at: '2026-01-01T00:00:0' + index + 'Z' }))])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const jsonAt = args.indexOf('--json')
    const fields = String(args[jsonAt + 1] || '').split(',')
    if (fields.includes('body') && scenario.bodyReadThrows) throw new Error('HTTP 502 body')
    const view = {}
    for (const field of fields) {
      if (field === 'body') view.body = scenario.omitBody ? undefined : scenario.body
      if (field === 'headRefName') view.headRefName = scenario.headRefName
      if (field === 'headRefOid') {
        headReads++
        const moved = scenario.moveAfterHeadReads != null && headReads > scenario.moveAfterHeadReads
        view.headRefOid = moved ? scenario.movedHead : scenario.headRefOid
      }
      if (field === 'state') view.state = 'OPEN'
      if (field === 'labels') view.labels = (scenario.labels || []).map((name) => ({ name }))
      if (field === 'autoMergeRequest') view.autoMergeRequest = scenario.auto ? { mergeMethod: 'MERGE' } : null
      if (field === 'baseRefName') view.baseRefName = 'main'
      if (field === 'comments') view.comments = []
    }
    return JSON.stringify(view)
  }
  if (args[0] === 'api' && args.some((arg) => String(arg).includes('pulls'))) {
    if (scenario.createThrows) {
      const error = new Error(scenario.createThrows.message)
      error.exitCode = scenario.createThrows.exitCode
      error.stderr = scenario.createThrows.stderr
      error.status = scenario.createThrows.status
      throw error
    }
    return JSON.stringify({ number: scenario.number || 751 })
  }
  if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')) {
    if (scenario.disarmThrows) throw new Error('label api down')
    scenario.labels = (scenario.labels || []).filter((name) => name !== 'reviewed')
    return ''
  }
  if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
    if (scenario.disarmThrows) throw new Error('disable api down')
    scenario.auto = false
    return ''
  }
  if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')) {
    scenario.labels = [...(scenario.labels || []), 'reviewed']
    return ''
  }
  if (args[0] === 'pr' && args[1] === 'merge') return ''
  throw new Error('unexpected gh ' + args.join(' '))
}
try {
  const result = scenario.fn === 'land'
    ? await landPr(cwd, scenario.pr || 7, {
        gh,
        proof: scenario.proof,
        landing: scenario.landing,
        requiredContexts: scenario.requiredContexts,
        sleep: async () => {},
      })
    : await openPr(cwd, {
        issue: scenario.issue,
        branch: scenario.branch,
        base: scenario.base,
        title: scenario.title,
        body: scenario.bodyInput,
        proof: scenario.proof,
      }, { gh })
  console.log(JSON.stringify({ result, calls, labels: scenario.labels || [], auto: Boolean(scenario.auto) }))
} catch (error) {
  console.log(JSON.stringify({ error: error.message, calls, labels: scenario.labels || [], auto: Boolean(scenario.auto) }))
}
`

function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim()
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function initRepo(files, { branch = BRANCH, dirty } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-751-'))
  const env = gitEnv()
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, env })
  execFileSync('git', ['config', 'user.email', 'proof@test'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.name', 'proof'], { cwd: dir, env })
  writeFiles(dir, files)
  if (Object.keys(files).length) {
    execFileSync('git', ['add', '-A'], { cwd: dir, env })
    execFileSync('git', ['commit', '-qm', 'proof'], { cwd: dir, env })
  } else {
    execFileSync('git', ['commit', '-qm', 'empty', '--allow-empty'], { cwd: dir, env })
  }
  const oid = git(dir, ['rev-parse', 'HEAD'])
  if (dirty) writeFiles(dir, dirty)
  return { dir, oid }
}

function contract(status, issue = ISSUE, id = 'bind-proof') {
  return `change ${id}\n  status: ${status}\n  tag: issue-${issue}\n`
}

function sem(text, extra = {}) {
  return { '.semctx/semantic/changes/bind.sem': text, ...extra }
}

function proofOf(oid, over = {}) {
  return {
    head: oid,
    verify: 'VERIFIED',
    gaps: [],
    noTest: {},
    assertledger: null,
    hasAdapter: false,
    typeFix: false,
    ...over,
  }
}

function uiProof(oid) {
  return proofOf(oid, {
    verify: 'PARTIAL',
    gaps: ['gate'],
    noTest: { gate: 'ui-manual-only' },
    uiChecks: { gate: CHECK },
  })
}

function bodyWithCheck() {
  return `Ships the bind.\n${CHECK.steps}\n${CHECK.url}\n${CHECK.observed}`
}

function review(verdict, sha) {
  return `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${sha} -->\n## Code Review\n\n**Verdict: ${verdict}** — summary`
}

function drive(cwd, scenario) {
  const out = execFileSync('bun', ['-e', DRIVER, WORKFLOW, cwd, JSON.stringify(scenario)], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  })
  return JSON.parse(out)
}

function isCreate(args) {
  return args[0] === 'api' && args.some((arg) => String(arg).includes('pulls'))
}

function postedBody(calls) {
  const create = calls.find(isCreate)
  const field = create?.find((arg) => arg.startsWith('body='))
  return field?.slice('body='.length)
}

function posted(calls) {
  return calls.some(isCreate)
}

function viewedBody(calls) {
  return calls.some((args) => args[0] === 'pr' && args[1] === 'view' && String(args[4] || '').includes('body'))
}

function pinned(calls) {
  return calls.some((args) => args.includes('--match-head-commit'))
}

const OPEN = {
  fn: 'open',
  issue: ISSUE,
  branch: BRANCH,
  base: 'main',
  title: 'feat: bind proof',
}

const LANDING = { mode: 'native', required_checks: ['ci'] }
const E2E = { '.dev/stack.yml': 'commands:\n  test_e2e: bun test e2e\n' }

describe('proof binds to the selected artifact', () => {
  it('creates from the exact bodyFor payload of a verified commit, ignoring a dirty edit', () => {
    const { dir, oid } = initRepo(sem(contract('verified')), {
      dirty: { '.semctx/semantic/changes/bind.sem': contract('active') },
    })
    const bodyInput = 'Ships the bind.'
    const run = drive(dir, { ...OPEN, bodyInput, proof: proofOf(oid) })
    expect(run.result).toEqual({ number: 751, status: 'created' })
    expect(postedBody(run.calls)).toBe(`${bodyInput}\n\nCloses #${ISSUE}`)
    expect(viewedBody(run.calls)).toBe(false)
  })

  it('refuses a branch claiming another ticket even at the proven commit', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const foreign = 'feat/999-other'
    git(dir, ['branch', foreign, oid])
    const run = drive(dir, { ...OPEN, branch: foreign, proof: proofOf(oid) })

    expect(run.result).toMatchObject({ status: 'proof-blocked' })
    expect(run.result.reason).toMatch(/names #999/)
    expect(posted(run.calls)).toBe(false)
  })

  it('publishes manual UI proof only when the submitted body records the browser check', () => {
    const { dir, oid } = initRepo(sem(contract('partial')))
    const proof = uiProof(oid)
    const missing = drive(dir, { ...OPEN, proof, bodyInput: `${CHECK.steps}\n${CHECK.url}` })
    expect(missing.result).toMatchObject({ status: 'proof-blocked' })
    expect(posted(missing.calls)).toBe(false)

    const complete = drive(dir, { ...OPEN, proof, bodyInput: bodyWithCheck() })
    expect(complete.result).toEqual({ number: 751, status: 'created' })
    expect(posted(complete.calls)).toBe(true)
  })

  it('accepts PARTIAL plus a superseded sibling, and refuses an active sibling before create', () => {
    const partial = initRepo(
      sem(`${contract('partial', ISSUE, 'bind')}\nchange old\n  status: superseded\n  tag: issue-${ISSUE}\n`),
    )
    const partialProof = proofOf(partial.oid, {
      verify: 'PARTIAL',
      gaps: ['prompt'],
      noTest: { prompt: 'prompt-logic-only' },
    })
    expect(drive(partial.dir, { ...OPEN, bodyInput: 'Ships.', proof: partialProof }).result).toMatchObject({
      status: 'created',
    })

    const active = initRepo(sem(`${contract('verified')}\nchange sibling\n  status: active\n  tag: issue-${ISSUE}\n`))
    const refused = drive(active.dir, { ...OPEN, bodyInput: 'Ships.', proof: proofOf(active.oid) })
    expect(refused.result).toMatchObject({ status: 'proof-blocked' })
    expect(refused.result.reason).toMatch(/sibling is active/)
    expect(posted(refused.calls)).toBe(false)
  })

  it('disarms an existing PR on a body-independent proof refusal and reports failed clears', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const scenario = {
      ...OPEN,
      list: [JSON.stringify([{ number: 12, isCrossRepository: false }])],
      headRefOid: oid,
      labels: ['reviewed'],
      auto: true,
    }
    const cleared = drive(dir, scenario)
    expect(cleared.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(cleared.labels).toEqual([])
    expect(cleared.auto).toBe(false)
    expect(posted(cleared.calls)).toBe(false)

    const failed = drive(dir, { ...scenario, disarmThrows: true })
    expect(failed.result).toBeUndefined()
    expect(failed.error).toContain('reviewed')
    expect(failed.error).toContain('auto-merge')
    expect(failed.labels).toEqual(['reviewed'])
    expect(failed.auto).toBe(true)
    expect(posted(failed.calls)).toBe(false)
  })

  it('does not let a caller body authorize an existing or 422 body, and disarms the known PR', () => {
    const { dir, oid } = initRepo(sem(contract('partial')))
    const recorded = uiProof(oid)
    const existing = drive(dir, {
      ...OPEN,
      bodyInput: bodyWithCheck(),
      proof: recorded,
      list: [JSON.stringify([{ number: 400, isCrossRepository: false }])],
      body: 'Closes #751',
      labels: ['reviewed'],
      auto: true,
    })
    expect(existing.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(posted(existing.calls)).toBe(false)
    expect(existing.labels).toEqual([])
    expect(existing.auto).toBe(false)

    const raced = drive(dir, {
      ...OPEN,
      bodyInput: bodyWithCheck(),
      proof: recorded,
      list: ['[]', JSON.stringify([{ number: 422, isCrossRepository: false }])],
      body: 'Closes #751',
      labels: ['reviewed'],
      createThrows: {
        message: 'gh api failed (1)',
        exitCode: 1,
        status: 422,
        stderr:
          'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"message":"A pull request already exists for Roxabi:feat/751-proof."}]}',
      },
    })
    expect(raced.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(posted(raced.calls)).toBe(true)
    expect(raced.labels).toEqual([])
  })

  it('treats a missing or unreadable body as proof-blocked, never as an exemption', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const missing = drive(dir, {
      ...OPEN,
      proof: proofOf(oid),
      list: [JSON.stringify([{ number: 12, isCrossRepository: false }])],
      omitBody: true,
    })
    expect(missing.result).toMatchObject({ status: 'proof-blocked' })
    expect(missing.result.reason).toMatch(/not read/)
    expect(posted(missing.calls)).toBe(false)

    const fault = drive(dir, {
      ...OPEN,
      proof: proofOf(oid),
      list: [JSON.stringify([{ number: 12, isCrossRepository: false }])],
      bodyReadThrows: true,
      labels: ['reviewed'],
    })
    expect(fault.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(fault.result.reason).toMatch(/HTTP 502/)
  })

  it('refuses ui-manual-only when the bound commit declares commands.test_e2e', () => {
    const { dir, oid } = initRepo(sem(contract('partial'), E2E))
    const run = drive(dir, { ...OPEN, bodyInput: bodyWithCheck(), proof: uiProof(oid) })
    expect(run.result).toMatchObject({ status: 'proof-blocked' })
    expect(run.result.reason).toMatch(/commands\.test_e2e/)
    expect(posted(run.calls)).toBe(false)
  })

  it('refuses a missing-object ref and a not-repo even when .semctx is ENOENT, and exempts a true unborn branch', () => {
    const env = gitEnv()
    const corrupt = mkdtempSync(join(tmpdir(), 'proof-corrupt-'))
    execFileSync('git', ['init', '-q', '-b', BRANCH], { cwd: corrupt, env })
    execFileSync('git', ['config', 'user.email', 'proof@test'], { cwd: corrupt, env })
    execFileSync('git', ['config', 'user.name', 'proof'], { cwd: corrupt, env })
    writeFileSync(join(corrupt, 'keep.txt'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: corrupt, env })
    execFileSync('git', ['commit', '-qm', 'keep'], { cwd: corrupt, env })
    const dangling = git(corrupt, ['rev-parse', 'HEAD'])
    rmSync(join(corrupt, '.git', 'objects', dangling.slice(0, 2), dangling.slice(2)))
    const corruptRun = drive(corrupt, { ...OPEN, proof: { nope: true } })
    expect(corruptRun.result).toMatchObject({ status: 'proof-blocked' })
    expect(posted(corruptRun.calls)).toBe(false)

    const absent = mkdtempSync(join(tmpdir(), 'proof-absent-'))
    const absentRun = drive(absent, { ...OPEN, proof: proofOf('c'.repeat(40)) })
    expect(absentRun.result).toMatchObject({ status: 'proof-blocked' })
    expect(absentRun.result.reason).toMatch(/no-repo-root/)
    expect(posted(absentRun.calls)).toBe(false)

    const unborn = mkdtempSync(join(tmpdir(), 'proof-unborn-'))
    execFileSync('git', ['init', '-q', '-b', BRANCH], { cwd: unborn, env })
    const unbornRun = drive(unborn, { ...OPEN, bodyInput: 'Ships.', proof: { nope: true } })
    expect(unbornRun.result).toEqual({ number: 751, status: 'created' })
  })

  it('refuses when the local branch tip is not the checkout commit that was proved', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const env = gitEnv()
    execFileSync('git', ['commit', '-qm', 'second', '--allow-empty'], { cwd: dir, env })
    execFileSync('git', ['checkout', '-q', '--detach', oid], { cwd: dir, env })
    const run = drive(dir, { ...OPEN, bodyInput: 'Ships.', proof: proofOf(oid) })
    expect(run.result).toMatchObject({ status: 'proof-blocked' })
    expect(run.result.reason).toMatch(/not the proof head/)
    expect(posted(run.calls)).toBe(false)
  })

  it('throws a clearing failure instead of claiming the existing PR was disarmed', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const run = drive(dir, {
      ...OPEN,
      proof: proofOf(oid),
      list: [JSON.stringify([{ number: 12, isCrossRepository: false }])],
      omitBody: true,
      labels: ['reviewed'],
      disarmThrows: true,
    })
    expect(run.result).toBeUndefined()
    expect(run.error).toMatch(/stays armed — the reviewed label/)
    expect(run.labels).toEqual(['reviewed'])
  })
})

describe('landPr proof after review', () => {
  function landScenario(oid, over = {}) {
    return {
      fn: 'land',
      pr: 7,
      proof: proofOf(oid),
      headRefName: BRANCH,
      headRefOid: oid,
      body: 'Ships the bind.',
      comments: [review('Approve (clean)', oid)],
      landing: LANDING,
      requiredContexts: ['ci'],
      ...over,
    }
  }

  it('refuses a proof for an earlier commit on open and land', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    git(dir, ['commit', '-qm', 'next artifact', '--allow-empty'])
    const current = git(dir, ['rev-parse', 'HEAD'])
    const stale = proofOf(oid)

    const opened = drive(dir, { ...OPEN, proof: stale })
    const landed = drive(dir, landScenario(current, { proof: stale, labels: ['reviewed'], auto: true }))
    expect(opened.result).toMatchObject({ status: 'proof-blocked' })
    expect(opened.result.reason).toMatch(/proof head/)
    expect(posted(opened.calls)).toBe(false)
    expect(landed.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(landed.result.reason).toMatch(/proof head/)
    expect(pinned(landed.calls)).toBe(false)
    expect(landed.labels).toEqual([])
    expect(landed.auto).toBe(false)
  })

  it('does not exempt an ignored empty Semctx working directory on a born commit', () => {
    const { dir, oid } = initRepo({ '.gitignore': '.semctx/\n' })
    mkdirSync(join(dir, '.semctx/working'), { recursive: true })
    const opened = drive(dir, { ...OPEN, proof: proofOf(oid) })
    const landed = drive(dir, landScenario(oid, { labels: ['reviewed'], auto: true }))

    expect(opened.result).toMatchObject({ status: 'proof-blocked' })
    expect(opened.result.reason).toMatch(/no change contract/)
    expect(posted(opened.calls)).toBe(false)
    expect(landed.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(landed.result.reason).toMatch(/no change contract/)
    expect(pinned(landed.calls)).toBe(false)
    expect(landed.labels).toEqual([])
    expect(landed.auto).toBe(false)
  })

  it('refuses contradictory VERIFIED manual gaps before create or landing', () => {
    const { dir, oid } = initRepo(sem(contract('verified'), E2E))
    const contradictory = {
      ...uiProof(oid),
      verify: 'VERIFIED',
      uiChecks: { gate: { steps: '', url: '', observed: '' } },
    }
    const opened = drive(dir, { ...OPEN, bodyInput: '', proof: contradictory })
    const landed = drive(dir, landScenario(oid, { proof: contradictory, body: '', labels: ['reviewed'], auto: true }))

    expect(opened.result).toMatchObject({ status: 'proof-blocked' })
    expect(posted(opened.calls)).toBe(false)
    expect(landed.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(pinned(landed.calls)).toBe(false)
    expect(landed.labels).toEqual([])
    expect(landed.auto).toBe(false)
  })

  it('lands a verified commit and does not read a body when Semctx is absent', () => {
    const proved = initRepo(sem(contract('verified')))
    const passed = drive(proved.dir, landScenario(proved.oid))
    expect(passed.result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(pinned(passed.calls)).toBe(true)
    expect(viewedBody(passed.calls)).toBe(true)

    const bare = initRepo({ 'note.txt': 'no semctx' })
    const exempt = drive(bare.dir, landScenario(bare.oid, { proof: { nope: true } }))
    expect(exempt.result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(viewedBody(exempt.calls)).toBe(false)
  })

  it('refuses a forged or missing land body without pinning, and disarms', () => {
    const { dir, oid } = initRepo(sem(contract('partial')))
    const forged = drive(
      dir,
      landScenario(oid, {
        proof: uiProof(oid),
        body: 'Closes #751',
        labels: ['reviewed'],
        auto: true,
      }),
    )
    expect(forged.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(pinned(forged.calls)).toBe(false)
    expect(forged.labels).toEqual([])
    expect(forged.auto).toBe(false)

    const missing = drive(dir, landScenario(oid, { omitBody: true }))
    expect(missing.result).toMatchObject({ status: 'proof-blocked' })
    expect(missing.result.reason).toMatch(/not read/)
    expect(pinned(missing.calls)).toBe(false)
  })

  it('keeps a spent review ahead of proof and does not read the body', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const red = review('Request changes', oid)
    const run = drive(dir, landScenario(oid, { comments: [red, red, red], body: 'no checks', proof: uiProof(oid) }))
    expect(run.result).toMatchObject({ status: 'not-approved', reason: 'review-bound' })
    expect(viewedBody(run.calls)).toBe(false)
    expect(pinned(run.calls)).toBe(false)
  })

  it('keeps an ordinary red review ahead of a failing applicable proof', () => {
    const { dir, oid } = initRepo(sem(contract('partial')))
    const run = drive(
      dir,
      landScenario(oid, {
        comments: [review('Request changes', oid)],
        proof: uiProof(oid),
        body: 'no browser check',
        labels: ['reviewed'],
        auto: true,
      }),
    )

    expect(run.result).toMatchObject({ status: 'not-approved', reviews: 1, disarmed: true })
    expect(run.result.reason).not.toBe('review-bound')
    expect(viewedBody(run.calls)).toBe(false)
    expect(pinned(run.calls)).toBe(false)
    expect(run.labels).toEqual([])
    expect(run.auto).toBe(false)
  })

  it('does not renew a bound oid when the review and the PR head later advance together', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const run = drive(
      dir,
      landScenario(oid, {
        labels: ['reviewed'],
        moveAfterCommentReads: 2,
        moveAfterHeadReads: 2,
        movedHead: MOVED,
        movedComments: [review('Approve (clean)', MOVED)],
      }),
    )
    expect(run.result).toMatchObject({ status: 'not-approved', reason: 'head-moved', disarmed: true })
    expect(pinned(run.calls)).toBe(true)
    expect(run.calls.some((args) => args.includes('--match-head-commit') && args.at(-1) === MOVED)).toBe(false)
    expect(run.labels).toEqual([])
  })

  it('refuses when checkout HEAD is not the approved oid', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    const env = gitEnv()
    execFileSync('git', ['commit', '-qm', 'second', '--allow-empty'], { cwd: dir, env })
    const tip = git(dir, ['rev-parse', 'HEAD'])
    execFileSync('git', ['checkout', '-q', '--detach', oid], { cwd: dir, env })
    const run = drive(dir, landScenario(tip))
    expect(run.result).toMatchObject({ status: 'proof-blocked' })
    expect(run.result.reason).toMatch(/checkout HEAD/)
    expect(pinned(run.calls)).toBe(false)
  })

  it('refuses an advanced local branch while checkout and approval still match', () => {
    const { dir, oid } = initRepo(sem(contract('verified')))
    git(dir, ['commit', '-qm', 'advanced branch', '--allow-empty'])
    git(dir, ['checkout', '-q', '--detach', oid])
    const run = drive(dir, landScenario(oid, { labels: ['reviewed'], auto: true }))

    expect(run.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(run.result.reason).toMatch(/not the proof head/)
    expect(pinned(run.calls)).toBe(false)
    expect(run.labels).toEqual([])
    expect(run.auto).toBe(false)
  })

  it('uses committed e2e on open and land despite a dirty stack removing it', () => {
    const { dir, oid } = initRepo(sem(contract('partial'), E2E), {
      dirty: { '.dev/stack.yml': 'commands: {}\n' },
    })
    const proof = uiProof(oid)
    const opened = drive(dir, { ...OPEN, proof, bodyInput: bodyWithCheck() })
    const landed = drive(dir, landScenario(oid, { proof, body: bodyWithCheck(), labels: ['reviewed'], auto: true }))

    expect(opened.result).toMatchObject({ status: 'proof-blocked' })
    expect(opened.result.reason).toMatch(/commands\.test_e2e/)
    expect(posted(opened.calls)).toBe(false)
    expect(landed.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
    expect(landed.result.reason).toMatch(/commands\.test_e2e/)
    expect(pinned(landed.calls)).toBe(false)
    expect(landed.labels).toEqual([])
    expect(landed.auto).toBe(false)
  })

  it.each([
    { name: 'contracts', status: 'verified', stack: {}, shadow: 'active', pass: true },
    { name: 'e2e policy', status: 'partial', stack: E2E, shadow: 'partial', pass: false },
  ])('reads root $name from a nested cwd, never shadow artifacts', ({ status, stack, shadow, pass }) => {
    const { dir, oid } = initRepo(
      sem(contract(status), {
        ...stack,
        'nested/.semctx/semantic/changes/shadow.sem': contract(shadow),
      }),
    )
    const cwd = join(dir, 'nested')
    const proof = status === 'verified' ? proofOf(oid) : uiProof(oid)
    const opened = drive(cwd, { ...OPEN, proof, bodyInput: bodyWithCheck() })
    const landed = drive(cwd, landScenario(oid, { proof, body: bodyWithCheck(), labels: ['reviewed'], auto: true }))

    if (pass) {
      expect(opened.result).toMatchObject({ status: 'created' })
      expect(posted(opened.calls)).toBe(true)
      expect(landed.result).toMatchObject({ status: 'watching', mode: 'native' })
      expect(pinned(landed.calls)).toBe(true)
    } else {
      expect(opened.result).toMatchObject({ status: 'proof-blocked' })
      expect(opened.result.reason).toMatch(/commands\.test_e2e/)
      expect(posted(opened.calls)).toBe(false)
      expect(landed.result).toMatchObject({ status: 'proof-blocked', disarmed: true })
      expect(landed.result.reason).toMatch(/commands\.test_e2e/)
      expect(pinned(landed.calls)).toBe(false)
      expect(landed.labels).toEqual([])
      expect(landed.auto).toBe(false)
    }
  })
})
