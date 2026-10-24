import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, readSim, sandbox, worktree } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox-semctx-base'
import { SEMCTX_CASES, semctxSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import type { SemctxRecord } from './proof-semctx-protocol'
import {
  approve,
  conserved,
  decodeFixtureProof,
  encodeFixtureProof,
  fixtureReviewBodies,
  RECORDS,
} from './testing/proof-integration/data'
import { GAP, ME } from './testing/proof-integration/environment'
import { browser, land, noTest, UNARMED } from './testing/proof-integration/landing'
import { mutateAfter } from './testing/proof-integration/mutation'
import { bindFixtureReview, instrument, prepare, producerCalls } from './testing/proof-integration/setup'

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
      for (const body of fixtureReviewBodies(pr, approve(sha(branch)))) {
        execFileSync('gh', ['pr', 'comment', String(pr), '--body', body], { cwd: dir, env: box.env })
      }
      bindFixtureReview(box, pr, [approve(sha(branch))])
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
      const found = decodeFixtureProof(
        parts.map((body) => ({ author: { login: ME }, body })),
        'semctx',
        sha(branch),
        pr,
      )
      // Controlled provider-input mutation, not a claim that this test ran Semctx.
      const record = structuredClone(found.record) as SemctxRecord
      const before = record.native[1]
      if (!before) throw new Error('the conserved record has no pre-run status')
      before.stdout = JSON.stringify({ ...JSON.parse(before.stdout), verdict: 'STALE' })
      const newer = encodeFixtureProof('semctx', sha(branch), record)
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
})
