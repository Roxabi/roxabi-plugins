import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeHistory, type History } from '../../dist/contracts.js'
import { ACQUIRE, readSim, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CASES, semctxSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import type { SemctxRecord } from './proof-semctx-protocol'
import {
  approve,
  conserved,
  decodeFixtureProof,
  encodeFixtureProof,
  fixtureReviewBodies,
  proofFramePrefix,
  RECORDS,
} from './testing/proof-integration/data'
import { ME, REAL_BUN } from './testing/proof-integration/environment'
import { land, noTest, UNARMED } from './testing/proof-integration/landing'
import {
  bindFixtureReview,
  instrument,
  isWorkflowBindingBody,
  prepare,
  producerCalls,
} from './testing/proof-integration/setup'
import { workflowRead } from './testing/proof-integration/workflow'

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
  const timedReview = (head: string, time: string) => ({ ...approve(head), createdAt: time, updatedAt: time })

  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function prime(name: 'partial' | 'largePartial' | 'verified') {
    const { pr, branch } = SEMCTX_CASES[name]
    const head = box.sha[branch] as string
    const parts = conserved(RECORDS.semctx, name)
    prepare(box, pr, {
      comments: parts,
      body: noTest('out-of-scope'),
      armed: head,
      binding: false,
    })
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error(`missing fixture PR ${pr}`)
      const bindings = pull.comments.filter((comment) => isWorkflowBindingBody(comment.body))
      pull.comments = [
        ...bindings,
        ...parts.map((body, index) => ({
          author: ME,
          body,
          createdAt: `2026-01-01T00:00:0${index}Z`,
          updatedAt: `2026-01-01T00:00:0${index}Z`,
        })),
        ...pull.comments.filter(
          (comment) => !isWorkflowBindingBody(comment.body) && !comment.body.startsWith(proofFramePrefix('semctx')),
        ),
      ]
      for (const comment of pull.comments) {
        if (!isWorkflowBindingBody(comment.body) && !comment.body.startsWith(proofFramePrefix('semctx'))) {
          comment.createdAt = APPROVED
          comment.updatedAt = APPROVED
        }
      }
    })
    bindFixtureReview(box, pr, [timedReview(head, APPROVED)])
    return { pr, head, parts }
  }
  function facts(pr: number, index: number, changed: { createdAt?: string | null; updatedAt?: string | null }) {
    writeSim(box, (state) => {
      const comments = state.prs[String(pr)]?.comments
      if (!comments) throw new Error(`missing fixture comments for PR ${pr}`)
      // Negative index: full comment list (approval is last). Non-negative: proof parts only — bindings precede proofs.
      const comment =
        index < 0
          ? comments.at(index)
          : comments.filter((entry) => entry.body.startsWith(proofFramePrefix('semctx')))[index]
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
      bindFixtureReview(box, pr, [timedReview(head, REAPPROVED)])
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
    facts(pr, -1, { createdAt: null, updatedAt: null })
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
    const source = decodeFixtureProof(
      conserved(RECORDS.semctx, 'partial').map((body) => ({ author: { login: ME }, body })),
      'semctx',
      head,
      pr,
    )
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
    const bodies = encodeFixtureProof('semctx', head, record)
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('missing PR')
      const proofStart = pull.comments.findIndex((comment) => comment.body.startsWith(proofFramePrefix('semctx')))
      if (proofStart < 0) throw new Error('missing semctx proof comments')
      pull.comments.splice(
        proofStart,
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
    const { pr } = prime('largePartial')
    const older = conserved(RECORDS.semctx, 'largePartial')
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error(`missing fixture PR ${pr}`)
      pull.comments.unshift(
        ...older.map((body, index) => ({
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
      const pull = readSim(box).prs[String(pr)]
      if (!pull) throw new Error(`missing PR ${pr}`)
      const history: History = {
        scope: { repository: 'acme/app', target: `acme/app#${pr}` },
        expectedAuthor: ME,
        stopAuthor: null,
        complete: true,
        comments: pull.comments.map((comment, index) => ({
          locator: `fixture#${pr}:${index + 1}`,
          nativeId: String(comment.id ?? index + 1),
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt ?? null,
          updatedAt: comment.updatedAt ?? null,
        })),
        diagnostics: [],
      }
      const record = decodeHistory(history)
        .operations.filter((operation) => operation.status === 'complete' && operation.record?.kind === 'review')
        .at(-1)?.record
      const input = record?.kind === 'review' ? record.payload.input : null
      if (typeof input !== 'string') throw new Error('missing canonical approval input')
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
      bindFixtureReview(box, pr, [approve(head)])
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
        const part = state.prs[String(pr)]?.comments.find((comment) =>
          comment.body.startsWith(proofFramePrefix('semctx')),
        )
        if (!part) throw new Error('missing proof')
        part.body = `${part.body}\nfixture transport mutation`
      })
      unbound('verified', pr)
      prime('verified')
      unchanged('verified', pr)
    })

    it('a coherent PARTIAL-to-VERIFIED rewrite cannot disable the exact read binding', () => {
      const { pr, head } = prime('partial')
      const source = RECORDS.semctx.records.partial?.data
      if (source === undefined || Array.isArray(source)) throw new Error('missing native partial fixture data')
      const record: SemctxRecord = structuredClone(source) as SemctxRecord
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
      const rewritten = encodeFixtureProof('semctx', head, record)
      if (rewritten.length !== 1 || !rewritten[0]) throw new Error('expected one replacement part')
      const replacement = rewritten[0]
      writeSim(box, (state) => {
        const part = state.prs[String(pr)]?.comments.find((comment) =>
          comment.body.startsWith(proofFramePrefix('semctx')),
        )
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
        const parts = state.prs[String(pr)]?.comments.filter((comment) =>
          comment.body.startsWith(proofFramePrefix('semctx')),
        )
        const part = parts?.[1]
        if (!part?.id) throw new Error('missing native second-part identity')
        part.id += 1_000_000
      })
      unbound('largePartial', pr)
      prime('largePartial')
      unchanged('largePartial', pr)
    })

    it('keeps tied-time multipart selection stable across presentation order and refuses a newer incomplete run', () => {
      const { pr, head } = prime('largePartial')
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        for (const part of pull.comments.filter((comment) => comment.body.startsWith(proofFramePrefix('semctx')))) {
          part.createdAt = EARLY
          part.updatedAt = EARLY
        }
      })
      bindFixtureReview(box, pr, [approve(head)])
      const retained = approvalInput(pr)
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing PR')
        const bindings = pull.comments.filter((comment) => isWorkflowBindingBody(comment.body))
        const proofs = pull.comments.filter((comment) => comment.body.startsWith(proofFramePrefix('semctx'))).reverse()
        const reviews = pull.comments.filter(
          (comment) => !comment.body.startsWith(proofFramePrefix('semctx')) && !isWorkflowBindingBody(comment.body),
        )
        pull.comments = [...bindings, ...proofs, ...reviews]
      })
      expect(workflowRead(box, dir('largePartial'), pr, head, 'validateReviewInput', retained)).toEqual({ ok: true })
      unchanged('largePartial', pr)
      const first = conserved(RECORDS.semctx, 'largePartial')[0]
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
        reason: 'unreadable',
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      prime('largePartial')
      unchanged('largePartial', pr)
    })

    it('applicable proof refuses a null canonical input rather than upgrading an invalid review', () => {
      const { pr, head } = prime('verified')
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('missing review')
        const bindings = pull.comments.filter((comment) => isWorkflowBindingBody(comment.body))
        const proofs = pull.comments.filter((comment) => comment.body.startsWith(proofFramePrefix('semctx')))
        const reviews = fixtureReviewBodies(pr, approve(head), null).map((body) => ({ author: ME, body }))
        pull.comments = [...bindings, ...proofs, ...reviews]
      })
      // Null review-input cannot approve the current Spec: unbound, not producer-missing.
      const refused = land(box, dir('verified'), pr)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unbound',
        disarmed: true,
      })
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])
      prime('verified')
      unchanged('verified', pr)
    })
  })
})
