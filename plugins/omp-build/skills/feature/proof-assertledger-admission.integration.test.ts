import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEDGER_CASES, ledgerSpec } from './__fixtures__/proof/sandbox-assertledger'
import { ACQUIRE, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import type { Box } from './__fixtures__/proof/sandbox-types'
import type { AssertledgerRecord } from './proof-assertledger'
import {
  approve,
  conserved,
  decodeFixtureProof,
  encodeFixtureProof,
  proofFramePrefix,
  RECORDS,
} from './testing/proof-integration/data'
import { ME, REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { mutateAfter } from './testing/proof-integration/mutation'
import { instrument, prepare, producerCalls, rewriteProducerProofs } from './testing/proof-integration/setup'

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
        const detectionComment = pull?.comments.find((entry) => entry.body.startsWith(proofFramePrefix('assertledger')))
        if (!pull || !detectionComment) throw new Error('missing detection fixture')
        Object.assign(detectionComment, { createdAt, updatedAt })
        for (const comment of pull.comments.filter(
          (entry) => !entry.body.startsWith(proofFramePrefix('assertledger')),
        )) {
          Object.assign(comment, { createdAt: '2026-01-01T00:00:10Z', updatedAt: '2026-01-01T00:00:10Z' })
        }
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
    const native = decodeFixtureProof(
      conserved(RECORDS.assertledger, 'detection').map((body) => ({ author: { login: ME }, body })),
      'assertledger',
      head,
      detection.pr,
    )
    const record: AssertledgerRecord = JSON.parse(JSON.stringify(native.record))
    const manifest: { decision: { status: string }; candidates: { status: string }[] } = JSON.parse(
      record.native.manifest,
    )
    manifest.decision.status = 'PARTIAL'
    for (const candidate of manifest.candidates) candidate.status = 'WEAK_ORACLE'
    record.native.manifest = JSON.stringify(manifest)
    prepare(box, detection.pr, {
      comments: [...encodeFixtureProof('assertledger', head, record), approve(head)],
      body: 'Closes #2\n',
      armed: head,
    })
    const weakRun = land(box, dir, detection.pr)
    expect(weakRun.result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'verdict' })
    writeSim(box, (state) => {
      const pull = state.prs[String(detection.pr)]
      const comment = pull?.comments.find((entry) => entry.body.startsWith(proofFramePrefix('assertledger')))
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
      const comment = state.prs[String(detection.pr)]?.comments.find((entry) =>
        entry.body.startsWith(proofFramePrefix('assertledger')),
      )
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
  ] as const)('%s refuses, unarmed', (_label, pr, branch, name, reason, error) => {
    const comments = [approve(sha(branch)), ...(name ? conserved(RECORDS.assertledger, name, pr) : [])]
    prepare(box, pr, { comments, body: 'Closes #2\n' })
    const { result, gate } = land(box, wt[branch === weak.branch ? 'weak' : 'detection'] as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason })
    if (error) expect(result.error).toMatch(error)
    expect(gate).toEqual(UNARMED)
  })

  it('the detection record of another candidate refuses, unarmed', () => {
    prepare(box, weak.pr, { comments: [approve(sha(weak.branch))], body: 'Closes #2\n' })
    rewriteProducerProofs(box, weak.pr, conserved(RECORDS.assertledger, 'detection', weak.pr))
    const { result, gate } = land(box, wt.weak as string, weak.pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
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
    // closes stays []; bind via explicit Spec issue #2 — Closes nodes are diagnostic only.
    prepare(box, 24, { comments: [approve(sha(detection.branch))], body: 'x', specIssue: 2 })
    const { result, gate } = land(box, wt.detection as string, 24)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', ...expected })
    expect(gate).toEqual(UNARMED)
  })
})
