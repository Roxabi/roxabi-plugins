/**
 * The landing admission (#768) through the real `landPr`, run by bun in a
 * disposable repository whose `gh` is `gh-simulator.ts`. The proof records are
 * the PR comments `proof-acquire.ts` posted when it ran the real producers
 * (Semctx 0.4.2, assertledger 1.4.0) against the same repositories:
 * `__fixtures__/proof/capture.ts` rebuilds them and conserves each comment in
 * `records.json`, and the sandbox reproduces every commit sha byte for byte.
 * `semctx` and `assertledger` on PATH log and fail: admission must never call them.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BOTH_CASE,
  type Box,
  bothSpec,
  git,
  IGNORED_CASE,
  ignoredSpec,
  LEDGER_CASES,
  ledgerSpec,
  plainSpec,
  readSim,
  SEMCTX_CASES,
  SEMCTX_CONFIG,
  SIM,
  STACK,
  STACK_E2E,
  sandbox,
  semctxSpec,
  WORKFLOW,
  worktree,
  writeSim,
} from './__fixtures__/proof/sandbox'
import type { SemctxRecord } from './proof'
import { findRecord, proofMark, renderRecord } from './proof'

type Captured = { code: number | null; stdout: string; stderr: string; record?: string[] }
type Capture = { sha: Record<string, string>; records: Record<string, Captured> }
type Records = { semctx: Capture; ignored: Capture; assertledger: Capture; both: Capture }
const RECORDS: Records = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '__fixtures__/proof/records.json'), 'utf8'),
)
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const ME = 'operator'
const GAP = 'proof.fx.add-test'

type Land = {
  status: string
  mode?: string
  reason?: string
  producer?: string
  error?: string
  disarmed?: true
  reviews?: number
  proof?: unknown
}

const review = (sha: string, verdict: string) =>
  `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${sha} -->\n## Code Review\n\n**Verdict: ${verdict}** — summary`
const approve = (sha: string) => review(sha, 'Approve (clean)')
const red = (sha: string) => review(sha, 'Request changes')

/** The proof comments a capture run posted, in order: one, or every part of a multipart record. */
function conserved(capture: Capture, name: string): string[] {
  const record = capture.records[name]?.record
  if (!record) throw new Error(`records.json holds no ${name} record — re-run __fixtures__/proof/capture.ts`)
  return record
}

/** Producer stand-ins that log any call and fail. */
function instrument(box: Box): void {
  const dir = path.join(box.root, 'producers')
  mkdirSync(dir)
  for (const name of ['semctx', 'assertledger']) {
    const file = path.join(dir, name)
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${path.join(box.root, 'producer-calls.log')}'\nexit 99\n`)
    chmodSync(file, 0o755)
  }
  box.env.PATH = `${dir}:${box.env.PATH}`
}

function producerCalls(box: Box): string[] {
  const log = path.join(box.root, 'producer-calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}

function prepare(
  box: Box,
  pr: number,
  { comments, body = 'Closes #1\n', armed = null }: { comments: string[]; body?: string; armed?: string | null },
): void {
  writeSim(box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error(`no PR ${pr}`)
    pull.comments = comments.map((text) => ({ author: ME, body: text }))
    pull.body = body
    pull.lastEditedAt = null
    pull.labels = armed ? ['reviewed'] : []
    pull.autoMerge = armed ? { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: armed } : null
  })
}

/** The real `landPr`, forked under bun, and what it did to the simulated PR. */
function land(box: Box, cwd: string, pr: number, mode?: 'native' | 'merge-on-green') {
  const before = readSim(box).calls.length
  const payload = { pr, ...(mode && { landing: { mode, required_checks: ['ci'] } }) }
  const out = spawnSync(REAL_BUN, [WORKFLOW, 'landPr', cwd, JSON.stringify(payload)], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`landPr exited ${out.status}: ${out.stderr}`)
  const state = readSim(box)
  const pull = state.prs[String(pr)]
  const result: Land = JSON.parse(out.stdout)
  return {
    result,
    calls: state.calls.slice(before),
    gate: { labels: pull?.labels, autoMerge: pull?.autoMerge ?? null },
    producers: producerCalls(box),
  }
}

/** Change an external input after gh has read it, while the real caller awaits its reply. */
function mutateAfter(
  box: Box,
  when:
    | 'body-read'
    | 'label-write'
    | 'admission-comments'
    | 'classification-read'
    | 'pin-write'
    | 'disable-write'
    | 'remove-label-write',
  change: string,
  failClear?: '--disable-auto' | '--remove-label',
): () => void {
  const dir = mkdtempSync(path.join(box.root, 'gh-move-'))
  const originalPath = box.env.PATH
  const once = path.join(dir, 'changed')
  const shim = path.join(dir, 'gh')
  writeFileSync(
    shim,
    `#!${REAL_BUN}
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (${JSON.stringify(failClear ?? '')} && args.includes(${JSON.stringify(failClear ?? '')}) && existsSync(${JSON.stringify(once)})) {
  process.stderr.write('injected clear failure\\n')
  process.exit(1)
}
const out = spawnSync(${JSON.stringify(REAL_BUN)}, [${JSON.stringify(SIM)}, ...args], { env: process.env, encoding: 'utf8' })
const query = args.find((arg) => arg.startsWith('query=')) ?? ''
const comments = args.some((arg) => arg.endsWith('/comments'))
const countFile = ${JSON.stringify(path.join(dir, 'comment-reads'))}
const count = comments ? (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1 : 0
if (comments) writeFileSync(countFile, String(count))
const when = ${JSON.stringify(when)}
const matches = when === 'body-read' ? query.includes('lastEditedAt')
  : when === 'classification-read' ? query.includes('issueType')
  : when === 'admission-comments' ? comments && count === 2
  : when === 'pin-write' ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')
  : when === 'disable-write' ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')
  : when === 'remove-label-write' ? args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')
  : args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')
if (out.status === 0 && matches && !existsSync(${JSON.stringify(once)})) {
  const state = JSON.parse(readFileSync(process.env.GH_SIM_STATE, 'utf8'))
  ${change}
  writeFileSync(process.env.GH_SIM_STATE, JSON.stringify(state))
  writeFileSync(${JSON.stringify(once)}, 'changed\\n')
}
process.stdout.write(out.stdout)
process.stderr.write(out.stderr)
process.exit(out.status ?? 1)
`,
  )
  chmodSync(shim, 0o755)
  box.env.PATH = `${dir}:${originalPath}`
  return () => {
    box.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}

const UNARMED = { labels: [], autoMerge: null }
const noTest = (reason: string) =>
  `Closes #1\n\n| Gap | Why | Proof |\n|---|---|---|\n| \`${GAP}\` | finite inputs | ⚠ NO TEST — ${reason} |\n`
const browser = ({
  heading = `\`${GAP}\``,
  steps = 'open the calculator, add 1 and Infinity',
  url = 'http://localhost:3000/add',
  observed = 'RangeError shown',
} = {}) =>
  `${noTest('ui-manual-only')}\n### Browser check ${heading}\n- Steps: ${steps}\n- URL: ${url}\n- Observed: ${observed}\n`

describe('landPr retains the selected base name and tip', () => {
  let box: Box
  let wt: string
  const pr = 30
  const first = 'fix/5-plain'
  const next = 'fix/5-next'
  const head = () => box.sha[first] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        { name: next, from: first, commits: [{ message: 'fix: next (#5)', files: { 'NOTE.md': 'next\n' } }] },
        {
          name: 'staging',
          from: 'main',
          commits: [
            {
              message: 'chore: staging policy',
              files: {
                '.dev/stack.yml': 'landing:\n  mode: merge-on-green\n  required_checks:\n    - staging-ci\n',
                '.semctx/config.json': SEMCTX_CONFIG,
                'assertledger.config.json': '{}\n',
              },
            },
          ],
        },
      ],
    })
    instrument(box)
    wt = worktree(box, 'base-bound', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  function reset(armed: boolean): void {
    git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    git(box, wt, ['checkout', '-q', '--detach', head()])
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('no plain PR')
      pull.baseRefName = 'main'
      pull.headRefName = first
    })
    prepare(box, pr, { comments: [approve(head())], body: 'Closes #5\n', armed: armed ? head() : null })
  }

  it.each([
    ['native', 'admission-comments', false],
    ['merge-on-green', 'admission-comments', false],
    ['native', 'pin-write', false],
    ['native', 'disable-write', true],
    ['merge-on-green', 'remove-label-write', true],
    ['native', 'label-write', false],
    ['merge-on-green', 'label-write', false],
  ] as const)('%s refuses a base retarget after %s (previous arm: %s)', (mode, when, armed) => {
    reset(armed)
    const restore = mutateAfter(box, when, `state.prs[${pr}].baseRefName = 'staging';`)
    try {
      const { result, gate, calls, producers } = land(box, wt, pr, mode)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(result.error).toContain(`staging@${box.sha.staging}`)
      expect(result.error).toContain(`main@${box.sha.main}`)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
      if (when === 'admission-comments' || when === 'disable-write' || when === 'remove-label-write') {
        expect(calls.some((args) => args.includes('--add-label'))).toBe(false)
        if (!armed) expect(calls.some((args) => args.includes('--auto'))).toBe(false)
      }
    } finally {
      restore()
    }
  })

  it.each([
    ['native', 'disable-write'],
    ['merge-on-green', 'remove-label-write'],
  ] as const)('%s cannot re-admit a freshly approved H2 against the old base after %s', (mode, when) => {
    reset(true)
    const h2 = box.sha[next] as string
    const restore = mutateAfter(
      box,
      when,
      `
      state.prs[${pr}].baseRefName = 'staging';
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      state.prs[${pr}].comments.push({ author: ${JSON.stringify(ME)}, body: ${JSON.stringify(approve(h2))} });
      const checkout = spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'checkout', '-q', '--detach', ${JSON.stringify(h2)}], { env: process.env, encoding: 'utf8' });
      if (checkout.status !== 0) throw new Error(checkout.stderr);
    `,
    )
    try {
      const { result, gate, producers } = land(box, wt, pr, mode)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(result.error).toContain(`staging@${box.sha.staging}`)
      expect(result.error).toContain(`main@${box.sha.main}`)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
      expect(git(box, wt, ['rev-parse', 'HEAD'])).toBe(h2)
    } finally {
      restore()
    }
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a same-name base whose authoritative tip moved',
    (mode) => {
      reset(false)
      const restore = mutateAfter(
        box,
        'label-write',
        `
      const moved = spawnSync('git', ['--git-dir', ${JSON.stringify(box.origin)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.staging)}], { env: process.env, encoding: 'utf8' });
      if (moved.status !== 0) throw new Error(moved.stderr);
    `,
      )
      try {
        const { result, gate, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
        expect(result.error).toContain(`main@${box.sha.staging}`)
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
      } finally {
        restore()
        git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
      }
    },
  )

  it.each(['native', 'merge-on-green'] as const)('%s refuses a selected base with no readable tip', (mode) => {
    reset(false)
    const restore = mutateAfter(box, 'label-write', `state.prs[${pr}].baseRefName = 'missing';`)
    try {
      const { result, gate, producers } = land(box, wt, pr, mode)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
      expect(result.error).toMatch(/base.*(missing|readable|coordinate|tip)/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('landPr admission against conserved Semctx records', () => {
  const extraPrs = [
    // Same head as #11: a record conserved for #11 does not bind #17.
    { number: 17, branch: SEMCTX_CASES.verified.branch, title: 'fix: finite add', body: 'Closes #1\n', closes: [1] },
    // #18's head is a commit on top of #11's candidate.
    { number: 18, branch: 'fix/1-moved', title: 'fix: finite add', body: 'Closes #1\n', closes: [1] },
    // #50 relaxes the base's blocking rules, #51 removes the base's Semctx configuration.
    { number: 50, branch: 'fix/1-relaxed', title: 'fix: finite add', body: 'Closes #1\n', closes: [1] },
    { number: 51, branch: 'fix/1-unconfigured', title: 'fix: finite add', body: 'Closes #1\n', closes: [1] },
  ]
  let box: Box
  const wt: Record<string, string> = {}
  const sha = (branch: string) => box.sha[branch] as string

  beforeAll(() => {
    const spec = semctxSpec()
    const verified = SEMCTX_CASES.verified.branch
    const relaxed = SEMCTX_CONFIG.replaceAll('"block"', '"warn"')
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: 'fix/1-moved',
          from: verified,
          commits: [{ message: 'docs: note (#1)', files: { 'NOTES.md': 'finite only\n' } }],
        },
        {
          name: 'fix/1-relaxed',
          from: verified,
          commits: [{ message: 'chore: warn only (#1)', files: { '.semctx/config.json': relaxed } }],
        },
        {
          name: 'fix/1-unconfigured',
          from: verified,
          commits: [{ message: 'chore: drop semctx (#1)', files: { '.semctx': null } }],
        },
      ],
      prs: [...spec.prs, ...extraPrs],
    })
    for (const [branch, value] of Object.entries(RECORDS.semctx.sha)) {
      if (box.sha[branch] !== value)
        throw new Error(`${branch} rebuilt as ${box.sha[branch]}, recorded ${value}: re-run capture.ts`)
    }
    instrument(box)
    for (const [name, { branch }] of Object.entries(SEMCTX_CASES)) wt[name] = worktree(box, name, sha(branch))
    wt.moved = worktree(box, 'moved', sha('fix/1-moved'))
    wt.relaxed = worktree(box, 'relaxed', sha('fix/1-relaxed'))
    wt.unconfigured = worktree(box, 'unconfigured', sha('fix/1-unconfigured'))
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('admits a VERIFIED record of the candidate with no producer call, then pins that candidate', () => {
    const { pr, branch } = SEMCTX_CASES.verified
    prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'verified')] })
    const { result, calls, gate, producers } = land(box, wt.verified as string, pr)
    expect(result).toMatchObject({
      status: 'watching',
      mode: 'native',
      proof: {
        semctx: { verdict: 'VERIFIED', changes: [{ id: 'change.fx.add', verdict: 'VERIFIED' }], gaps: [] },
        assertledger: 'not-applicable',
      },
    })
    expect(gate).toEqual({ labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: sha(branch) }) })
    expect(producers).toEqual([])
    expect(calls.filter((args) => args[1] === 'comment')).toEqual([])
  })

  it('retains an unchanged VERIFIED input under merge-on-green without producing it again', () => {
    const { pr, branch } = SEMCTX_CASES.verified
    prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'verified')] })
    const { result, gate, producers } = land(box, wt.verified as string, pr, 'merge-on-green')
    expect(result).toMatchObject({
      status: 'watching',
      mode: 'merge-on-green',
      proof: { semctx: { verdict: 'VERIFIED' } },
    })
    expect(gate).toEqual({ labels: ['reviewed'], autoMerge: null })
    expect(producers).toEqual([])
  })

  it('Semctx working state on disk in the operator checkout grants nothing and refuses nothing', () => {
    // The verified contract as an ignored active-change pointer: Semctx reading this checkout would let
    // it override the committed PARTIAL contract. Admission reads the record of a clean checkout instead.
    const overlay = git(box, box.principal, [
      'show',
      `${sha(SEMCTX_CASES.verified.branch)}:.semctx/semantic/changes/change.fx.add.sem`,
    ])
    const dirs = [wt.partial, wt.verified] as string[]
    for (const dir of dirs) {
      mkdirSync(path.join(dir, '.semctx', 'working'), { recursive: true })
      writeFileSync(path.join(dir, '.semctx', 'working', 'active-change.sem'), overlay)
    }
    try {
      const partial = SEMCTX_CASES.partial
      prepare(box, partial.pr, { comments: [approve(sha(partial.branch)), ...conserved(RECORDS.semctx, 'partial')] })
      const grants = land(box, wt.partial as string, partial.pr)
      expect(grants.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(grants.gate).toEqual(UNARMED)

      const verified = SEMCTX_CASES.verified
      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified')] })
      const refuses = land(box, wt.verified as string, verified.pr)
      expect(refuses.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
      expect([...grants.producers, ...refuses.producers]).toEqual([])
    } finally {
      for (const dir of dirs) rmSync(path.join(dir, '.semctx', 'working'), { recursive: true, force: true })
    }
  })

  describe('a PARTIAL record admits only when every gap carries one closed-enum NO TEST reason in the PR body', () => {
    const { pr, branch } = SEMCTX_CASES.partial
    it.each([
      ['out-of-scope', noTest('out-of-scope'), 'out-of-scope'],
      ['ui-manual-only with its browser check', browser(), 'ui-manual-only'],
      ['ui-manual-only with its browser check headed by the bare gap', browser({ heading: GAP }), 'ui-manual-only'],
    ])('%s admits PARTIAL and reports the gap', (_label, body, reason) => {
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')], body })
      const { result, gate, producers } = land(box, wt.partial as string, pr)
      expect(result).toMatchObject({
        status: 'watching',
        proof: {
          semctx: {
            verdict: 'PARTIAL',
            changes: [{ id: 'change.fx.add', verdict: 'PARTIAL' }],
            gaps: [{ gap: GAP, reason }],
          },
        },
      })
      expect(gate.labels).toEqual(['reviewed'])
      expect(producers).toEqual([])
    })

    it.each([
      ['no NO TEST row', 'Closes #1\n', /has no NO TEST row/],
      ['a reason outside the closed enum', noTest('flaky'), /"flaky", outside infra-not-wired/],
      [
        'two conflicting rows',
        `${noTest('out-of-scope')}| \`${GAP}\` | again | ⚠ NO TEST — infra-not-wired |\n`,
        /conflicting/,
      ],
      ['ui-manual-only with blank steps', browser({ steps: '' }), /lacks steps/],
      ['ui-manual-only with no observed result', browser({ observed: ' ' }), /lacks the observed result/],
      [
        'ui-manual-only with a URL that is not http(s)',
        browser({ url: 'localhost:3000/add' }),
        /lacks a valid http\(s\) URL/,
      ],
      ['ui-manual-only with no browser check', noTest('ui-manual-only'), /lacks the browser check block/],
      [
        'ui-manual-only whose browser check names another gap',
        browser({ heading: 'proof.fx.other-test' }),
        /lacks the browser check block/,
      ],
    ])('%s refuses, unarmed', (_label, body, error) => {
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')], body })
      const { result, gate } = land(box, wt.partial as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(result.error).toMatch(error)
      expect(gate).toEqual(UNARMED)
    })

    it('a justification edited into the body after the approving review refuses until a review follows the edit', () => {
      const dir = wt.partial as string
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')] })
      const file = path.join(box.root, 'edited-body.md')
      writeFileSync(file, browser())
      execFileSync('gh', ['pr', 'edit', String(pr), '--body-file', file], { cwd: dir, env: box.env })
      const edited = land(box, dir, pr)
      expect(edited.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(edited.result.error).toMatch(/edited at \S+, not before the review record that approved/)
      expect(edited.gate).toEqual(UNARMED)
      execFileSync('gh', ['pr', 'comment', String(pr), '--body', approve(sha(branch))], { cwd: dir, env: box.env })
      const reviewed = land(box, dir, pr)
      expect(reviewed.result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: 'PARTIAL', gaps: [{ gap: GAP, reason: 'ui-manual-only' }] } },
      })
      expect([...edited.producers, ...reviewed.producers]).toEqual([])
    })

    it.each([
      ['native', 'body-read'],
      ['merge-on-green', 'body-read'],
      ['native', 'label-write'],
      ['merge-on-green', 'label-write'],
    ] as const)('%s refuses a PARTIAL body edited after %s at the same approved head', (mode, when) => {
      prepare(box, pr, {
        comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')],
        body: noTest('out-of-scope'),
      })
      const restore = mutateAfter(
        box,
        when,
        `state.prs[${pr}].lastEditedAt = '2027-01-01T00:00:00Z'; state.prs[${pr}].body = 'Closes #1\\n';`,
      )
      try {
        const { result, gate, calls, producers } = land(box, wt.partial as string, pr, mode)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        if (when === 'body-read') {
          expect(calls.some((args) => args.includes('--auto') || args.includes('--add-label'))).toBe(false)
        }
      } finally {
        restore()
      }
    })

    it.each([
      ['native', 'body-read'],
      ['merge-on-green', 'body-read'],
      ['native', 'label-write'],
      ['merge-on-green', 'label-write'],
    ] as const)('%s refuses a newer same-head record with a STALE native response after %s', (mode, when) => {
      const parts = conserved(RECORDS.semctx, 'partial')
      const found = findRecord(
        parts.map((body) => ({ author: { login: ME }, body })),
        ME,
        'semctx',
        sha(branch),
      )
      if (!('record' in found)) throw new Error('the conserved PARTIAL record does not parse')
      // Controlled provider-input mutation, not a claim that this test ran Semctx.
      const record = structuredClone(found.record) as SemctxRecord
      const before = record.native[1]
      if (!before) throw new Error('the conserved record has no pre-run status')
      before.stdout = JSON.stringify({ ...JSON.parse(before.stdout), verdict: 'STALE' })
      const newer = renderRecord('semctx', sha(branch), ['STALE'], record)
      prepare(box, pr, { comments: [approve(sha(branch)), ...parts], body: noTest('out-of-scope') })
      const restore = mutateAfter(
        box,
        when,
        `state.prs[${pr}].comments.push(...${JSON.stringify(newer.map((body) => ({ author: ME, body })))});`,
      )
      try {
        const { result, gate, calls, producers } = land(box, wt.partial as string, pr, mode)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unbound' })
        expect(result.error).toMatch(/status before the run is not FRESH/)
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        if (when === 'body-read') {
          expect(calls.some((args) => args.includes('--auto') || args.includes('--add-label'))).toBe(false)
        }
      } finally {
        restore()
      }
    })

    it.each([
      ['native', '--disable-auto', /stays armed.*auto-merge/],
      ['merge-on-green', '--remove-label', /stays armed.*reviewed label/],
    ] as const)('%s names the arm that a new proof refusal cannot clear', (mode, failClear, error) => {
      prepare(box, pr, {
        comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')],
        body: noTest('out-of-scope'),
      })
      const restore = mutateAfter(box, 'label-write', `state.prs[${pr}].body = 'Closes #1\\n';`, failClear)
      try {
        expect(() => land(box, wt.partial as string, pr, mode)).toThrow(error)
        const pull = readSim(box).prs[String(pr)]
        expect(pull?.labels).toEqual(mode === 'native' ? [] : ['reviewed'])
        expect(pull?.autoMerge).toEqual(
          mode === 'native' ? expect.objectContaining({ matchHeadCommit: sha(branch) }) : null,
        )
        expect(producerCalls(box)).toEqual([])
      } finally {
        restore()
      }
    })
  })

  it('reads ui-manual-only against the e2e command the candidate commits, never the working tree', () => {
    const e2e = SEMCTX_CASES.e2e
    const partial = SEMCTX_CASES.partial
    const e2eDir = wt.e2e as string
    const partialDir = wt.partial as string
    try {
      // The candidate commits test_e2e; a dirty stack that drops it changes nothing.
      writeFileSync(path.join(e2eDir, '.dev/stack.yml'), STACK)
      prepare(box, e2e.pr, {
        comments: [approve(sha(e2e.branch)), ...conserved(RECORDS.semctx, 'e2e')],
        body: browser(),
      })
      const refused = land(box, e2eDir, e2e.pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(refused.result.error).toMatch(/declares commands.test_e2e/)
      expect(refused.gate).toEqual(UNARMED)
      // The candidate commits none; a dirty stack that adds one changes nothing either.
      writeFileSync(path.join(partialDir, '.dev/stack.yml'), STACK_E2E)
      prepare(box, partial.pr, {
        comments: [approve(sha(partial.branch)), ...conserved(RECORDS.semctx, 'partial')],
        body: browser(),
      })
      expect(land(box, partialDir, partial.pr).result).toMatchObject({ status: 'watching' })
    } finally {
      git(box, e2eDir, ['checkout', '--', '.dev/stack.yml'])
      git(box, partialDir, ['checkout', '--', '.dev/stack.yml'])
    }
  })

  describe('a ui-manual-only gap reads the whole stack the candidate commits for its e2e command', () => {
    it.each([
      ['blank', 'e2eBlank'],
      ['empty', 'e2eNull'],
    ] as const)('an e2e command left %s declares none: ui-manual-only admits', (_label, name) => {
      const { pr, branch } = SEMCTX_CASES[name]
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, name)], body: browser() })
      const { result, gate, producers } = land(box, wt[name] as string, pr)
      expect(result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: 'PARTIAL', gaps: [{ gap: GAP, reason: 'ui-manual-only' }] } },
      })
      expect(gate.labels).toEqual(['reviewed'])
      expect(producers).toEqual([])
    })

    it.each([
      ['is not a map', 'stackList', /cannot be read: the document is not a map/],
      ['lists its commands', 'commandList', /cannot be read: commands is not a map/],
    ] as const)(
      'a stack that %s refuses ui-manual-only as unreadable; out-of-scope needs no e2e proof',
      (_label, name, error) => {
        const { pr, branch } = SEMCTX_CASES[name]
        const comments = [approve(sha(branch)), ...conserved(RECORDS.semctx, name)]
        prepare(box, pr, { comments, body: browser() })
        const refused = land(box, wt[name] as string, pr)
        expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
        expect(refused.result.error).toMatch(error)
        expect(refused.gate).toEqual(UNARMED)
        prepare(box, pr, { comments, body: noTest('out-of-scope') })
        const admitted = land(box, wt[name] as string, pr)
        expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'PARTIAL' } } })
        expect([...refused.producers, ...admitted.producers]).toEqual([])
      },
    )
  })

  describe('the base decides with the candidate: a PR never relaxes the policy it is judged by', () => {
    it.each([
      [
        'relaxes the blocking rules the base commits',
        50,
        'relaxed',
        /changes the \.semctx\/config\.json origin\/main commits/,
      ],
      [
        'deletes the Semctx configuration the base commits',
        51,
        'unconfigured',
        /deletes the \.semctx\/config\.json origin\/main commits/,
      ],
    ])('a candidate that %s refuses before any record is read', (_label, pr, name, error) => {
      prepare(box, pr, { comments: [approve(sha(`fix/1-${name}`)), ...conserved(RECORDS.semctx, 'verified')] })
      const { result, gate, calls, producers } = land(box, wt[name] as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'ambiguous' })
      expect(result.error).toMatch(error)
      expect(gate).toEqual(UNARMED)
      expect(calls.some((args) => args.includes('nameWithOwner'))).toBe(false)
      expect(producers).toEqual([])
    })

    it('a candidate that deletes the e2e command its base declares cannot justify a gap as ui-manual-only', () => {
      const { pr, branch } = SEMCTX_CASES.e2eDeleted
      const comments = [approve(sha(branch)), ...conserved(RECORDS.semctx, 'e2eDeleted')]
      prepare(box, pr, { comments, body: browser() })
      const refused = land(box, wt.e2eDeleted as string, pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(refused.result.error).toMatch(/on the base or the candidate declares commands\.test_e2e/)
      expect(refused.gate).toEqual(UNARMED)
      prepare(box, pr, { comments, body: noTest('out-of-scope') })
      const admitted = land(box, wt.e2eDeleted as string, pr)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'PARTIAL' } } })
      expect([...refused.producers, ...admitted.producers]).toEqual([])
    })
  })

  describe('the proof is the change contract the candidate adds, and every open change is in its own file', () => {
    it('a candidate that only modifies an older contract cannot land even with that contract’s native VERIFIED record', () => {
      expect(RECORDS.semctx.records.modified).toMatchObject({ code: 1 })
      const native = RECORDS.semctx.records.modifiedNative
      expect(native?.code).toBe(0)
      expect(JSON.parse(native?.stdout ?? 'null')).toMatchObject([
        { id: 'change.fx.old', verdict: 'VERIFIED', lifecycle: 'verified', gaps: [] },
      ])
      const { pr, branch } = SEMCTX_CASES.modified
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'modifiedNative')] })
      const { result, gate, producers } = land(box, wt.modified as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(result.error).toMatch(/adds no .*only modifies \.semctx\/semantic\/changes\/change\.fx\.old\.sem/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    })

    it('a candidate that adds its own contract and modifies an older one lands with both verified', () => {
      const { pr, branch } = SEMCTX_CASES.amended
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'amended')] })
      const { result, producers } = land(box, wt.amended as string, pr)
      expect(result).toMatchObject({
        status: 'watching',
        proof: {
          semctx: {
            verdict: 'VERIFIED',
            changes: [
              { id: 'change.fx.add', verdict: 'VERIFIED' },
              { id: 'change.fx.old', verdict: 'VERIFIED' },
            ],
          },
        },
      })
      expect(producers).toEqual([])
    })

    it('mixed VERIFIED and PARTIAL changes stay PARTIAL; the partial gap still needs its own row', () => {
      const { pr, branch } = SEMCTX_CASES.mixedResults
      const comments = [approve(sha(branch)), ...conserved(RECORDS.semctx, 'mixedResults')]
      prepare(box, pr, { comments })
      const refused = land(box, wt.mixedResults as string, pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(refused.result.error).toContain(`gap ${GAP} has no NO TEST row`)
      expect(refused.gate).toEqual(UNARMED)

      prepare(box, pr, { comments, body: noTest('out-of-scope') })
      const admitted = land(box, wt.mixedResults as string, pr)
      expect(admitted.result).toMatchObject({
        status: 'watching',
        proof: {
          semctx: {
            verdict: 'PARTIAL',
            changes: [
              { id: 'change.fx.add', verdict: 'PARTIAL' },
              { id: 'change.fx.old', verdict: 'VERIFIED' },
            ],
            gaps: [{ gap: GAP, reason: 'out-of-scope' }],
          },
        },
      })
      expect([...refused.producers, ...admitted.producers]).toEqual([])
    })

    it('an active change declared outside the contract files refuses, though the change counts match', () => {
      const { pr, branch } = SEMCTX_CASES.hidden
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'hidden')] })
      const { result, gate, producers } = land(box, wt.hidden as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict' })
      expect(result.error).toMatch(/change\(s\) change\.real are not committed as their own/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    })
  })

  it.each([
    ['a draft change', 'draft', /is draft; only an active, partial or verified change lands/],
    ['a PARTIAL change declared verified (a forced close)', 'closed', /closed as verified while its result is PARTIAL/],
    ['a VERIFIED change that requires no evidence', 'vacuous', /requires no evidence/],
  ] as const)('%s refuses on its native verdict, unarmed', (_label, name, error) => {
    const { pr, branch } = SEMCTX_CASES[name]
    prepare(box, pr, {
      comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, name)],
      body: noTest('out-of-scope'),
    })
    const { result, gate, producers } = land(box, wt[name] as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict' })
    expect(result.error).toMatch(error)
    expect(gate).toEqual(UNARMED)
    expect(producers).toEqual([])
  })

  it('a non-change block in a contract file is never recorded, so the candidate has no proof', () => {
    expect(RECORDS.semctx.records.mixed).toMatchObject({ code: 1 })
    expect(RECORDS.semctx.records.mixed?.stderr).toMatch(
      /change inspect change\.fx\.note .*no change contract "change\.fx\.note"/s,
    )
    const { pr, branch } = SEMCTX_CASES.mixed
    prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'verified')] })
    const { result, gate } = land(box, wt.mixed as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
    expect(result.error).toContain(`proof-acquire.ts' --pr ${pr}`)
    expect(gate).toEqual(UNARMED)
  })

  describe('the record binds the repository, PR, candidate, local tip and analysed inputs', () => {
    const verified = SEMCTX_CASES.verified
    it('a record of another candidate does not prove this one', () => {
      const { pr, branch } = SEMCTX_CASES.partial
      prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'verified')] })
      const { result, gate } = land(box, wt.partial as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(result.error).toContain(`records by ${ME} name ${sha(verified.branch)}`)
      expect(gate).toEqual(UNARMED)
    })

    it('a record posted by another login proves nothing; the same record by the operator admits', () => {
      const comments = [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified')]
      prepare(box, verified.pr, { comments })
      writeSim(box, (state) => {
        for (const comment of state.prs[String(verified.pr)]?.comments.slice(1) ?? []) comment.author = 'mallory'
      })
      const other = land(box, wt.verified as string, verified.pr)
      expect(other.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(other.result.error).toContain(`no semctx record by ${ME} for candidate ${sha(verified.branch)}`)
      expect(other.gate).toEqual(UNARMED)

      prepare(box, verified.pr, { comments })
      const own = land(box, wt.verified as string, verified.pr)
      expect(own.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
      expect([...other.producers, ...own.producers]).toEqual([])
    })

    it('the latest complete record wins: a newer refusal never falls back to an older VERIFIED record', () => {
      const older = conserved(RECORDS.semctx, 'verified')
      const found = findRecord(
        older.map((body) => ({ author: { login: ME }, body })),
        ME,
        'semctx',
        sha(verified.branch),
      )
      if (!('record' in found)) throw new Error('the conserved record does not parse')
      const record = structuredClone(found.record) as SemctxRecord
      const step = record.native[4]
      if (!step) throw new Error('the conserved record holds no verify')
      step.stdout = JSON.stringify({
        ...JSON.parse(step.stdout),
        verdict: 'BLOCKED',
        findings: [{ kind: 'underlying_block', severity: 'block', message: 'invariant unproved', refs: [] }],
      })
      const newer = renderRecord('semctx', sha(verified.branch), ['BLOCKED'], record)
      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...older, ...newer] })
      const refused = land(box, wt.verified as string, verified.pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict' })
      expect(refused.result.error).toContain('BLOCKED: invariant unproved')
      expect(refused.gate).toEqual(UNARMED)

      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...newer, ...older] })
      const admitted = land(box, wt.verified as string, verified.pr)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
      expect([...refused.producers, ...admitted.producers]).toEqual([])
    })

    it('a PR whose head moved past the proven commit has no proof for its new head', () => {
      prepare(box, 18, { comments: [approve(sha('fix/1-moved')), ...conserved(RECORDS.semctx, 'verified')] })
      const { result, gate } = land(box, wt.moved as string, 18)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(gate).toEqual(UNARMED)
    })

    it('a record conserved for another PR of the same head does not bind this PR', () => {
      prepare(box, 17, { comments: [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified')] })
      const { result, gate } = land(box, wt.verified as string, 17)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unbound' })
      expect(result.error).toMatch(/pr/i)
      expect(gate).toEqual(UNARMED)
    })

    it('landing from a checkout whose tip is not the candidate refuses before reading any record', () => {
      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified')] })
      const { result, gate, calls } = land(box, wt.partial as string, verified.pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(result.error).toContain(
        `the local tip ${sha(SEMCTX_CASES.partial.branch)} is not candidate ${sha(verified.branch)}`,
      )
      expect(gate).toEqual(UNARMED)
      expect(calls.some((args) => args.includes('nameWithOwner'))).toBe(false)
    })

    it('a record whose analysed merge base is not the one Git derives now does not bind', () => {
      const found = findRecord(
        conserved(RECORDS.semctx, 'verified').map((body) => ({ author: { login: ME }, body })),
        ME,
        'semctx',
        sha(verified.branch),
      )
      if (!('record' in found)) throw new Error('the conserved record does not parse')
      const record = structuredClone(found.record) as { invocation: { mergeBase: string } }
      record.invocation.mergeBase = sha(SEMCTX_CASES.partial.branch)
      const forged = renderRecord('semctx', sha(verified.branch), ['forged'], record)
      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...forged] })
      const { result, gate } = land(box, wt.verified as string, verified.pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unbound' })
      expect(gate).toEqual(UNARMED)
    })
  })

  describe('a record above one comment is posted as a run of parts and admitted only whole', () => {
    const { pr, branch } = SEMCTX_CASES.large
    const parts = conserved(RECORDS.semctx, 'large')
    const [first = '', last = ''] = [parts[0], parts.at(-1)]

    it('proof-acquire posted it in parts, each within the simulated GitHub ceiling', () => {
      expect(RECORDS.semctx.records.large?.code).toBe(0)
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.join('').length).toBeGreaterThan(65536)
    })

    it.each([
      ['interleaved with another comment', [first, 'unrelated note', ...parts.slice(1)]],
      ['after an earlier posting that stopped short', [first, ...parts]],
    ])('admits the parts %s, with no producer call', (_label, comments) => {
      prepare(box, pr, { comments: [approve(sha(branch)), ...comments] })
      const { result, gate, calls, producers } = land(box, wt.large as string, pr)
      expect(result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: 'VERIFIED', changes: [{ id: 'change.fx.add', verdict: 'VERIFIED' }] } },
      })
      expect(gate).toEqual({
        labels: ['reviewed'],
        autoMerge: expect.objectContaining({ matchHeadCommit: sha(branch) }),
      })
      expect(producers).toEqual([])
      expect(calls.filter((args) => args[1] === 'comment')).toEqual([])
    })

    it.each([
      ['its first part deleted', parts.slice(1)],
      ['its last part deleted', parts.slice(0, -1)],
      ['its parts out of order', [last, ...parts.slice(0, -1)]],
      ['a later posting that stops short', [...parts, first]],
    ])('with %s, the record is missing, unarmed', (_label, comments) => {
      prepare(box, pr, { comments: [approve(sha(branch)), ...comments] })
      const { result, gate, producers } = land(box, wt.large as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(result.error).toMatch(/incomplete/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    })
  })

  describe('review refusals keep precedence over a bad proof', () => {
    const { pr, branch } = SEMCTX_CASES.vacuous
    it.each([
      ['a single non-spent red', () => [red(sha(branch))], { status: 'not-approved', reviews: 1 }],
      [
        'a spent bound',
        () => [red(sha(branch)), red(sha(branch)), red(sha(branch))],
        { status: 'not-approved', reason: 'review-bound' },
      ],
      [
        'an approval: the bad proof refuses',
        () => [approve(sha(branch))],
        { status: 'proof-blocked', reason: 'verdict' },
      ],
    ])('%s', (_label, reviews, expected) => {
      prepare(box, pr, { comments: [...reviews(), ...conserved(RECORDS.semctx, 'vacuous')] })
      const { result, gate } = land(box, wt.vacuous as string, pr)
      expect(result).toMatchObject(expected)
      if (expected.status === 'not-approved') expect(result.status).not.toBe('proof-blocked')
      expect(gate).toEqual(UNARMED)
    })
  })

  it('a refusal on an armed PR disarms it through the shared exit and confirms by read-back', () => {
    const { pr, branch } = SEMCTX_CASES.draft
    prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'draft')], armed: sha(branch) })
    const { result, calls, gate } = land(box, wt.draft as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict', disarmed: true })
    expect(gate).toEqual(UNARMED)
    expect(calls).toContainEqual(['pr', 'merge', String(pr), '--disable-auto'])
    expect(calls.some((args) => args.includes('--add-label'))).toBe(false)
  })
})

describe('landPr admission in a repository whose Semctx configuration is the operator’s, uncommitted', () => {
  let box: Box
  let wt: string
  const { pr, branch } = IGNORED_CASE
  const head = () => box.sha[branch] as string
  const config = () => path.join(box.principal, '.semctx', 'config.json')

  beforeAll(() => {
    box = sandbox(ignoredSpec())
    for (const [ref, value] of Object.entries(RECORDS.ignored.sha)) {
      if (box.sha[ref] !== value)
        throw new Error(`${ref} rebuilt as ${box.sha[ref]}, recorded ${value}: re-run capture.ts`)
    }
    instrument(box)
    wt = worktree(box, 'ignored', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('lands on the record acquired under that configuration, with no producer call', () => {
    prepare(box, pr, { comments: [approve(head()), ...conserved(RECORDS.ignored, 'verified')] })
    const { result, gate, producers } = land(box, wt, pr)
    expect(result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
    expect(gate.labels).toEqual(['reviewed'])
    expect(producers).toEqual([])
  })

  it('a configuration edited since the run does not bind the record', () => {
    const original = readFileSync(config(), 'utf8')
    writeFileSync(config(), original.replaceAll('"block"', '"warn"'))
    try {
      prepare(box, pr, { comments: [approve(head()), ...conserved(RECORDS.ignored, 'verified')] })
      const { result, gate, producers } = land(box, wt, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unbound' })
      expect(result.error).toMatch(/is not the ignored one in force now/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    } finally {
      writeFileSync(config(), original)
    }
  })

  for (const fault of ['principal-edit', 'root-disagreement', 'principal-unreadable'] as const) {
    // Root bypasses Unix read permission: it cannot exercise this real EACCES path.
    it
      .skipIf(fault === 'principal-unreadable' && process.getuid?.() === 0)
      .each(
        (['native', 'merge-on-green'] as const).flatMap((mode) =>
          (['admission-comments', 'label-write'] as const).map((when) => [mode, when] as const),
        ),
      )(`%s refuses %s-time ${fault} at the same approved head`, (mode, when) => {
      const original = readFileSync(config(), 'utf8')
      const rootConfig = path.join(wt, '.semctx/config.json')
      prepare(box, pr, { comments: [approve(head()), ...conserved(RECORDS.ignored, 'verified')] })
      const change =
        fault === 'principal-unreadable'
          ? `chmodSync(${JSON.stringify(config())}, 0);`
          : `writeFileSync(${JSON.stringify(fault === 'principal-edit' ? config() : rootConfig)}, ${JSON.stringify(original.replaceAll('"block"', '"warn"'))});`
      const restore = mutateAfter(box, when, change)
      try {
        const { result, gate, calls, producers } = land(box, wt, pr, mode)
        const reason =
          fault === 'principal-edit' ? 'unbound' : fault === 'root-disagreement' ? 'ambiguous' : 'unreadable'
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason })
        expect(result.error).toMatch(
          fault === 'principal-edit'
            ? /is not the ignored one in force now/
            : fault === 'root-disagreement'
              ? /disagrees with the Semctx configuration/
              : /EACCES/,
        )
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        if (when === 'admission-comments') {
          expect(calls.some((args) => args.includes('--auto') || args.includes('--add-label'))).toBe(false)
        }
      } finally {
        restore()
        chmodSync(config(), 0o644)
        writeFileSync(config(), original)
        rmSync(rootConfig, { force: true })
      }
    })
  }
})

describe('landPr admission against conserved assertledger records', () => {
  let box: Box
  const wt: Record<string, string> = {}
  const detection = LEDGER_CASES.detection
  const weak = LEDGER_CASES.weak
  const sha = (branch: string) => box.sha[branch] as string
  const extra = (number: number, closes: number[]) => ({
    number,
    branch: detection.branch,
    title: 'clamp',
    body: closes.map((n) => `Closes #${n}`).join('\n'),
    closes,
  })

  beforeAll(() => {
    const spec = ledgerSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: 'fix/2-unadapted',
          from: detection.branch,
          commits: [{ message: 'chore: drop the adapter (#2)', files: { 'assertledger.config.json': null } }],
        },
      ],
      prs: [
        ...spec.prs,
        extra(22, [2, 3]),
        extra(24, []),
        { number: 25, branch: 'fix/2-unadapted', title: 'fix: clamp', body: 'Closes #2\n', closes: [2] },
      ],
    })
    for (const [branch, value] of Object.entries(RECORDS.assertledger.sha)) {
      if (box.sha[branch] !== value)
        throw new Error(`${branch} rebuilt as ${box.sha[branch]}, recorded ${value}: re-run capture.ts`)
    }
    instrument(box)
    wt.detection = worktree(box, 'detection', sha(detection.branch))
    wt.weak = worktree(box, 'weak', sha(weak.branch))
    wt.unadapted = worktree(box, 'unadapted', sha('fix/2-unadapted'))
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('a fix ticket with an adapter admits a detection bound to the candidate, without Semctx and without running assertledger', () => {
    prepare(box, detection.pr, {
      comments: [approve(sha(detection.branch)), ...conserved(RECORDS.assertledger, 'detection')],
      body: 'Closes #2\n',
    })
    const { result, gate, producers } = land(box, wt.detection as string, detection.pr)
    expect(result).toMatchObject({ status: 'watching', proof: { semctx: 'absent', assertledger: 'detection' } })
    expect(gate.labels).toEqual(['reviewed'])
    expect(producers).toEqual([])
  })

  it('a fix PR that deletes the adapter its base declares still owes the detection', () => {
    prepare(box, 25, { comments: [approve(sha('fix/2-unadapted'))], body: 'Closes #2\n' })
    const { result, gate, producers } = land(box, wt.unadapted as string, 25)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
    expect(gate).toEqual(UNARMED)
    expect(producers).toEqual([])
  })

  it.each([
    ['WEAK_ORACLE', weak.pr, weak.branch, 'weak', 'verdict', /WEAK_ORACLE/],
    ['no record', detection.pr, detection.branch, null, 'missing', /--assertledger-manifest/],
    [
      'the detection record of another candidate',
      weak.pr,
      weak.branch,
      'detection',
      'missing',
      /records by operator name/,
    ],
  ] as const)('%s refuses, unarmed', (_label, pr, branch, name, reason, error) => {
    const comments = [approve(sha(branch)), ...(name ? conserved(RECORDS.assertledger, name) : [])]
    prepare(box, pr, { comments, body: 'Closes #2\n' })
    const { result, gate } = land(box, wt[branch === weak.branch ? 'weak' : 'detection'] as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason })
    expect(result.error).toMatch(error)
    expect(gate).toEqual(UNARMED)
  })

  describe('a fix is any fix signal of the head branch or a closing ticket', () => {
    // The ticket and head branch of PR #20, whose detection record binds PR #20 and its candidate.
    const NEUTRAL = { title: 'clamp above range', labels: ['size:F-lite'], issueType: null }
    const shape = (head: string, ticket: { title: string; labels: string[]; issueType: string | null }) =>
      writeSim(box, (state) => {
        const pull = state.prs[String(detection.pr)]
        const issue = state.issues['2']
        if (!pull || !issue) throw new Error('PR #20 or issue #2 is missing')
        pull.headRefName = head
        Object.assign(issue, ticket)
      })
    afterAll(() => shape(detection.branch, { title: 'fix: clamp', labels: ['size:F-lite'], issueType: 'fix' }))

    it.each([
      ['a Fix-typed ticket', '2-clamp', { ...NEUTRAL, issueType: 'Fix' }],
      ['a Bug-typed ticket', '2-clamp', { ...NEUTRAL, issueType: 'Bug' }],
      ['a Bug-labelled ticket', '2-clamp', { ...NEUTRAL, labels: ['size:F-lite', 'Bug'] }],
      ['a fix(…)-titled ticket', '2-clamp', { ...NEUTRAL, title: 'fix(clamp): above range' }],
      ['a fix/ head branch', 'fix/2-clamp', NEUTRAL],
      ['a Bug-typed ticket on a feat/ branch', 'feat/2-clamp', { ...NEUTRAL, issueType: 'Bug' }],
    ])('%s owes a detection: refused without it, admitted with it', (_label, head, ticket) => {
      shape(head, ticket)
      const candidate = sha(detection.branch)
      prepare(box, detection.pr, { comments: [approve(candidate)], body: 'Closes #2\n' })
      const refused = land(box, wt.detection as string, detection.pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
      expect(refused.gate).toEqual(UNARMED)
      prepare(box, detection.pr, {
        comments: [approve(candidate), ...conserved(RECORDS.assertledger, 'detection')],
        body: 'Closes #2\n',
      })
      const admitted = land(box, wt.detection as string, detection.pr)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { assertledger: 'detection' } })
      expect([...refused.producers, ...admitted.producers]).toEqual([])
    })

    it.each([
      ['a feat/ branch closing a feat ticket', 'feat/2-clamp', { ...NEUTRAL, title: 'feat: clamp', issueType: 'feat' }],
      ['a feat/ branch closing an untyped ticket', 'feat/2-clamp', NEUTRAL],
      ['an untyped branch closing a Feature-typed ticket', '2-clamp', { ...NEUTRAL, issueType: 'Feature' }],
    ])('%s owes none: the adapter alone does not apply it', (_label, head, ticket) => {
      shape(head, ticket)
      prepare(box, detection.pr, { comments: [approve(sha(detection.branch))], body: 'Closes #2\n' })
      const { result } = land(box, wt.detection as string, detection.pr)
      expect(result).toMatchObject({ status: 'watching', proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    })

    it.each([
      ['native', 'classification-read'],
      ['merge-on-green', 'classification-read'],
      ['native', 'label-write'],
      ['merge-on-green', 'label-write'],
    ] as const)('%s refuses a closing ticket retyped to Bug after %s at the same approved head', (mode, when) => {
      shape('feat/2-clamp', { ...NEUTRAL, title: 'feat: clamp', issueType: 'feat' })
      prepare(box, detection.pr, { comments: [approve(sha(detection.branch))], body: 'Closes #2\n' })
      const restore = mutateAfter(box, when, "state.issues['2'].issueType = 'Bug';")
      try {
        const { result, gate, calls, producers } = land(box, wt.detection as string, detection.pr, mode)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        if (when === 'classification-read') {
          expect(calls.some((args) => args.includes('--auto') || args.includes('--add-label'))).toBe(false)
        }
      } finally {
        restore()
      }
    })

    it('nothing establishing a type refuses: whether a detection is owed is unknown', () => {
      shape('2-clamp', NEUTRAL)
      prepare(box, detection.pr, { comments: [approve(sha(detection.branch))], body: 'Closes #2\n' })
      const { result, gate } = land(box, wt.detection as string, detection.pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'unreadable' })
      expect(result.error).toMatch(/establishes no ticket type/)
      expect(gate).toEqual(UNARMED)
    })
  })

  it('a PR on an untyped branch closing a fix ticket and a feat ticket owes the detection', () => {
    writeSim(box, (state) => {
      const pull = state.prs['22']
      if (!pull) throw new Error('no PR 22')
      pull.headRefName = '2-clamp'
    })
    prepare(box, 22, { comments: [approve(sha(detection.branch))], body: 'Closes #2\nCloses #3' })
    const { result, gate } = land(box, wt.detection as string, 22)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
    expect(gate).toEqual(UNARMED)
  })

  it.each([
    ['an untyped branch cannot say whether a detection is owed, and refuses', '2-clamp', { reason: 'unreadable' }],
    ['a fix/ branch owes the detection', 'fix/2-clamp', { reason: 'missing' }],
  ])('a PR that closes no ticket on %s', (_label, head, expected) => {
    writeSim(box, (state) => {
      const pull = state.prs['24']
      if (!pull) throw new Error('no PR 24')
      pull.headRefName = head
    })
    prepare(box, 24, { comments: [approve(sha(detection.branch))], body: 'x' })
    const { result, gate } = land(box, wt.detection as string, 24)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', ...expected })
    expect(gate).toEqual(UNARMED)
  })
})

describe('landPr admission where Semctx and an assertledger adapter both apply', () => {
  const { pr, branch } = BOTH_CASE
  const posted = conserved(RECORDS.both, 'both')
  let box: Box
  let dir: string

  beforeAll(() => {
    box = sandbox(bothSpec())
    for (const [name, value] of Object.entries(RECORDS.both.sha)) {
      if (box.sha[name] !== value)
        throw new Error(`${name} rebuilt as ${box.sha[name]}, recorded ${value}: re-run capture.ts`)
    }
    instrument(box)
    dir = worktree(box, 'both', box.sha[branch] as string)
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('an admitted Semctx record does not waive the detection; both records admit', () => {
    const candidate = box.sha[branch] as string
    const semctx = posted.filter((body) => body.startsWith(proofMark('semctx')))
    prepare(box, pr, { comments: [approve(candidate), ...semctx], body: 'Closes #2\n' })
    const refused = land(box, dir, pr)
    expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
    expect(refused.gate).toEqual(UNARMED)

    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n' })
    const admitted = land(box, dir, pr)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: { verdict: 'VERIFIED' }, assertledger: 'detection' },
    })
    expect(admitted.gate.labels).toEqual(['reviewed'])
    expect([...refused.producers, ...admitted.producers]).toEqual([])
  })
})

describe('Semctx applicability is decided from the base, the candidate and the checkouts', () => {
  // The principal's directory name ends in a space and a newline; Git paths are kept byte for byte.
  const PRINCIPAL = 'principal \n'
  let box: Box
  let wt: string
  let malformedWt: string
  const head = () => box.sha['fix/5-plain'] as string
  const PR = 30
  // A candidate that commits a Semctx configuration that is not JSON.
  const MALFORMED = { pr: 31, branch: 'fix/5-malformed' }

  beforeAll(() => {
    const spec = plainSpec({ principalName: PRINCIPAL })
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: MALFORMED.branch,
          from: 'fix/5-plain',
          commits: [{ message: 'chore: semctx (#5)', files: { '.semctx/config.json': '{"include": [\n' } }],
        },
      ],
      prs: [
        ...spec.prs,
        { number: MALFORMED.pr, branch: MALFORMED.branch, title: 'fix: plain', body: 'Closes #5\n', closes: [5] },
      ],
    })
    instrument(box)
    wt = worktree(box, 'plain', head())
    malformedWt = worktree(box, 'malformed', box.sha[MALFORMED.branch] as string)
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it.each([
    ['the worktree root', () => wt],
    ['a nested directory', () => path.join(wt, 'src')],
  ])('genuine absence, from %s, makes only Semctx non-applicable and asks GitHub nothing for it', (_label, cwd) => {
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    const { result, calls, gate } = land(box, cwd(), PR)
    expect(result).toMatchObject({ status: 'watching', proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    expect(gate.labels).toEqual(['reviewed'])
    expect(calls.some((args) => args.includes('graphql') || args.includes('nameWithOwner'))).toBe(false)
  })

  it.each([
    ['the worktree root, from the root', () => wt, () => path.join(wt, '.semctx')],
    ['the worktree root, from a nested directory', () => path.join(wt, 'src'), () => path.join(wt, '.semctx')],
    ['the principal, whose path ends in a space and a newline', () => wt, () => path.join(box.principal, '.semctx')],
  ])('uncommitted Semctx state in %s is not absence', (_label, cwd, state) => {
    mkdirSync(state())
    try {
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const { result, gate } = land(box, cwd(), PR)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'ambiguous' })
      expect(result.error).toContain(JSON.stringify(state()))
      expect(gate).toEqual(UNARMED)
    } finally {
      rmSync(state(), { recursive: true })
    }
  })

  it('a local tip that cannot be read — an unborn HEAD — refuses with Git’s cause, never as absence', () => {
    const headFile = git(box, wt, ['rev-parse', '--git-path', 'HEAD'])
    const at = path.isAbsolute(headFile) ? headFile : path.join(wt, headFile)
    const detached = readFileSync(at, 'utf8')
    writeFileSync(at, 'ref: refs/heads/unborn\n')
    try {
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const { result, gate, producers } = land(box, wt, PR)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
      expect(result.error).toContain('the local tip cannot be read — git rev-parse --verify HEAD^{commit}')
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    } finally {
      writeFileSync(at, detached)
    }
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    expect(land(box, wt, PR).result).toMatchObject({ status: 'watching', proof: { semctx: 'absent' } })
  })

  it('a committed Semctx configuration that is not JSON refuses as unreadable, never as absence', () => {
    const candidate = box.sha[MALFORMED.branch] as string
    prepare(box, MALFORMED.pr, { comments: [approve(candidate)], body: 'Closes #5\n' })
    const { result, gate, producers } = land(box, malformedWt, MALFORMED.pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
    expect(result.error).toContain(`.semctx/config.json at ${candidate} is malformed`)
    expect(gate).toEqual(UNARMED)
    expect(producers).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)(
    'a principal root that loses search permission after Git reads its declarations refuses; restoring access admits',
    () => {
      const bin = path.join(box.root, 'fault-git')
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: box.env }).trim()
      mkdirSync(bin)
      const shim = path.join(bin, 'git')
      // Run real Git unchanged, then inject the filesystem race immediately
      // before admission stats .semctx. No Git answer or absence is fabricated.
      writeFileSync(
        shim,
        `#!/bin/sh\n'${realGit}' "$@"\ncode=$?\nif [ "$3" = ls-tree ] && [ "$7" = 'refs/remotes/origin/main^{commit}' ]; then chmod 000 '${box.principal}'; fi\nexit "$code"\n`,
      )
      chmodSync(shim, 0o755)
      const originalPath = box.env.PATH
      box.env.PATH = `${bin}:${originalPath}`
      try {
        prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
        const { result, gate, producers } = land(box, wt, PR)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
        expect(result.error).toContain(`${JSON.stringify(path.join(box.principal, '.semctx'))} cannot be read`)
        expect(result.error).toContain('EACCES')
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
      } finally {
        chmodSync(box.principal, 0o755)
        box.env.PATH = originalPath
      }
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const admitted = land(box, wt, PR)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: 'absent' } })
      expect(admitted.producers).toEqual([])
    },
  )

  it('a candidate whose tree object is missing refuses with Git’s cause, never as absence', () => {
    const tree = git(box, wt, ['rev-parse', `${head()}^{tree}`])
    rmSync(path.join(box.principal, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    const { result, gate } = land(box, wt, PR)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
    expect(result.error).toContain(`candidate ${head()} cannot be read — git ls-tree`)
    expect(result.error).toContain('fatal: not a tree object')
    expect(gate).toEqual(UNARMED)
  })
})
