import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { resolveAdmittedCorrectionCriterionSource } from '../../engine/correction-criterion-source.ts'
import { assessCriterionDeclarations } from '../../engine/criterion-admission.ts'
import { criterionDeclarationSchema } from '../../engine/criterion-evidence-schema.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH as BRANCH,
  REVIEW_SCOPE as SCOPE,
  seedReviewFixture,
} from '../../testing/feature-review-fixture.ts'
import { git, readSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function arrange() {
  const fixture = arrangeReviewFixture()
  roots.add(fixture.box.root)
  return fixture
}

function invoke(box: Box, cwd: string, control: 'continue' | 'pause' | 'resume', operation = 'omp-review-lifecycle') {
  const run = spawnSync(BUN, [RUNNER, operation, cwd, JSON.stringify({ control })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as {
    messages: string[]
    active: { operationId: string; tasks?: { tasks: Array<{ agent: string }> } } | null
    falsifyActive?: { operationId: string; tasks?: { tasks: Array<{ agent: string }> } } | null
    fixRun: { runId: string; operationId: string } | null
    comments: unknown[]
    barrier: boolean
    beforeRelease?: number
    commit?: string
    priorHead?: string
    snapshots?: Array<{
      agent: string
      actionId: string
      head: string
      priorHead: string
      fingerprint: string
      index: string
    }>
    reviewSnapshots?: Array<{ head: string; index: string; fingerprint: string; sourceRecordId: string }>
    replay?: { head: string; verdict: string }
    terminal?: { status: 'complete' | 'stopped'; recordId?: string; kind?: string }
    transitionOutcome?: 'next-batch' | 'terminal'
  }
}

function reviewHistory(box: Box, state = readSim(box)) {
  const comments = state.prs['7']?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  })
}

function issueDecodedHistory(box: Box, state = readSim(box)) {
  const comments = state.issues['42']?.comments ?? []
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  })
}

function issueHistory(box: Box) {
  return issueDecodedHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
}

function pauseConfirmed(box: Box): boolean {
  const comments = readSim(box).issues['42']?.comments ?? []
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  }).operations.some(
    (operation) =>
      operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
  )
}

function assertPauseConfirmed(box: Box, messages: readonly string[]): void {
  if (pauseConfirmed(box)) return
  throw new Error(`confirmed pause missing; child messages: ${JSON.stringify(messages)}`)
}

function assertCorrectionSnapshots(
  observed: ReturnType<typeof invoke>,
  records: CanonicalRecord[],
  observations: string,
) {
  expect(observed.snapshots, observations).toHaveLength(2)
  expect(observed.snapshots?.map((snapshot) => snapshot.agent)).toEqual(['R-review-fix-falsify', 'R-review-fix-apply'])
  for (const snapshot of observed.snapshots ?? []) {
    expect(snapshot).toMatchObject({ head: observed.commit, priorHead: observed.priorHead })
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.index).toBeTruthy()
    const inventory = records.find(
      (record) =>
        record.kind === 'review-attempt' &&
        record.payload.purpose === 'correction' &&
        record.payload.slots.some((slot) => slot.action?.actionId === snapshot.actionId),
    )
    expect(inventory?.kind).toBe('review-attempt')
    if (inventory?.kind !== 'review-attempt') throw new Error('fixture-postapply-inventory-missing')
    expect(inventory.payload).toMatchObject({
      candidateGitSHA: observed.commit,
      actionInputDigest: snapshot.fingerprint,
    })
    expect(inventory.payload.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({
            actionId: snapshot.actionId,
            inputs: expect.objectContaining({
              fingerprint: snapshot.fingerprint,
              manifest: expect.objectContaining({ code: expect.objectContaining({ head: observed.commit }) }),
            }),
          }),
        }),
      ]),
    )
  }
}

function assertCorrectionReceipt(
  review: DecodedHistory,
  issue: DecodedHistory,
  issueRecords: CanonicalRecord[],
  observed: ReturnType<typeof invoke>,
  records: CanonicalRecord[],
  result: CanonicalRecord | undefined,
) {
  expect(result?.kind).toBe('fix-result')
  if (result?.kind !== 'fix-result' || !result.payload.criterionReceipt) throw new Error('fixture-fix-receipt-missing')
  const receipt = result.payload.criterionReceipt
  expect(result.inputs).toContain(receipt.sourceContributionId)
  const source = records.find(
    (record) => record.kind === 'contribution' && record.recordId === receipt.sourceContributionId,
  )
  expect(source?.kind).toBe('contribution')
  if (source?.kind !== 'contribution' || !source.payload.host.action || !observed.commit || !observed.priorHead)
    throw new Error('fixture-correction-source-missing')
  const manifest = source.payload.host.action.inputs.manifest
  if (manifest.spec.kind !== 'accepted') throw new Error('fixture-correction-spec-missing')
  const planRef = manifest.deliveryData.find((ref) => ref.role === 'plan')
  const plan = issueRecords.find(
    (record) => record.kind === 'action-receipt' && record.recordId === planRef?.record.recordId,
  )
  if (plan?.kind !== 'action-receipt') throw new Error('fixture-plan-source-missing')
  if (plan.payload.mandate.kind !== 'mandate') throw new Error('fixture-plan-mandate-missing')
  const histories = [review, issue]
  const context = {
    head: observed.commit,
    planActionId: plan.payload.actionId,
    mandate: plan.payload.mandate,
    ownSpec: manifest.spec.effective.own,
  }
  const admitted = resolveAdmittedCorrectionCriterionSource(result, histories, context)
  expect(admitted?.contribution.recordId).toBe(receipt.sourceContributionId)
  expect(
    resolveAdmittedCorrectionCriterionSource(result, histories, { ...context, head: observed.priorHead }),
  ).toBeNull()
  expect(resolveAdmittedCorrectionCriterionSource(result, [issue], context)).toBeNull()
  expect(
    resolveAdmittedCorrectionCriterionSource(result, histories, {
      ...context,
      ownSpec: {
        ...context.ownSpec,
        sourceAccepted: { ...context.ownSpec.sourceAccepted, recordId: 'wrong-acceptance-source' },
      },
    }),
  ).toBeNull()
  expect(
    resolveAdmittedCorrectionCriterionSource(result, histories, {
      ...context,
      mandate: { ...context.mandate, scope: { ...context.mandate.scope, target: 'wrong-owner-scope' } },
    }),
  ).toBeNull()
  const implementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    !implementation.payload.structured ||
    !('criteria' in implementation.payload.structured)
  )
    throw new Error('fixture-h1-implementation-missing')
  const oldCriteria = criterionDeclarationSchema.array().parse(implementation.payload.structured.criteria)
  const currentCode = { repository: manifest.code.repository, commit: observed.commit }
  expect(
    assessCriterionDeclarations({ spec: manifest.spec.effective, code: currentCode, declarations: oldCriteria }).ok,
  ).toBe(false)
  expect(assessCriterionDeclarations({ spec: manifest.spec.effective, code: currentCode, declarations: [] }).ok).toBe(
    false,
  )
  expect(receipt.criteria.map((item) => item.target.id).sort()).toEqual(
    manifest.spec.effective.spec.criteria.map((item) => item.id).sort(),
  )
  expect(receipt.criteria.length).toBeGreaterThan(0)
  for (const criterion of receipt.criteria) {
    expect(criterion.verification).toBe('evidence')
    if (criterion.verification !== 'evidence') throw new Error('fixture-criterion-unverified')
    expect(criterion.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'test',
          code: expect.objectContaining({ commit: observed.commit }),
          after: expect.objectContaining({
            run: expect.objectContaining({
              exitCode: 0,
              command: expect.stringContaining('save("selected-region")'),
              output: expect.objectContaining({ text: expect.stringContaining('saved region: selected-region') }),
            }),
            versionClaim: expect.objectContaining({ code: expect.objectContaining({ commit: observed.commit }) }),
          }),
        }),
      ]),
    )
  }
}

describe('installed /feature review lifecycle through actual Bun and external boundaries', () => {
  it('keeps the activated fix after the preceding review terminal', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'continue')
    const records = reviewHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const decision = records.find((record) => record.kind === 'decision')
    const review = records.find((record) => record.kind === 'review')
    const issueRecords = issueHistory(box)
    const request = records.find((record) => record.kind === 'fix-request')
    expect(
      request,
      `review-bound request observations: ${JSON.stringify({
        active: observed.active,
        fixRun: observed.fixRun,
        messages: observed.messages,
      })}`,
    ).toMatchObject({ target: 'acme/app#7' })
    expect(request?.payload).toMatchObject({ existingReviewId: review?.recordId, landing: false })
    expect(issueRecords.filter((record) => record.kind === 'mandate').map((record) => record.recordId)).toEqual([
      'mandate-feature-1',
    ])
    expect(issueRecords.some((record) => record.kind === 'operator-control')).toBe(false)
    expect(decision?.payload).toMatchObject({
      judgment: {
        findings: [{ id: 'selected-region-blocker', label: 'issue(blocking)' }],
        causes: [{ id: 'selected-region-cause', findingIds: ['selected-region-blocker'] }],
      },
    })
    expect(review?.payload).toMatchObject({ candidateGitSHA: box.sha[BRANCH], decisionId: decision?.recordId })
    const finalFinding =
      decision?.kind === 'decision'
        ? decision.payload.judgment.findings.find((finding) => finding.id === 'selected-region-blocker')
        : undefined
    const panelFindingIds = records.flatMap((record) =>
      record.kind === 'contribution' && record.payload.host.phase === 'panel'
        ? (record.payload.findings?.map((finding) => finding.id) ?? [])
        : [],
    )
    const finalFindingIds = finalFinding?.sourceFindingIds ?? []
    expect(panelFindingIds).toHaveLength(2)
    expect(new Set(panelFindingIds).size).toBe(panelFindingIds.length)
    expect([...finalFindingIds].sort()).toEqual([...panelFindingIds].sort())
    expect(
      observed.fixRun,
      `review-to-fix activation observations: ${JSON.stringify({
        active: observed.active,
        fixRun: observed.fixRun,
        messages: observed.messages,
      })}`,
    ).toMatchObject({ runId: expect.any(String), operationId: expect.any(String) })
    expect(request?.runId).toBe(observed.fixRun?.runId)
    expect(observed.active?.operationId).toBe(observed.fixRun?.operationId)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(3)
  })

  it('pushes the owned correction only after native falsification', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'continue', 'omp-review-apply-falsify')
    const state = readSim(box)
    const review = reviewHistory(box, state)
    const issue = issueDecodedHistory(box, state)
    const issueRecords = issue.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const records = review.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const request = records.find((record) => record.kind === 'fix-request')
    const result = records.find((record) => record.kind === 'fix-result')
    const remoteHead = git(box, cwd, ['ls-remote', 'origin', `refs/heads/${BRANCH}`]).split(/\s+/)[0]
    const observations = JSON.stringify({
      active: observed.active,
      falsifyActive: observed.falsifyActive,
      terminal: observed.terminal,
      transitionOutcome: observed.transitionOutcome,
      messages: observed.messages,
      comments: observed.comments,
      records,
    })
    expect(observed.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(observed.transitionOutcome, observations).toBe('next-batch')
    expect(observed.falsifyActive, observations).toMatchObject({
      tasks: { tasks: [{ agent: 'R-review-fix-falsify' }] },
    })
    expect(observed.terminal, observations).toMatchObject({ status: 'complete', kind: 'fix-result' })
    expect(observed.active).toBeNull()
    expect(remoteHead).toBe(observed.commit)
    expect(result, observations).toMatchObject({
      repository: SCOPE.repository,
      target: 'acme/app#7',
      payload: { candidateGitSHA: observed.commit },
    })
    expect(observed.commit).not.toBe(observed.priorHead)
    assertCorrectionSnapshots(observed, records, observations)
    assertCorrectionReceipt(review, issue, issueRecords, observed, records, result)
    expect(observed.reviewSnapshots).toEqual([
      expect.objectContaining({ head: observed.commit, sourceRecordId: result?.recordId }),
    ])
    expect(observed.replay).toMatchObject({ head: observed.commit, verdict: 'Approve (clean)' })
    expect(request?.payload).toMatchObject({ landing: false })
    expect(issueRecords.filter((record) => record.kind === 'mandate').map((record) => record.recordId)).toEqual([
      'mandate-feature-1',
    ])
    expect(issueRecords.some((record) => record.kind === 'operator-control')).toBe(false)
  })

  it('persists confirmed local pause for a fresh review without another dispatch', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'pause')
    expect(observed.active).toBeNull()
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    assertPauseConfirmed(box, observed.messages)
  })

  it('fences continuation when final review publication is actually pending', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'resume')
    expect(observed.barrier).toBe(true)
    expect(observed.beforeRelease).toBe(2)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
    expect(observed.active).toBeNull()
    assertPauseConfirmed(box, observed.messages)
  })
})
