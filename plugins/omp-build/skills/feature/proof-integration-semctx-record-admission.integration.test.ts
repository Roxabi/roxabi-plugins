import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, readSim, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CONFIG, STACK, STACK_E2E } from './__fixtures__/proof/sandbox-semctx-base'
import { SEMCTX_CASES, semctxSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import type { SemctxRecord } from './proof-semctx-protocol'
import {
  approve,
  conserved,
  decodeFixtureProof,
  encodeFixtureProof,
  proofFramePrefix,
  RECORDS,
  red,
} from './testing/proof-integration/data'
import { GAP, ME } from './testing/proof-integration/environment'
import { browser, land, noTest, UNARMED } from './testing/proof-integration/landing'
import { instrument, prepare, rewriteProducerProofs } from './testing/proof-integration/setup'

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
      // Seed approval without producer frames (config change makes capture fail); then post
      // conserved bytes so land still refuses before reading any record.
      prepare(box, pr, { comments: [approve(sha(`fix/1-${name}`))] })
      rewriteProducerProofs(box, pr, conserved(RECORDS.semctx, 'verified'))
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
    ['a draft change', 'draft', undefined],
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
    if (error) expect(result.error).toMatch(error)
    expect(gate).toEqual(UNARMED)
    expect(producers).toEqual([])
  })

  it('a non-change block in a contract file is never recorded, so the candidate has no proof', () => {
    expect(RECORDS.semctx.records.mixed).toMatchObject({ code: 1 })
    expect(RECORDS.semctx.records.mixed?.stderr).toMatch(
      /change inspect change\.fx\.note .*no change contract "change\.fx\.note"/s,
    )
    const { pr, branch } = SEMCTX_CASES.mixed
    // Seed approval first; posting a verified record of another change still leaves this head unproved.
    prepare(box, pr, { comments: [approve(sha(branch))] })
    rewriteProducerProofs(box, pr, conserved(RECORDS.semctx, 'verified', pr))
    const { result, gate } = land(box, wt.mixed as string, pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
    expect(result.error).toContain(`proof-acquire.ts' --pr ${pr}`)
    expect(gate).toEqual(UNARMED)
  })

  describe('the record binds the repository, PR, candidate, local tip and analysed inputs', () => {
    const verified = SEMCTX_CASES.verified
    it('a record of another candidate does not prove this one', () => {
      const { pr, branch } = SEMCTX_CASES.partial
      prepare(box, pr, { comments: [approve(sha(branch))] })
      rewriteProducerProofs(box, pr, conserved(RECORDS.semctx, 'verified', pr))
      const { result, gate } = land(box, wt.partial as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(gate).toEqual(UNARMED)
    })

    it('a record posted by another login proves nothing; the same record by the operator admits', () => {
      const comments = [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified')]
      prepare(box, verified.pr, { comments })
      writeSim(box, (state) => {
        for (const comment of state.prs[String(verified.pr)]?.comments ?? [])
          if (comment.body.startsWith(proofFramePrefix('semctx'))) comment.author = 'mallory'
      })
      const other = land(box, wt.verified as string, verified.pr)
      expect(other.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(other.gate).toEqual(UNARMED)

      prepare(box, verified.pr, { comments })
      const own = land(box, wt.verified as string, verified.pr)
      expect(own.result).toMatchObject({ status: 'watching', proof: { semctx: { verdict: 'VERIFIED' } } })
      expect([...other.producers, ...own.producers]).toEqual([])
    })

    it('the latest complete record wins: a newer refusal never falls back to an older VERIFIED record', () => {
      const older = conserved(RECORDS.semctx, 'verified')
      const found = decodeFixtureProof(
        older.map((body) => ({ author: { login: ME }, body })),
        'semctx',
        sha(verified.branch),
        verified.pr,
      )
      const record = structuredClone(found.record) as SemctxRecord
      const step = record.native[4]
      if (!step) throw new Error('the conserved record holds no verify')
      step.stdout = JSON.stringify({
        ...JSON.parse(step.stdout),
        verdict: 'BLOCKED',
        findings: [{ kind: 'underlying_block', severity: 'block', message: 'invariant unproved', refs: [] }],
      })
      const newer = encodeFixtureProof('semctx', sha(verified.branch), record)
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
      // Seed approval at the moved head, then attach the parent VERIFIED record (not current).
      prepare(box, 18, { comments: [approve(sha('fix/1-moved'))] })
      rewriteProducerProofs(box, 18, conserved(RECORDS.semctx, 'verified', 18))
      const { result, gate } = land(box, wt.moved as string, 18)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'missing' })
      expect(gate).toEqual(UNARMED)
    })

    it('a record conserved for another PR of the same head does not bind this PR', () => {
      prepare(box, 17, { comments: [approve(sha(verified.branch)), ...conserved(RECORDS.semctx, 'verified', 17)] })
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
      const found = decodeFixtureProof(
        conserved(RECORDS.semctx, 'verified').map((body) => ({ author: { login: ME }, body })),
        'semctx',
        sha(verified.branch),
        verified.pr,
      )
      const record = structuredClone(found.record) as { invocation: { mergeBase: string } }
      record.invocation.mergeBase = sha(SEMCTX_CASES.partial.branch)
      const forged = encodeFixtureProof('semctx', sha(verified.branch), record)
      prepare(box, verified.pr, { comments: [approve(sha(verified.branch)), ...forged] })
      const { result, gate } = land(box, wt.verified as string, verified.pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unbound' })
      expect(gate).toEqual(UNARMED)
    })
  })

  describe('a record above one comment is posted as a run of parts and admitted only whole', () => {
    const { pr, branch } = SEMCTX_CASES.large
    const parts = conserved(RECORDS.semctx, 'large')
    const first = parts[0] ?? ''
    const retained = RECORDS.semctx.records.large?.data
    if (retained === undefined) throw new Error('missing retained Semctx large native data')
    const retainedJson = JSON.stringify(retained)
    const retainedDigest = createHash('sha256').update(retainedJson).digest('hex')

    it('current-codec parts retain every retained native datum within the GitHub byte ceiling', () => {
      expect(RECORDS.semctx.records.large?.code).toBe(0)
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.every((part) => Buffer.byteLength(part, 'utf8') <= 65536)).toBe(true)
      const decoded = decodeFixtureProof(
        parts.map((body) => ({ author: { login: ME }, body })),
        'semctx',
        sha(branch),
        pr,
      )
      expect(decoded.parts.map((part) => part.body)).toEqual(parts)
      expect(JSON.stringify(decoded.record)).toBe(retainedJson)
      expect(createHash('sha256').update(JSON.stringify(decoded.record)).digest('hex')).toBe(retainedDigest)
    })

    it.each([
      ['interleaved with another comment', [first, 'unrelated note', ...parts.slice(1)]],
      ['after an earlier posting that stopped short', [first, ...parts]],
    ])('admits the parts %s, with no producer call', (_label, comments) => {
      prepare(box, pr, { comments: [approve(sha(branch)), ...comments] })
      if (_label === 'interleaved with another comment') {
        const next = parts[1]
        if (!next) throw new Error('retained multipart record has no second part')
        const published = readSim(box).prs[String(pr)]?.comments.map((comment) => comment.body) ?? []
        const firstIndex = published.indexOf(first)
        expect(published[firstIndex + 1]).toBe('unrelated note')
        expect(published[firstIndex + 2]).toBe(next)
      }
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
      ['its first part deleted', (all: string[]) => all.slice(1)],
      ['its last part deleted', (all: string[]) => all.slice(0, -1)],
    ])('with %s, the record is unreadable, unarmed', (_label, drop) => {
      // Seed a complete multipart record (actual capture), then delete a part before land.
      prepare(box, pr, { comments: [approve(sha(branch)), ...parts] })
      rewriteProducerProofs(box, pr, drop)
      const { result, gate, producers } = land(box, wt.large as string, pr)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
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
        { status: 'not-approved', reason: 'review-bound', reviews: 3 },
      ],
      [
        'an approval: the bad proof refuses',
        () => [approve(sha(branch))],
        { status: 'proof-blocked', reason: 'verdict' },
      ],
    ])('%s', (_label, reviews, expected) => {
      const attempts = reviews()
      prepare(box, pr, { comments: [...attempts, ...conserved(RECORDS.semctx, 'vacuous')] })
      const published = readSim(box).prs[String(pr)]?.comments.map((comment) => comment.body) ?? []
      for (const attempt of attempts) expect(published.some((body) => body.includes(attempt.prefix))).toBe(true)
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
