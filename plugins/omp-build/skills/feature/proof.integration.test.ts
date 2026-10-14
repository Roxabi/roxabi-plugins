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
  ACQUIRE,
  BOTH_CASE,
  type Box,
  bothSpec,
  git,
  IGNORED_CASE,
  ignoredSpec,
  LEDGER_BASE,
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
import type { AssertledgerRecord, SemctxRecord } from './proof'
import { findRecord, proofMark, renderRecord } from './proof'

type Captured = { code: number | null; stdout: string; stderr: string; record?: string[] }
type ReplayCapture = { token: { from: string; to: string }; version: Captured; invalid: Captured; valid: Captured }
type Capture = { sha: Record<string, string>; records: Record<string, Captured>; replays?: ReplayCapture }
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

/** The `baseRefOid` GitHub reports for `pr`: the tip it recorded, which a push to the base branch leaves. */
function recordedBaseOf(box: Box, pr: number): string | undefined {
  const view: { baseRefOid?: string } = JSON.parse(
    execFileSync('gh', ['pr', 'view', String(pr), '--json', 'baseRefOid'], {
      cwd: box.principal,
      env: box.env,
      encoding: 'utf8',
    }),
  )
  return view.baseRefOid
}

function prepare(
  box: Box,
  pr: number,
  {
    comments,
    body = 'Closes #1\n',
    armed = null,
    binding = true,
  }: { comments: string[]; body?: string; armed?: string | null; binding?: boolean },
): void {
  writeSim(box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error(`no PR ${pr}`)
    // This fixture's proofs are published before its reviews; preserve order within each stream.
    const proofs = comments.filter((text) => text.startsWith('<!-- omp-build:proof producer='))
    const reviews = comments.filter((text) => !text.startsWith('<!-- omp-build:proof producer='))
    pull.comments = [...proofs, ...reviews].map((text) => ({ author: ME, body: text }))
    pull.body = body
    pull.lastEditedAt = null
    pull.labels = armed ? ['reviewed'] : []
    pull.autoMerge = armed ? { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: armed } : null
  })
  if (binding) bindFixtureReview(box, pr)
}

/** Publish the fixture approval with the exact inputs, before any deliberate drift. */
function bindFixtureReview(box: Box, pr: number): void {
  const view: { headRefOid: string } = JSON.parse(
    execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], {
      cwd: box.principal,
      env: box.env,
      encoding: 'utf8',
    }),
  )
  const checkout = git(box, box.principal, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .find((entry) => entry.split('\0').includes(`HEAD ${view.headRefOid}`))
    ?.split('\0')[0]
    ?.slice('worktree '.length)
  if (!checkout) return
  const captured = workflowRead(box, checkout, pr, view.headRefOid, 'captureReviewInput')
  const input = captured.input
  if (!captured.ok || !input) return
  writeSim(box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error(`no PR ${pr}`)
    const comment = pull.comments.findLast((entry) => {
      const lines = entry.body.split('\n')
      return (
        lines[0] === '<!-- omp-build:code-review -->' &&
        lines[1] === `<!-- omp-build:review-head sha=${view.headRefOid} -->`
      )
    })
    if (!comment) return
    const lines = comment.body.split('\n')
    if (lines[2]?.startsWith('<!-- omp-build:review-input')) lines[2] = input
    else lines.splice(2, 0, input)
    comment.body = lines.join('\n')
  })
}

/** Fork the real read/validation owners, not a copied digest or producer result. */
function workflowRead(
  box: Box,
  cwd: string,
  pr: number,
  head: string,
  fn: 'captureReviewInput' | 'validateReviewInput',
  input?: string | null,
): {
  ok: boolean
  input?: string | null
  body?: { body: string; lastEditedAt: string | null } | null
  semctx?: unknown | null
  assertledger?: unknown | null
  reason?: string
  error?: string
} {
  const out = spawnSync(REAL_BUN, [WORKFLOW, fn, cwd, JSON.stringify({ pr, head, input })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`${fn} failed: ${out.stderr}`)
  return JSON.parse(out.stdout)
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
    | 'remove-label-write'
    | 'base-read'
    | 'acquisition-comments'
    | 'repository-read'
    | 'admission-base-read'
    | 'comment-write',
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
const baseRead = (args[args.indexOf('--json') + 1] ?? '') === 'baseRefName'
const baseCountFile = ${JSON.stringify(path.join(dir, 'base-reads'))}
const baseCount = baseRead ? (existsSync(baseCountFile) ? Number(readFileSync(baseCountFile, 'utf8')) : 0) + 1 : 0
if (baseRead) writeFileSync(baseCountFile, String(baseCount))
const when = ${JSON.stringify(when)}
const matches = when === 'base-read' ? baseRead
  : when === 'admission-base-read' ? baseRead && baseCount === 2
  : when === 'repository-read' ? args[0] === 'repo' && args[1] === 'view'
  : when === 'acquisition-comments' ? comments && count === 1
  : when === 'body-read' ? query.includes('lastEditedAt')
  : when === 'classification-read' ? query.includes('issueType')
  : when === 'admission-comments' ? comments && count === 2
  : when === 'pin-write' ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')
  : when === 'comment-write' ? args[0] === 'pr' && args[1] === 'comment'
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

describe('origin identity is bound to the selected repository before base policy', () => {
  let box: Box
  let wt: string
  let fork: string
  const pr = 30
  const head = () => box.sha['fix/5-plain'] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: 'canonical-configured',
          from: 'main',
          commits: [{ message: 'chore: canonical obligation', files: { '.semctx/config.json': SEMCTX_CONFIG } }],
        },
      ],
    })
    fork = path.join(box.root, 'fork.git')
    git(box, box.root, ['clone', '-q', '--bare', box.origin, fork])
    writeSim(box, (state) => {
      state.repositoryUrls = { [fork]: 'fork/app' }
    })
    instrument(box)
    wt = worktree(box, 'repository-bound', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  function reset(armed = false): void {
    git(box, wt, ['remote', 'set-url', 'origin', box.origin])
    git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    prepare(box, pr, { comments: [approve(head())], body: 'Closes #5\n', armed: armed ? head() : null })
  }

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses fork absence instead of exempting the canonical base configuration',
    (mode) => {
      reset(true)
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha['canonical-configured'] as string])
      git(box, wt, ['remote', 'set-url', 'origin', fork])
      const refused = land(box, wt, pr, mode)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unbound',
        disarmed: true,
      })
      expect(refused.result.error).toContain('fork/app')
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])

      reset()
      const admitted = land(box, wt, pr, mode)
      expect(admitted.result).toMatchObject({
        status: 'watching',
        proof: { semctx: 'absent', assertledger: 'not-applicable' },
      })
      expect(admitted.gate.labels).toEqual(['reviewed'])
      expect(admitted.producers).toEqual([])
    },
  )

  it('acquisition refuses the same mismatch; matching origin can report genuine absence', () => {
    reset()
    git(box, wt, ['remote', 'set-url', 'origin', fork])
    const refused = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('candidate unbound')
    expect(refused.stderr).toContain('fork/app')
    expect(producerCalls(box)).toEqual([])

    reset()
    const admitted = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
    expect(admitted.status).toBe(0)
    expect(JSON.parse(admitted.stdout)).toMatchObject({
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    })
    expect(producerCalls(box)).toEqual([])
  })
})

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

  it.each([
    ['native', 'pin-write', false],
    ['native', 'pin-write', true],
    ['native', 'label-write', false],
    ['merge-on-green', 'label-write', false],
  ] as const)(
    '%s refuses a freshly approved H2 that replaces the armed H after %s (previous arm: %s)',
    (mode, when, armed) => {
      reset(armed)
      const h2 = box.sha[next] as string
      const restore = mutateAfter(
        box,
        when,
        `
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      state.prs[${pr}].comments.push({ author: ${JSON.stringify(ME)}, body: ${JSON.stringify(approve(h2))} });
      const checkout = spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'checkout', '-q', '--detach', ${JSON.stringify(h2)}], { env: process.env, encoding: 'utf8' });
      if (checkout.status !== 0) throw new Error(checkout.stderr);
    `,
      )
      try {
        const { result, calls, gate, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        const pins = calls.filter((args) => args.includes('--match-head-commit')).map((args) => args.at(-1))
        expect(pins).toEqual(mode === 'native' ? [head()] : [])
        const disabledAt = calls.findIndex((args) => args.includes('--disable-auto'))
        const pinnedAt = calls.findIndex((args) => args.includes('--match-head-commit'))
        expect(disabledAt !== -1 && disabledAt < pinnedAt).toBe(mode === 'native' && armed)
        if (when === 'pin-write') expect(calls.some((args) => args.includes('--add-label'))).toBe(false)
      } finally {
        restore()
      }
    },
  )

  it.each(['native', 'merge-on-green'] as const)('%s keeps watching the armed H when nothing moves', (mode) => {
    reset(false)
    const { result, gate, producers } = land(box, wt, pr, mode)
    expect(result).toMatchObject({ status: 'watching', mode })
    expect(gate).toEqual(
      mode === 'native'
        ? { labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head() }) }
        : { labels: ['reviewed'], autoMerge: null },
    )
    expect(producers).toEqual([])
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a base that moves after selection while baseRefOid still reports the selected tip',
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
        expect(result.error).toContain(`main@${box.sha.main}`)
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      } finally {
        restore()
        git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
      }
    },
  )

  describe('a clean PR merges as soon as it is armed, moving the base itself', () => {
    function armGreen(): void {
      writeSim(box, (state) => {
        state.checks[head()] = [
          {
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'ci',
            startedAt: '2026-01-01T00:00:00Z',
          },
        ]
      })
    }
    function reopen(): void {
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('no plain PR')
        pull.state = 'OPEN'
        pull.mergeCommit = null
        pull.mergedAt = null
        delete state.checks[head()]
        for (const number of pull.closes) {
          const issue = state.issues[String(number)]
          if (issue) issue.state = 'OPEN'
        }
      })
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    }

    it.each(['native', 'merge-on-green'] as const)('%s lands it onto the selected tip as watching', (mode) => {
      reset(false)
      armGreen()
      try {
        const { result, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: 'watching', mode })
        const merged = readSim(box).prs[String(pr)]
        expect(merged?.state).toBe('MERGED')
        expect(merged?.mergeCommit?.parents).toEqual([box.sha.main, head()])
        expect(producers).toEqual([])
      } finally {
        reopen()
      }
    })

    it('native refuses it once it merged onto a base that moved after selection', () => {
      reset(false)
      armGreen()
      const restore = mutateAfter(
        box,
        'pin-write',
        `
      const moved = spawnSync('git', ['--git-dir', ${JSON.stringify(box.origin)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.staging)}], { env: process.env, encoding: 'utf8' });
      if (moved.status !== 0) throw new Error(moved.stderr);
    `,
      )
      try {
        const { result, producers } = land(box, wt, pr, 'native')
        expect(result).toMatchObject({ status: 'auto-merge-failed' })
        expect(result.error).toMatch(/merged while being disarmed/)
        expect(readSim(box).prs[String(pr)]?.mergeCommit?.parents).toEqual([box.sha.staging, head()])
        expect(producers).toEqual([])
      } finally {
        restore()
        reopen()
      }
    })
  })

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

describe('selected base acquisition precedes policy and applicability', () => {
  let box: Box
  let wt: string
  const pr = 30
  const branch = 'fix/5-plain'
  const head = () => box.sha[branch] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        ...Object.entries<Record<string, string>>({
          configured: { '.semctx/config.json': SEMCTX_CONFIG },
          adapter: { 'assertledger.config.json': LEDGER_BASE['assertledger.config.json'] as string },
          policy: { '.dev/stack.yml': 'landing:\n  mode: merge-on-green\n' },
          malformed: { '.dev/stack.yml': 'landing: [\n' },
          moved: { 'docs/BASE.md': 'the base moved on\n' },
        }).map(([name, files]) => ({
          name,
          from: 'main',
          commits: [{ message: `chore: ${name}`, files }],
        })),
      ],
    })
    instrument(box)
    wt = worktree(box, 'fresh-base', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function reset(next = 'main', armed = true): void {
    git(box, wt, ['remote', 'set-url', 'origin', box.origin])
    git(box, wt, ['update-ref', 'refs/remotes/origin/main', box.sha.main as string])
    git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha[next] as string])
    prepare(box, pr, { comments: [approve(head())], body: 'Closes #5\n', armed: armed ? head() : null })
  }
  function acquire() {
    return spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
  }
  it.each([
    ['native', 'configured', 'semctx', 'ambiguous'],
    ['merge-on-green', 'configured', 'semctx', 'ambiguous'],
    ['native', 'adapter', 'assertledger', 'missing'],
    ['merge-on-green', 'adapter', 'assertledger', 'missing'],
  ] as const)(
    '%s refuses the newly committed %s obligation despite an absent cached base',
    (mode, next, producer, reason) => {
      reset(next)
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({ status: 'proof-blocked', producer, reason, disarmed: true })
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
  it.each(['configured', 'adapter'])(
    'acquisition does not report absence when the authoritative base adds %s',
    (next) => {
      reset(next)
      const run = acquire()
      expect(run.status).toBe(1)
      expect(run.stderr).toContain(next === 'configured' ? 'semctx ambiguous' : 'manifest')
      expect(producerCalls(box)).toEqual([])
    },
  )
  it('reads the new base policy, not the cached native policy or the candidate policy', () => {
    reset('policy', false)
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(run.gate).toEqual({ labels: ['reviewed'], autoMerge: null })
    expect(run.producers).toEqual([])
  })
  it('a newly malformed base policy clears the existing arm', () => {
    reset('malformed')
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'bad-landing', disarmed: true })
    expect(run.gate).toEqual(UNARMED)
  })
  it.each(['native', 'merge-on-green'] as const)(
    '%s lands against the fetched base tip that GitHub’s recorded baseRefOid predates',
    (mode) => {
      reset('moved', false)
      expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({ status: 'watching', mode })
      expect(run.gate.labels).toEqual(['reviewed'])
      expect(run.producers).toEqual([])
    },
  )
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses failed base acquisition instead of trusting the cached absence',
    (mode) => {
      reset()
      git(box, wt, ['remote', 'set-url', 'origin', path.join(box.root, 'missing-origin')])
      writeSim(box, (state) => {
        state.repositoryUrls = { [path.join(box.root, 'missing-origin')]: 'acme/app' }
      })
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unreadable',
        disarmed: true,
      })
      expect(run.result.error).toContain('fetch')
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
  it('acquisition fails on fetch failure even when both cached obligations are absent', () => {
    reset()
    git(box, wt, ['remote', 'set-url', 'origin', path.join(box.root, 'missing-origin')])
    writeSim(box, (state) => {
      state.repositoryUrls = { [path.join(box.root, 'missing-origin')]: 'acme/app' }
    })
    const run = acquire()
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('fetch')
    expect(producerCalls(box)).toEqual([])
  })
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a base that moves between selection and admission while baseRefOid still reports the selected tip',
    (mode) => {
      reset()
      const restore = mutateAfter(
        box,
        'admission-base-read',
        `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.configured)}], { env: process.env });`,
      )
      try {
        const run = land(box, wt, pr, mode)
        expect(run.result).toMatchObject({
          status: 'proof-blocked',
          producer: 'candidate',
          reason: 'unbound',
          disarmed: true,
        })
        expect(run.result.error).toContain(box.sha.configured)
        expect(run.result.error).toContain(box.sha.main)
        expect(run.gate).toEqual(UNARMED)
        expect(run.producers).toEqual([])
        expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      } finally {
        restore()
      }
    },
  )
  it.each([
    ['configured', 'semctx', 'ambiguous'],
    ['adapter', 'assertledger', 'missing'],
  ] as const)(
    'reads the established %s base object even if the tracking ref is rewritten between selection and admission',
    (next, producer, reason) => {
      reset(next)
      const restore = mutateAfter(
        box,
        'admission-base-read',
        `spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'update-ref', 'refs/remotes/origin/main', ${JSON.stringify(box.sha.main)}], { env: process.env });`,
      )
      try {
        const run = land(box, wt, pr)
        expect(run.result).toMatchObject({ status: 'proof-blocked', producer, reason, disarmed: true })
        expect(run.gate).toEqual(UNARMED)
        expect(run.producers).toEqual([])
      } finally {
        restore()
      }
    },
  )
  it('acquisition refuses base drift after reading applicability and before reporting reuse or absence', () => {
    reset()
    const restore = mutateAfter(
      box,
      'acquisition-comments',
      `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.configured)}], { env: process.env });`,
    )
    try {
      const run = acquire()
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('coordinates changed')
      expect(producerCalls(box)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('PARTIAL publication and revision must precede the approving review', () => {
  let box: Box
  const wt: Record<string, string> = {}
  const EARLY = '2026-01-01T00:00:00Z'
  const APPROVED = '2026-01-01T00:00:10Z'
  const LATE = '2026-01-01T00:00:20Z'
  const REAPPROVED = '2026-01-01T00:00:30Z'
  beforeAll(() => {
    box = sandbox(semctxSpec())
    instrument(box)
    for (const name of ['partial', 'largePartial', 'verified'] as const) {
      wt[name] = worktree(box, `chronology-${name}`, box.sha[SEMCTX_CASES[name].branch] as string)
    }
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function prime(name: 'partial' | 'largePartial' | 'verified') {
    const { pr, branch } = SEMCTX_CASES[name]
    const head = box.sha[branch] as string
    const parts = conserved(RECORDS.semctx, name)
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error(`missing fixture PR ${pr}`)
      pull.body = noTest('out-of-scope')
      pull.lastEditedAt = null
      pull.comments = [
        ...parts.map((body, index) => ({
          author: ME,
          body,
          createdAt: `2026-01-01T00:00:0${index}Z`,
          updatedAt: `2026-01-01T00:00:0${index}Z`,
        })),
        { author: ME, body: approve(head), createdAt: APPROVED, updatedAt: APPROVED },
      ]
      pull.labels = ['reviewed']
      pull.autoMerge = { enabledAt: EARLY, matchHeadCommit: head }
    })
    bindFixtureReview(box, pr)
    return { pr, head, parts }
  }
  function facts(pr: number, index: number, changed: { createdAt?: string | null; updatedAt?: string | null }) {
    writeSim(box, (state) => {
      const comment = state.prs[String(pr)]?.comments.at(index)
      if (!comment) throw new Error(`missing fixture comment ${pr}/${index}`)
      Object.assign(comment, changed)
    })
  }
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a later PARTIAL and admits only after a new same-head review, without a producer',
    (mode) => {
      const { pr, head } = prime('partial')
      facts(pr, 0, { createdAt: LATE, updatedAt: LATE })
      const refused = land(box, wt.partial as string, pr, mode)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'semctx',
        reason: 'unjustified',
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error(`missing fixture PR ${pr}`)
        pull.comments.push({
          author: ME,
          body: approve(head),
          createdAt: REAPPROVED,
          updatedAt: REAPPROVED,
        })
      })
      bindFixtureReview(box, pr)
      const admitted = land(box, wt.partial as string, pr, mode)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'PARTIAL' } } })
      expect(admitted.gate.labels).toEqual(['reviewed'])
      expect(admitted.producers).toEqual([])
    },
  )
  it.each([
    ['a late final part', -1, { createdAt: LATE, updatedAt: LATE }, 'unjustified'],
    ['its first part revised later', 0, { updatedAt: LATE }, 'unbound'],
    ['its final part revised later', -1, { updatedAt: LATE }, 'unbound'],
  ] as const)('the complete native multipart PARTIAL refuses with %s', (_name, index, changed, reason) => {
    const { pr, parts } = prime('largePartial')
    facts(pr, index < 0 ? parts.length - 1 : index, changed)
    const run = land(box, wt.largePartial as string, pr)
    expect(run.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'semctx',
      reason,
      disarmed: true,
    })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual([])
  })
  it.each([
    ['missing creation', { createdAt: null }, 'unreadable'],
    ['missing revision', { updatedAt: null }, 'unreadable'],
    ['malformed creation', { createdAt: 'not a native instant' }, 'unreadable'],
    ['malformed revision', { updatedAt: 'not a native instant' }, 'unreadable'],
    ['invalid calendar date', { createdAt: '2026-02-31T00:00:00Z' }, 'unreadable'],
    ['revision before creation', { updatedAt: '2025-12-31T23:59:59Z' }, 'unreadable'],
    ['creation tied with approval', { createdAt: APPROVED, updatedAt: APPROVED }, 'unjustified'],
  ] as const)('PARTIAL refuses %s facts', (_name, changed, reason) => {
    const { pr } = prime('partial')
    facts(pr, 0, changed)
    const run = land(box, wt.partial as string, pr)
    expect(run.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason, disarmed: true })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual([])
  })
  it('PARTIAL cannot borrow an approval whose native creation time is missing', () => {
    const { pr } = prime('partial')
    facts(pr, -1, { createdAt: null })
    const run = land(box, wt.partial as string, pr)
    expect(run.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'semctx',
      reason: 'unjustified',
      disarmed: true,
    })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual([])
  })
  it.each([
    ['late publication', { createdAt: LATE, updatedAt: LATE }, 'unjustified'],
    ['unreadable publication', { createdAt: null, updatedAt: null }, 'unreadable'],
    ['a revised native result', { updatedAt: LATE }, 'unbound'],
  ])('VERIFIED refuses %s facts and admits the original unmodified record', (_name, changed, reason) => {
    const { pr } = prime('verified')
    facts(pr, 0, changed)
    const refused = land(box, wt.verified as string, pr)
    expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason, disarmed: true })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])
    prime('verified')
    const admitted = land(box, wt.verified as string, pr)
    expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
    expect(admitted.producers).toEqual([])
  })
  it('a PARTIAL edited into a coherent VERIFIED body cannot borrow its approval', () => {
    const { pr, head } = prime('partial')
    const source = findRecord(
      conserved(RECORDS.semctx, 'partial').map((body) => ({ author: { login: ME }, body })),
      ME,
      'semctx',
      head,
    )
    if (!('record' in source)) throw new Error('missing native PARTIAL fixture')
    const record: SemctxRecord = JSON.parse(JSON.stringify(source.record))
    const step = record.native.find((entry) => entry.argv.includes('verify'))
    if (!step) throw new Error('missing verify output')
    const result: {
      verdict: string
      findings: unknown[]
      pendingEvidence: { id: string }[]
      openUnknowns: unknown[]
      provedEvidence: { id: string }[]
    } = JSON.parse(step.stdout)
    result.verdict = 'VERIFIED'
    result.findings = []
    result.provedEvidence = result.pendingEvidence.map((evidence) => ({ ...evidence, proved: true, status: 'tested' }))
    result.pendingEvidence = []
    result.openUnknowns = []
    step.stdout = JSON.stringify(result)
    const bodies = renderRecord('semctx', head, [], record)
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('missing PR')
      pull.comments.splice(
        0,
        source.parts.length,
        ...bodies.map((body) => ({
          author: ME,
          body,
          createdAt: EARLY,
          updatedAt: LATE,
        })),
      )
    })
    const refused = land(box, wt.partial as string, pr)
    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'semctx',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])
    prime('partial')
    const admitted = land(box, wt.partial as string, pr)
    expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'PARTIAL' } } })
    expect(admitted.producers).toEqual([])
  })
  it('only the selected complete run is judged: an older run’s late revision does not taint the reviewed replacement', () => {
    const { pr, parts } = prime('largePartial')
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error(`missing fixture PR ${pr}`)
      pull.comments.unshift(
        ...parts.map((body, index) => ({
          author: ME,
          body,
          createdAt: `2025-12-31T23:59:5${index}Z`,
          updatedAt: LATE,
        })),
      )
    })
    const run = land(box, wt.largePartial as string, pr)
    expect(run.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'PARTIAL' } } })
    expect(run.producers).toEqual([])
  })
  it('acquisition reuses an unmodified result but never reuses a revised result', () => {
    const { pr } = prime('verified')
    const acquire = () =>
      spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], {
        cwd: wt.verified,
        env: box.env,
        encoding: 'utf8',
      })
    const reusable = acquire()
    expect(reusable.status).toBe(0)
    expect(JSON.parse(reusable.stdout)).toMatchObject({ semctx: 'reused' })
    expect(producerCalls(box)).toEqual([])
    facts(pr, 0, { updatedAt: LATE })
    const revised = acquire()
    expect(revised.status).toBe(1)
    expect(revised.stderr).toContain('--version failed')
    expect(producerCalls(box)).toEqual(['semctx --version'])
  })

  describe('exact review inputs', () => {
    beforeAll(() => rmSync(path.join(box.root, 'producer-calls.log'), { force: true }))
    function dir(name: 'partial' | 'largePartial' | 'verified'): string {
      const value = wt[name]
      if (!value) throw new Error(`missing checkout ${name}`)
      return value
    }
    function approvalInput(pr: number): string {
      const body = readSim(box).prs[String(pr)]?.comments.at(-1)?.body
      const input = body?.split('\n')[2]
      if (!input?.startsWith('<!-- omp-build:review-input')) throw new Error('missing captured approval input')
      return input
    }
    function unchanged(name: 'partial' | 'largePartial' | 'verified', pr: number): void {
      const allowed = land(box, dir(name), pr)
      expect(allowed.result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: name === 'verified' ? 'VERIFIED' : 'PARTIAL' } },
      })
      expect(allowed.producers).toEqual([])
    }
    function unbound(name: 'partial' | 'largePartial' | 'verified', pr: number): void {
      const refused = land(box, dir(name), pr)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unbound',
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
    }

    it('refuses a body changed during panel work even when its native edit timestamp is unchanged', () => {
      const { pr, head } = prime('partial')
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        pull.lastEditedAt = EARLY
      })
      bindFixtureReview(box, pr)
      const retained = approvalInput(pr)
      const captured = workflowRead(box, dir('partial'), pr, head, 'captureReviewInput')
      expect(captured).toMatchObject({
        ok: true,
        input: retained,
        body: { body: noTest('out-of-scope'), lastEditedAt: EARLY },
      })
      expect(workflowRead(box, dir('partial'), pr, head, 'validateReviewInput', retained)).toEqual({ ok: true })
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        pull.body += '\nChanged support read during the panel.\n'
      })
      expect(workflowRead(box, dir('partial'), pr, head, 'validateReviewInput', retained)).toMatchObject({
        ok: false,
        reason: 'unbound',
      })
      unbound('partial', pr)
      prime('partial')
      unchanged('partial', pr)
    })

    it('refuses restored body text whose lastEditedAt changed before approval', () => {
      const { pr, head } = prime('partial')
      const retained = approvalInput(pr)
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        // The text is restored; a later native revision still was not the captured input.
        pull.lastEditedAt = '2026-01-01T00:00:05Z'
      })
      expect(workflowRead(box, dir('partial'), pr, head, 'validateReviewInput', retained)).toMatchObject({
        ok: false,
        reason: 'unbound',
      })
      unbound('partial', pr)
      prime('partial')
      unchanged('partial', pr)
    })

    it('binds the selected VERIFIED part bytes even when parsing and native timestamps do not change', () => {
      const { pr } = prime('verified')
      writeSim(box, (state) => {
        const part = state.prs[String(pr)]?.comments[0]
        if (!part) throw new Error('missing proof')
        part.body = part.body.replace('## Proof — semctx', '## Proof — semctx\nChanged producer summary.')
      })
      unbound('verified', pr)
      prime('verified')
      unchanged('verified', pr)
    })

    it('a coherent PARTIAL-to-VERIFIED rewrite cannot disable the exact read binding', () => {
      const { pr, head, parts } = prime('partial')
      const json = parts[0]?.match(/^```json\n([\s\S]*?)\n```/m)?.[1]
      if (!json) throw new Error('missing native single-part JSON frame')
      const record: SemctxRecord = JSON.parse(json)
      const step = record.native.find((entry) => entry.argv.includes('verify'))
      if (!step) throw new Error('missing native verification')
      const result: {
        verdict: string
        findings: unknown[]
        pendingEvidence: { id: string }[]
        openUnknowns: unknown[]
        provedEvidence: { id: string }[]
      } = JSON.parse(step.stdout)
      result.verdict = 'VERIFIED'
      result.findings = []
      result.provedEvidence = result.pendingEvidence.map((evidence) => ({
        ...evidence,
        proved: true,
        status: 'tested',
      }))
      result.pendingEvidence = []
      result.openUnknowns = []
      step.stdout = JSON.stringify(result)
      const rewritten = renderRecord('semctx', head, [], record)
      if (rewritten.length !== 1 || !rewritten[0]) throw new Error('expected one replacement part')
      const replacement = rewritten[0]
      writeSim(box, (state) => {
        const part = state.prs[String(pr)]?.comments[0]
        if (!part) throw new Error('missing selected part')
        part.body = replacement
      })
      unbound('partial', pr)
      prime('partial')
      unchanged('partial', pr)
    })

    it('binds the native identity of each selected multipart publication', () => {
      const { pr } = prime('largePartial')
      writeSim(box, (state) => {
        const part = state.prs[String(pr)]?.comments[1]
        if (!part?.id) throw new Error('missing native second-part identity')
        part.id += 1_000_000
      })
      unbound('largePartial', pr)
      prime('largePartial')
      unchanged('largePartial', pr)
    })

    it('keeps tied-time multipart selection stable across presentation order and refuses a newer incomplete run', () => {
      const { pr, head, parts } = prime('largePartial')
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        for (const part of pull.comments.filter((comment) => comment.body.startsWith(proofMark('semctx')))) {
          part.createdAt = EARLY
          part.updatedAt = EARLY
        }
      })
      bindFixtureReview(box, pr)
      const retained = approvalInput(pr)
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        pull.comments.reverse()
      })
      expect(workflowRead(box, dir('largePartial'), pr, head, 'validateReviewInput', retained)).toEqual({ ok: true })
      unchanged('largePartial', pr)
      const first = parts[0]
      if (!first) throw new Error('missing first native part')
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        pull.comments.push({ author: ME, body: first, createdAt: EARLY, updatedAt: EARLY })
      })
      const refused = land(box, dir('largePartial'), pr)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'semctx',
        reason: 'missing',
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      prime('largePartial')
      unchanged('largePartial', pr)
    })

    it.each([
      ['no line-3 marker', null, 'missing'],
      ['unsupported marker version', '<!-- omp-build:review-input v=2 sha256=abc -->', 'unreadable'],
    ] as const)('applicable proof refuses %s rather than upgrading old approval', (_label, marker, reason) => {
      const { pr } = prime('verified')
      writeSim(box, (state) => {
        const comment = state.prs[String(pr)]?.comments.at(-1)
        if (!comment) throw new Error('missing review')
        const lines = comment.body.split('\n')
        if (marker === null) lines.splice(2, 1)
        else lines[2] = marker
        comment.body = lines.join('\n')
      })
      const refused = land(box, dir('verified'), pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason, disarmed: true })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      prime('verified')
      unchanged('verified', pr)
    })
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

  it('reuses the native input range of the established base, not a subsequently rewritten tracking ref', () => {
    const { pr, branch } = SEMCTX_CASES.verified
    prepare(box, pr, { comments: [approve(sha(branch)), ...conserved(RECORDS.semctx, 'verified')] })
    const restore = mutateAfter(
      box,
      'repository-read',
      `spawnSync('git', ['-C', ${JSON.stringify(wt.verified)}, 'update-ref', 'refs/remotes/origin/main', ${JSON.stringify(sha(branch))}], { env: process.env });`,
    )
    try {
      const run = land(box, wt.verified as string, pr)
      expect(run.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
      expect(run.gate).toEqual({
        labels: ['reviewed'],
        autoMerge: expect.objectContaining({ matchHeadCommit: sha(branch) }),
      })
      expect(run.producers).toEqual([])
    } finally {
      restore()
      git(box, wt.verified as string, ['update-ref', 'refs/remotes/origin/main', sha('main')])
    }
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

    it.each([
      ['another gap’s headed browser check', '### Browser check `proof.fx.other-test`'],
      ['another gap’s bare browser check', 'Browser check `proof.fx.other-test`'],
      ['the next section', '## Test plan'],
    ])('a browser check ends at %s: its observed result is its own, never borrowed', (_label, next) => {
      const comments = [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')]
      const body = (own: string) =>
        `${noTest('ui-manual-only')}\n### Browser check \`${GAP}\`\n- Steps: open the calculator, add 1 and Infinity\n- URL: http://localhost:3000/add\n${own}\n${next}\n- Observed: RangeError shown\n`
      prepare(box, pr, { comments, body: body('') })
      const borrowed = land(box, wt.partial as string, pr)
      expect(borrowed.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(borrowed.result.error).toMatch(/lacks the observed result/)
      expect(borrowed.gate).toEqual(UNARMED)
      prepare(box, pr, { comments, body: body('- Observed: RangeError shown\n') })
      const own = land(box, wt.partial as string, pr)
      expect(own.result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: 'PARTIAL', gaps: [{ gap: GAP, reason: 'ui-manual-only' }] } },
      })
      expect([...borrowed.producers, ...own.producers]).toEqual([])
    })

    it('a browser check URL must be http(s), not merely carry a host', () => {
      const comments = [approve(sha(branch)), ...conserved(RECORDS.semctx, 'partial')]
      prepare(box, pr, { comments, body: browser({ url: 'ftp://example.com/add' }) })
      const ftp = land(box, wt.partial as string, pr)
      expect(ftp.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
      expect(ftp.result.error).toMatch(/lacks a valid http\(s\) URL/)
      expect(ftp.gate).toEqual(UNARMED)
      prepare(box, pr, { comments, body: browser({ url: 'https://example.com/add' }) })
      const https = land(box, wt.partial as string, pr)
      expect(https.result).toMatchObject({
        status: 'watching',
        proof: { semctx: { verdict: 'PARTIAL', gaps: [{ gap: GAP, reason: 'ui-manual-only' }] } },
      })
      expect([...ftp.producers, ...https.producers]).toEqual([])
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
      bindFixtureReview(box, pr)
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
      const { result, gate, producers } = land(box, wt[name] as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'ambiguous' })
      expect(result.error).toMatch(error)
      expect(gate).toEqual(UNARMED)
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
        for (const comment of state.prs[String(verified.pr)]?.comments ?? [])
          if (comment.body.includes('## Proof — semctx')) comment.author = 'mallory'
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
      const { result, gate } = land(box, wt.partial as string, verified.pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(result.error).toContain(
        `the local tip ${sha(SEMCTX_CASES.partial.branch)} is not candidate ${sha(verified.branch)}`,
      )
      expect(gate).toEqual(UNARMED)
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

describe('assertledger acquisition binds the exact replayed manifest bytes', () => {
  let box: Box
  let wt: string
  const { pr, branch } = LEDGER_CASES.detection
  let valid: string
  let invalid: string
  let exporter: string
  let replay: ReplayCapture
  beforeAll(() => {
    box = sandbox(ledgerSpec())
    instrument(box)
    wt = worktree(box, 'immutable-manifest', box.sha[branch] as string)
    const found = findRecord(
      conserved(RECORDS.assertledger, 'detection').map((body) => ({ author: { login: ME }, body })),
      ME,
      'assertledger',
      box.sha[branch] as string,
    )
    if (!('record' in found) || !RECORDS.assertledger.replays)
      throw new Error('native replay counterparts are missing; regenerate capture.ts')
    valid = (found.record as AssertledgerRecord).native.manifest
    replay = RECORDS.assertledger.replays
    invalid = valid.replace(replay.token.from, replay.token.to)
    if (invalid === valid) throw new Error('the native replay counterpart does not match this manifest')
    exporter = path.join(box.root, 'exporter.json')
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function acquire(manifest = true) {
    return spawnSync(
      REAL_BUN,
      [ACQUIRE, '--pr', String(pr), ...(manifest ? ['--assertledger-manifest', exporter] : [])],
      { cwd: wt, env: box.env, encoding: 'utf8' },
    )
  }
  function mutateExporterAtVersion(to: string): void {
    writeFileSync(
      path.join(box.root, 'producers', 'assertledger'),
      `#!${REAL_BUN}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(path.join(box.root, 'producer-calls.log'))}, 'assertledger ' + args.join(' ') + '\\n')
if (args[0] === '--version') {
  writeFileSync(${JSON.stringify(exporter)}, ${JSON.stringify(to)})
  process.stdout.write(${JSON.stringify(replay.version.stdout)})
  process.exit(${JSON.stringify(replay.version.code)})
}
if (args[0] !== 'replay' || args[2] !== '--json') throw new Error('unexpected native replay invocation')
const bytes = readFileSync(args[1], 'utf8')
const result = bytes === ${JSON.stringify(valid)} ? ${JSON.stringify(replay.valid)}
  : bytes === ${JSON.stringify(invalid)} ? ${JSON.stringify(replay.invalid)} : null
if (!result) throw new Error('no genuinely observed native replay for these bytes')
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(result.code)
`,
    )
  }
  it('an invalid captured manifest cannot borrow a valid replay from its overwritten exporter', () => {
    const head = box.sha[branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n', armed: head })
    writeFileSync(exporter, invalid)
    mutateExporterAtVersion(valid)
    const acquired = acquire()
    expect(acquired.status).toBe(1)
    const before = producerCalls(box)
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'assertledger',
      reason: 'missing',
      disarmed: true,
    })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual(before)
  })
  it('a valid captured manifest remains a detection when the exporter changes, and is reused without replay', () => {
    const head = box.sha[branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n' })
    writeFileSync(exporter, valid)
    mutateExporterAtVersion(invalid)
    const acquired = acquire()
    expect(acquired.status).toBe(0)
    expect(JSON.parse(acquired.stdout)).toMatchObject({ assertledger: 'posted' })
    const before = producerCalls(box)
    const resumed = acquire(false)
    expect(resumed.status).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ assertledger: 'reused' })
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('missing PR')
      pull.comments.push({ author: ME, body: approve(head) })
    })
    bindFixtureReview(box, pr)
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'watching', proof: { assertledger: 'detection' } })
    expect(run.gate).toEqual({ labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head }) })
    expect(run.producers).toEqual(before)
  })
  it('stops publishing once the base moves, though baseRefOid still reports the selected tip', () => {
    const head = box.sha[branch] as string
    const moved = box.sha[LEDGER_CASES.weak.branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n' })
    writeFileSync(exporter, valid)
    mutateExporterAtVersion(valid)
    const restore = mutateAfter(
      box,
      'comment-write',
      `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(moved)}], { env: process.env });`,
    )
    try {
      const acquired = acquire()
      expect(acquired.status).toBe(1)
      expect(acquired.stderr).toContain('coordinates changed')
      expect(acquired.stderr).toContain(`main@${box.sha.main} → ${moved}`)
      expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
    } finally {
      restore()
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    }
  })
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
          name: 'staging',
          from: 'main',
          commits: [{ message: 'chore: staging', files: { 'STAGING.md': 'staging\n' } }],
        },
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
  it.each([
    ['a recorded edit', '2026-01-01T00:00:00Z', '2026-01-01T00:00:20Z', 'unbound'],
    ['a late publication', '2026-01-01T00:00:20Z', '2026-01-01T00:00:20Z', 'unjustified'],
    ['unreadable publication', null, null, 'unreadable'],
  ] as const)(
    'a detection refuses %s, while its unmodified reviewed counterpart admits',
    (_name, createdAt, updatedAt, reason) => {
      const head = sha(detection.branch)
      const dir = wt.detection
      if (!dir) throw new Error('missing detection checkout')
      const prime = () =>
        prepare(box, detection.pr, {
          comments: [...conserved(RECORDS.assertledger, 'detection'), approve(head)],
          body: 'Closes #2\n',
          armed: head,
        })
      prime()
      writeSim(box, (state) => {
        const pull = state.prs[String(detection.pr)]
        if (!pull?.comments[0] || !pull.comments[1]) throw new Error('missing detection fixture')
        Object.assign(pull.comments[0], { createdAt, updatedAt })
        Object.assign(pull.comments[1], { createdAt: '2026-01-01T00:00:10Z', updatedAt: '2026-01-01T00:00:10Z' })
      })
      const refused = land(box, dir, detection.pr)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'assertledger',
        reason,
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      prime()
      const admitted = land(box, dir, detection.pr)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { assertledger: 'detection' } })
      expect(admitted.producers).toEqual([])
    },
  )
  it('a WEAK_ORACLE edited into detection cannot borrow the approving review', () => {
    const head = sha(detection.branch)
    const dir = wt.detection
    if (!dir) throw new Error('missing detection checkout')
    const native = findRecord(
      conserved(RECORDS.assertledger, 'detection').map((body) => ({ author: { login: ME }, body })),
      ME,
      'assertledger',
      head,
    )
    if (!('record' in native)) throw new Error('missing detection record')
    const record: AssertledgerRecord = JSON.parse(JSON.stringify(native.record))
    const manifest: { decision: { status: string }; candidates: { status: string }[] } = JSON.parse(
      record.native.manifest,
    )
    manifest.decision.status = 'PARTIAL'
    for (const candidate of manifest.candidates) candidate.status = 'WEAK_ORACLE'
    record.native.manifest = JSON.stringify(manifest)
    prepare(box, detection.pr, {
      comments: [...renderRecord('assertledger', head, [], record), approve(head)],
      body: 'Closes #2\n',
      armed: head,
    })
    const weakRun = land(box, dir, detection.pr)
    expect(weakRun.result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'verdict' })
    writeSim(box, (state) => {
      const pull = state.prs[String(detection.pr)]
      const comment = pull?.comments[0]
      if (!pull || !comment) throw new Error('missing proof comment')
      const body = conserved(RECORDS.assertledger, 'detection')[0]
      if (!body) throw new Error('missing conserved detection body')
      comment.body = body
      comment.updatedAt = '2030-01-01T00:00:00Z'
      pull.labels = ['reviewed']
      pull.autoMerge = { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: head }
    })
    const refused = land(box, dir, detection.pr)
    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'assertledger',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])
    prepare(box, detection.pr, {
      comments: [...conserved(RECORDS.assertledger, 'detection'), approve(head)],
      body: 'Closes #2\n',
    })
    expect(land(box, dir, detection.pr).result).toMatchObject({ status: 'watching' })
  })
  it('acquisition rejects revised detection reuse and requests its manifest again', () => {
    const head = sha(detection.branch)
    const dir = wt.detection
    if (!dir) throw new Error('missing detection checkout')
    prepare(box, detection.pr, {
      comments: [...conserved(RECORDS.assertledger, 'detection'), approve(head)],
      body: 'Closes #2\n',
    })
    const acquire = () =>
      spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(detection.pr)], {
        cwd: dir,
        env: box.env,
        encoding: 'utf8',
      })
    const reusable = acquire()
    expect(reusable.status).toBe(0)
    expect(JSON.parse(reusable.stdout)).toMatchObject({ assertledger: 'reused' })
    writeSim(box, (state) => {
      const comment = state.prs[String(detection.pr)]?.comments[0]
      if (!comment) throw new Error('missing detection comment')
      comment.updatedAt = '2030-01-01T00:00:00Z'
    })
    const revised = acquire()
    expect(revised.status).toBe(1)
    expect(revised.stderr).toContain('--assertledger-manifest')
    expect(producerCalls(box)).toEqual([])
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

  describe('a fix is any fix signal of the head branch, a closing ticket or the ticket the branch names', () => {
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

    it('a reviewed detection binding refuses once the ticket is reclassified out of fix; re-review admits', () => {
      shape('feat/2-clamp', { ...NEUTRAL, issueType: 'Bug' })
      const candidate = sha(detection.branch)
      const records = {
        comments: [approve(candidate), ...conserved(RECORDS.assertledger, 'detection')],
        body: 'Closes #2\n',
      }
      prepare(box, detection.pr, records)
      shape('feat/2-clamp', { ...NEUTRAL, title: 'feat: clamp', issueType: 'feat' })
      const refused = land(box, wt.detection as string, detection.pr)
      expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(refused.gate).toEqual(UNARMED)
      prepare(box, detection.pr, records)
      const admitted = land(box, wt.detection as string, detection.pr)
      expect(admitted.result).toMatchObject({
        status: 'watching',
        proof: { semctx: 'absent', assertledger: 'not-applicable' },
      })
      expect([...refused.producers, ...admitted.producers]).toEqual([])
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

    it('a PR into another base, whose closing keywords GitHub does not link, is classified by the ticket its branch names', () => {
      shape('feat/2-clamp', { ...NEUTRAL, labels: ['size:F-lite', 'bug'] })
      const retarget = (base: string) =>
        writeSim(box, (state) => {
          const pull = state.prs[String(detection.pr)]
          if (!pull) throw new Error('PR #20 is missing')
          pull.baseRefName = base
        })
      retarget('staging')
      try {
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
      } finally {
        retarget('main')
      }
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
  it('exact review inputs include the assertledger publication, not only Semctx or PARTIAL', () => {
    const candidate = box.sha[branch]
    if (!candidate) throw new Error('missing dual-producer head')
    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n', armed: candidate })
    writeSim(box, (state) => {
      const part = state.prs[String(pr)]?.comments.find((comment) => comment.body.startsWith(proofMark('assertledger')))
      if (!part) throw new Error('missing native assertledger publication')
      part.body = part.body.replace('## Proof — assertledger', '## Proof — assertledger\nChanged assertledger summary.')
    })
    const refused = land(box, dir, pr)
    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'candidate',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])
    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n' })
    const admitted = land(box, dir, pr)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: { verdict: 'VERIFIED' }, assertledger: 'detection' },
    })
    expect(admitted.producers).toEqual([])
  })
})

describe('Kit-only adapter presence does not make a shell/CP fix owe AssertLedger detection', () => {
  const PR = 809
  const CONFIGURED_PR = 810
  const KIT_ADAPTER = 'scripts/kit/assertledger/vitest-adapter.mjs'
  const CP_GATE = 'scripts/kit/check-cp.sh'
  const shellGate = (result: 'old' | 'fixed') =>
    `#!/bin/sh\nprintf '${result} CP gate\\n'\n${result === 'old' ? 'exit 1' : 'exit 0'}\n`
  let box: Box
  let kit: string
  let stale: string
  let configured: string
  const sha = (branch: string) => box.sha[branch] as string

  beforeAll(() => {
    box = sandbox({
      base: {
        '.dev/stack.yml': STACK,
        [KIT_ADAPTER]: "export const adapter = 'vitest'\n",
        [CP_GATE]: shellGate('old'),
      },
      branches: [
        {
          name: 'fix/809-kit-shell',
          from: 'main',
          commits: [{ message: 'fix: harden CP shell gate (#809)', files: { [CP_GATE]: shellGate('fixed') } }],
        },
        {
          name: 'fix/809-kit-shell-stale-review',
          from: 'fix/809-kit-shell',
          commits: [
            { message: 'test: cover CP shell gate (#809)', files: { [CP_GATE]: `${shellGate('fixed')}# covered\n` } },
          ],
        },
        {
          name: 'fix/809-kit-configured',
          from: 'main',
          commits: [
            {
              message: 'fix: configure CP regression campaign (#809)',
              files: {
                [CP_GATE]: shellGate('fixed'),
                'assertledger.config.json': LEDGER_BASE['assertledger.config.json'] as string,
              },
            },
          ],
        },
      ],
      issues: [{ number: PR, title: 'fix: harden CP shell gate', issueType: 'fix' }],
      prs: [
        {
          number: PR,
          branch: 'fix/809-kit-shell',
          title: 'fix: harden CP shell gate',
          body: 'Closes #809\n',
          closes: [PR],
        },
        {
          number: CONFIGURED_PR,
          branch: 'fix/809-kit-configured',
          title: 'fix: configure CP regression campaign',
          body: 'Closes #809\n',
          closes: [PR],
        },
      ],
    })
    instrument(box)
    kit = worktree(box, 'kit-shell', sha('fix/809-kit-shell'))
    stale = worktree(box, 'kit-shell-stale', sha('fix/809-kit-shell-stale-review'))
    configured = worktree(box, 'kit-configured', sha('fix/809-kit-configured'))
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it.each(['native', 'merge-on-green'] as const)(
    '%s keeps its approval and configured CI gate while admitting the Kit-only shell/CP fix',
    (mode) => {
      const head = sha('fix/809-kit-shell')
      prepare(box, PR, { comments: [approve(head)], body: 'Closes #809\n' })

      const run = land(box, kit, PR, mode)

      expect(run.result).toMatchObject({
        status: 'watching',
        mode,
        proof: { semctx: 'absent', assertledger: 'not-applicable' },
      })
      expect(run.gate).toEqual(
        mode === 'native'
          ? { labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head }) }
          : { labels: ['reviewed'], autoMerge: null },
      )
      expect(readSim(box).prs[String(PR)]?.state).toBe('OPEN')
      expect(run.producers).toEqual([])
    },
  )

  it('acquires no fake manifest or AssertLedger publication for the Kit-only shell/CP fix', () => {
    const head = sha('fix/809-kit-shell')
    prepare(box, PR, { comments: [approve(head)], body: 'Closes #809\n' })

    const acquired = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(PR)], {
      cwd: kit,
      env: box.env,
      encoding: 'utf8',
    })

    expect(acquired.status).toBe(0)
    expect(JSON.parse(acquired.stdout)).toMatchObject({
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    })
    expect(
      readSim(box).prs[String(PR)]?.comments.some((comment) => comment.body.startsWith(proofMark('assertledger'))),
    ).toBe(false)
    expect(producerCalls(box)).toEqual([])
  })

  it('refuses a retained stale review binding, then admits a fresh no-producer Kit-only review', () => {
    const staleHead = sha('fix/809-kit-shell-stale-review')
    const staleMarker =
      '<!-- omp-build:review-input v=1 sha256=0000000000000000000000000000000000000000000000000000000000000000 -->'
    writeSim(box, (state) => {
      const pull = state.prs[String(PR)]
      if (!pull) throw new Error('missing Kit PR')
      pull.headRefName = 'fix/809-kit-shell-stale-review'
      pull.headRefOid = staleHead
      pull.baseRecord = { at: `main@${staleHead}`, oid: box.sha.main as string }
    })
    prepare(box, PR, { comments: [approve(staleHead)], body: 'Closes #809\n', armed: staleHead, binding: false })
    writeSim(box, (state) => {
      const comment = state.prs[String(PR)]?.comments.at(-1)
      if (!comment) throw new Error('missing stale Kit review')
      const lines = comment.body.split('\n')
      lines.splice(2, 0, staleMarker)
      comment.body = lines.join('\n')
    })

    const refused = land(box, stale, PR)

    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'candidate',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(readSim(box).prs[String(PR)]?.comments.at(-1)?.body).toContain(staleMarker)
    expect(refused.producers).toEqual([])

    prepare(box, PR, { comments: [approve(staleHead)], body: 'Closes #809\n' })
    const captured = workflowRead(box, stale, PR, staleHead, 'captureReviewInput')
    expect(captured).toMatchObject({ ok: true, input: null, semctx: null, assertledger: null })

    const admitted = land(box, stale, PR)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: 'absent', assertledger: 'not-applicable' },
    })
    expect(admitted.gate.labels).toEqual(['reviewed'])
    expect(admitted.producers).toEqual([])
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses the missing detection when the Kit candidate explicitly declares a root configuration',
    (mode) => {
      const head = sha('fix/809-kit-configured')
      prepare(box, CONFIGURED_PR, { comments: [approve(head)], body: 'Closes #809\n', armed: head })

      const run = land(box, configured, CONFIGURED_PR, mode)

      expect(run.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'assertledger',
        reason: 'missing',
        disarmed: true,
      })
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
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
  ])('genuine absence, from %s, makes only Semctx non-applicable', (_label, cwd) => {
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    const { result, calls, gate } = land(box, cwd(), PR)
    expect(result).toMatchObject({ status: 'watching', proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    expect(gate.labels).toEqual(['reviewed'])
    expect(calls.some((args) => args.includes('graphql'))).toBe(false)
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
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: box.env }).trim()
      mkdirSync(bin)
      const shim = path.join(bin, 'git')
      // Run real Git unchanged, then inject the filesystem race immediately
      // before admission stats .semctx. No Git answer or absence is fabricated.
      writeFileSync(
        shim,
        `#!/bin/sh\n'${realGit}' "$@"\ncode=$?\nif [ "$3" = ls-tree ] && [ "$7" = '${box.sha.main}^{commit}' ]; then chmod 000 '${box.principal}'; fi\nexit "$code"\n`,
      )
      chmodSync(shim, 0o755)
      const originalPath = box.env.PATH
      box.env.PATH = `${bin}:${originalPath}`
      try {
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
