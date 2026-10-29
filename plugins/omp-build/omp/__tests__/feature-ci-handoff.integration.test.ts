import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { decodeHistory, encodeRecord } from '../../adapters/github/history-codec.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH as BRANCH,
  REVIEW_SCOPE as SCOPE,
  seedReviewFixture,
} from '../../testing/feature-review-fixture.ts'
import { roxabiRecordFixtures } from '../../testing/roxabi-presets.ts'
import { readSim, WORKFLOW, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const VALIDATION_RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-review-validation-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
const PULL_SCOPE = { repository: 'acme/app', target: 'acme/app#7' }
const { projection } = roxabiRecordFixtures()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function featureMandate(box: Box) {
  const comments = readSim(box).issues['42']?.comments ?? []
  const history = decodeHistory({
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
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  const record = history.operations.find((operation) => operation.record?.kind === 'mandate')?.record
  if (record?.kind !== 'mandate') throw new Error('feature-mandate-missing')
  return { record, history }
}

function pullHistory(box: Box) {
  const comments = readSim(box).prs['7']?.comments ?? []
  return decodeHistory({
    scope: PULL_SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
}

function continueFeature(box: Box, cwd: string): unknown {
  const run = spawnSync(BUN, [RUNNER, 'continue', cwd, JSON.stringify({ reference: '#42', control: 'continue' })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`continue failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as unknown
}

function captureReviewInput(box: Box, cwd: string, head: string): ActionInputs {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: 7, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`capture review input failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as { ok?: unknown; inputs?: ActionInputs }
  if (captured.ok !== true || captured.inputs === undefined) throw new Error(`review input unavailable: ${run.stdout}`)
  return captured.inputs
}

function appendApprovedReview(box: Box, cwd: string): void {
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const inputs = captureReviewInput(box, cwd, head)
  const { record: mandate, history } = featureMandate(box)
  const issueRecords = history.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const review = criterionReviewGraph({
    mandate,
    issueRecords,
    scope: PULL_SCOPE,
    head,
    inputs,
    projection,
    author: 'operator',
    verdict: 'Approve (clean)',
    prefix: 'feature-ci-handoff',
  })
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (pull === undefined) throw new Error('feature-pull-missing')
    pull.comments.push(
      ...review.comments.map(({ body }) => ({
        author: 'operator',
        body,
        createdAt: '2026-10-22T11:00:00Z',
        updatedAt: '2026-10-22T11:00:00Z',
      })),
    )
  })
}

function setFailedCi(box: Box): void {
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  writeSim(box, (state) => {
    state.checks[head] = [
      { name: 'ci', status: 'completed', conclusion: 'failure', workflowName: 'ci', startedAt: '2026-10-22T12:00:00Z' },
    ]
  })
}

function appendAttributedCiResult(box: Box): void {
  const history = pullHistory(box)
  const started = history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.phase === 'start' &&
      operation.record.payload.action === 'attribute-ci',
  )?.record
  if (
    started?.kind !== 'action-receipt' ||
    started.payload.phase !== 'start' ||
    started.payload.action !== 'attribute-ci'
  ) {
    throw new Error('published-ci-attribution-start-missing')
  }
  const result = buildRecord({
    version: 1,
    repository: PULL_SCOPE.repository,
    target: PULL_SCOPE.target,
    recordId: 'ci-result',
    runId: started.runId,
    operationId: 'ci-result-operation',
    kind: 'action-receipt',
    payload: {
      format: started.payload.format,
      inputs: started.payload.inputs,
      phase: 'result',
      action: 'attribute-ci',
      actionId: started.payload.actionId,
      mandate: started.payload.mandate,
      start: { scope: PULL_SCOPE, recordId: started.recordId, kind: 'action-receipt' },
      exactInputs: started.payload.exactInputs,
      native: { completion: 'completed', strict: 'valid', raw: null },
      structured: { attribution: 'change', evidence: null },
      admission: null,
      diagnostics: [],
    },
  })
  if (!result.ok) throw new Error('ci-attribution-result-invalid')
  const { history: mandateHistory } = featureMandate(box)
  const encoded = encodeRecord(result.value, history.source, null, [mandateHistory])
  if (!encoded.ok) throw new Error('ci-attribution-result-encoding-invalid')
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (pull === undefined) throw new Error('feature-pull-missing')
    pull.comments.push(
      ...encoded.value.map((body) => ({
        author: 'operator',
        body,
        createdAt: '2026-10-22T12:00:00Z',
        updatedAt: '2026-10-22T12:00:00Z',
      })),
    )
  })
}

it('authorizes only the current sealed initial snapshot before inventory publication', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const snapshot = captureReviewInput(box, cwd, head)
  const validate = (input: ActionInputs) => {
    const run = spawnSync(BUN, [VALIDATION_RUNNER, cwd, head, JSON.stringify(input)], {
      cwd,
      env: box.env,
      encoding: 'utf8',
    })
    if (run.status !== 0) throw new Error(`validate review failed: ${run.stderr}`)
    return JSON.parse(run.stdout) as { prepared: { ok: boolean }; persisted: { ok: boolean } }
  }
  expect(validate(snapshot)).toMatchObject({ prepared: { ok: true }, persisted: { ok: false } })
  const altered = structuredClone(snapshot)
  altered.manifest.code.head = 'a'.repeat(40)
  expect(validate(altered)).toMatchObject({ prepared: { ok: false }, persisted: { ok: false } })
})

it('preserves the installed readonly UW reader through public continuation to attributed CI correction', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)

  expect(continueFeature(box, cwd), 'baseline public continuation').toMatchObject({ kind: 'review', pr: 7 })
  expect(pullHistory(box).diagnostics, 'baseline pull history').toEqual([])

  appendApprovedReview(box, cwd)
  expect(pullHistory(box).diagnostics, 'approved pull history').toEqual([])

  setFailedCi(box)
  expect(continueFeature(box, cwd), 'approved head without attribution').toMatchObject({
    kind: 'action',
    node: 'attribute-ci',
  })

  appendAttributedCiResult(box)
  const attributed = pullHistory(box)
  expect(attributed.diagnostics, 'attributed pull history').toEqual([])
  expect(
    attributed.operations.find((operation) => operation.record?.recordId === 'ci-result'),
    'attributed CI receipt',
  ).toMatchObject({ status: 'complete', record: { kind: 'action-receipt', recordId: 'ci-result' } })

  const result = continueFeature(box, cwd)
  expect(result, `continuation result: ${JSON.stringify(result)}`).toMatchObject({
    kind: 'admitted-ci-correction',
    reference: '#7',
    attributionRecordId: 'ci-result',
  })
})
