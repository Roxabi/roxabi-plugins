import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { decodeHistory, encodeRecord } from '../../adapters/github/history-codec.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { failedCheckEvidenceDigest } from '../../engine/record-digests.ts'
import { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH as BRANCH,
  nativeFeatureSpec,
  REVIEW_SCOPE as SCOPE,
  seedReviewFixture,
} from '../../testing/feature-review-fixture.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { appendSimIssueComments, readSim, WORKFLOW, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const REPLAY_RUNNER = path.resolve(import.meta.dirname, 'feature-operand-replay-runner.ts')
const TAMPER_RUNNER = path.resolve(import.meta.dirname, 'feature-operand-tamper-runner.ts')
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

function replayInputs(box: Box, cwd: string, inputs: ActionInputs, actionId: string): { ok: boolean } {
  const run = spawnSync(BUN, [REPLAY_RUNNER, cwd, JSON.stringify(inputs), actionId], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`replay failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as { ok: boolean }
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
    pullHistory: pullHistory(box),
    issueHistory: history,
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
      Object.assign(
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'ci',
          startedAt: '2026-10-22T12:00:00Z',
        },
        { id: 'check-run-1' },
      ),
      Object.assign(
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'status',
          startedAt: '2026-10-22T12:00:00Z',
        },
        { kind: 'status-context', context: 'ci', id: 'status-1' },
      ),
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

it('delivers accepted and edited proposed Spec operands before any plan exists', () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const accepted = nativeFeatureSpec(SCOPE, 'preserves the region')
  const proposed = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone')
  const workflow = roxabiWorkflowFixtures()
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const mandate = workflow.featureMandate(SCOPE, {
    branch: BRANCH,
    body: accepted.body,
    ownSpec: accepted.ownSpec,
    lineageHead: head,
    tier: 'F-lite',
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.body = proposed.body
    issue.comments.push(...workflow.framedBodies([mandate], 'operator').map((body) => ({ author: 'operator', body })))
  })
  const result = continueFeature(box, cwd) as {
    kind: string
    node: string
    followUp: {
      tasks: {
        tasks: { task: string; action: { inputs: ActionInputs; snapshot: { indexPath: string; actionId: string } } }[]
      }
    }
  }
  expect(result).toMatchObject({ kind: 'action', node: 'assess-spec' })
  const task = result.followUp.tasks.tasks[0]
  const manifest = task.action.inputs.manifest
  expect(manifest.spec.kind).toBe('accepted')
  expect(manifest.deliveryData.filter((ref) => ref.role === 'plan')).toEqual([])
  expect(manifest.acceptedSources.length).toBeGreaterThan(0)
  const operands = manifest.operands
  expect(operands?.action).toBe('assess-spec')
  if (operands?.action !== 'assess-spec') throw new Error('assessment operands missing')
  const exact = operands.exactInputs
  expect(exact.accepted.snapshot.raw.body).toBe(accepted.body)
  expect(exact.proposed.snapshot.raw.body).toBe(proposed.body)
  expect(exact.accepted.tier).toBe('F-lite')
  expect(exact.proposed.tier).toBe('F-lite')
  expect(exact.mechanical.changedStatements).toContain('C1')
  const directory = path.dirname(task.action.snapshot.indexPath)
  expect(JSON.parse(readFileSync(path.join(directory, 'action/exact-inputs.json'), 'utf8'))).toEqual(exact)
  expect(readFileSync(task.action.snapshot.indexPath, 'utf8')).toContain(
    'Accepted state and proposed state: action/exact-inputs.json',
  )
  expect(task.task).toContain(`Index: ${task.action.snapshot.indexPath}`)
  expect(task.task).not.toContain(JSON.stringify(exact))
  const start = featureMandate(box).history.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.phase === 'start' &&
      operation.record.payload.action === 'assess-spec',
  )?.record
  if (start?.kind !== 'action-receipt' || start.payload.phase !== 'start' || start.payload.action !== 'assess-spec')
    throw new Error('assessment start missing')
  expect(start.payload.exactInputs).toEqual(exact)
  rmSync(directory, { recursive: true, force: true })
  const commentsBeforeReplay = structuredClone(readSim(box).issues['42']?.comments ?? [])
  const coldReplay = replayInputs(box, cwd, task.action.inputs, task.action.snapshot.actionId)
  expect(coldReplay, `cold assessment replay: ${JSON.stringify(coldReplay)}`).toMatchObject({ ok: true })
  expect(readSim(box).issues['42']?.comments, 'cold replay publishes no start or result').toEqual(commentsBeforeReplay)
  const startOperation = featureMandate(box).history.operations.find(
    (operation) => operation.recordId === start.recordId,
  )
  if (startOperation === undefined || startOperation.parts.length === 0)
    throw new Error('assessment start parts missing')
  const startIndexes = startOperation.parts.map((part) => {
    const index = Number(part.nativeId) - 1
    if (!Number.isInteger(index) || index < 0) throw new Error('assessment start locator invalid')
    return index
  })
  const originalComments = structuredClone(readSim(box).issues['42']?.comments ?? [])
  const assertRefusedWithoutPublication = (
    label: string,
    inputs = task.action.inputs,
    actionId = task.action.snapshot.actionId,
  ) => {
    const before = structuredClone(readSim(box).issues['42']?.comments ?? [])
    expect(replayInputs(box, cwd, inputs, actionId), label).toMatchObject({ ok: false })
    expect(readSim(box).issues['42']?.comments, `${label}: no start or result published`).toEqual(before)
  }
  const restoreComments = () => {
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (issue === undefined) throw new Error('feature-issue-missing')
      issue.comments = structuredClone(originalComments)
    })
  }
  assertRefusedWithoutPublication('different action id', task.action.inputs, `${task.action.snapshot.actionId}-other`)
  assertRefusedWithoutPublication('different fingerprint', {
    ...task.action.inputs,
    fingerprint: '0'.repeat(64),
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    for (const index of startIndexes) {
      const comment = issue.comments[index]
      if (comment === undefined) throw new Error('assessment start comment missing')
      comment.author = 'forger'
    }
  })
  assertRefusedWithoutPublication('start authored by another actor')
  restoreComments()
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    for (const index of startIndexes) {
      const comment = issue.comments[index]
      if (comment === undefined) throw new Error('assessment start comment missing')
      comment.updatedAt = '2026-10-24T12:00:00Z'
    }
  })
  assertRefusedWithoutPublication('edited start')
  restoreComments()
  const otherStart = buildRecord({
    ...start,
    recordId: 'other-assessment-start',
    operationId: 'other-assessment-start-operation',
    payload: { ...start.payload, actionId: 'other-assessment-action' },
  })
  if (!otherStart.ok) throw new Error('other assessment start invalid')
  const encodedOther = encodeRecord(otherStart.value, featureMandate(box).history.source, null)
  if (!encodedOther.ok) throw new Error('other assessment start encoding invalid')
  appendSimIssueComments(box, '42', encodedOther.value, 'operator', '2026-10-22T12:00:00Z')
  assertRefusedWithoutPublication('another pending assessment')
  restoreComments()
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.updatedAt = '2026-10-23T12:00:00Z'
  })
  expect(replayInputs(box, cwd, task.action.inputs, task.action.snapshot.actionId), 'date-only drift').toMatchObject({
    ok: true,
  })
  expect(readSim(box).issues['42']?.comments, 'date-only replay publishes no start or result').toEqual(originalComments)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves a different region').body
  })
  expect(replayInputs(box, cwd, task.action.inputs, task.action.snapshot.actionId), 'changed proposal').toMatchObject({
    ok: false,
  })
  expect(readSim(box).issues['42']?.comments, 'changed proposal publishes no start or result').toEqual(originalComments)
})

it.each(['editorial', 'material'] as const)(
  'prepares assessment against the current %s acceptance chain',
  (classification) => {
    const { box, cwd } = arrangeReviewFixture()
    roots.add(box.root)
    const workflow = roxabiWorkflowFixtures()
    const initial = nativeFeatureSpec(SCOPE, 'preserves the region')
    const revised = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone')
    const current = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone across reloads')
    const head = box.sha[BRANCH]
    if (head === undefined) throw new Error('feature-head-missing')
    const mandate = workflow.featureMandate(SCOPE, {
      branch: BRANCH,
      body: initial.body,
      ownSpec: initial.ownSpec,
      lineageHead: head,
      tier: 'F-lite',
    })
    const accepted = mandateAssessmentState(mandate)
    const middleBody = revised.body
    const middleSnapshot = revised.ownSpec.snapshot
    const assessment = assessFixture(
      mandate,
      `prior-${classification}`,
      accepted,
      {
        snapshot: middleSnapshot,
        tier: accepted.tier,
        children: accepted.children,
      },
      classification,
    )
    const control =
      classification === 'material' ? acceptMaterialFixture(mandate, 'accepted-material', assessment) : null
    const records = [mandate, assessment.start, assessment.result, ...(control === null ? [] : [control])]
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (issue === undefined) throw new Error('feature-issue-missing')
      issue.body = current.body
      issue.comments.push(...workflow.framedBodies(records, 'operator').map((body) => ({ author: 'operator', body })))
    })
    const result = continueFeature(box, cwd) as {
      kind: string
      node: string
      followUp: { tasks: { tasks: { action: { inputs: ActionInputs; snapshot: { indexPath: string } } }[] } }
    }
    expect(result).toMatchObject({ kind: 'action', node: 'assess-spec' })
    const action = result.followUp.tasks.tasks[0].action
    const operands = action.inputs.manifest.operands
    if (operands?.action !== 'assess-spec') throw new Error('assessment operands missing')
    const exact = operands.exactInputs
    expect(exact.accepted.ref.sourceAccepted.recordId).toBe(control?.recordId ?? assessment.result.recordId)
    expect(exact.accepted.snapshot.raw.body).toBe(middleBody)
    expect(exact.proposed.snapshot.raw.body).toBe(current.body)
    expect(action.inputs.manifest.acceptedSources.map((ref) => ref.record.recordId)).toContain(
      control?.recordId ?? assessment.result.recordId,
    )
    expect(
      JSON.parse(readFileSync(path.join(path.dirname(action.snapshot.indexPath), 'action/exact-inputs.json'), 'utf8')),
    ).toEqual(exact)
    const start = featureMandate(box).history.operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.phase === 'start' &&
        operation.record.payload.action === 'assess-spec' &&
        operation.record.recordId !== assessment.start.recordId,
    )?.record
    if (start?.kind !== 'action-receipt' || start.payload.phase !== 'start' || start.payload.action !== 'assess-spec')
      throw new Error('current assessment start missing')
    expect(start.payload.exactInputs).toEqual(exact)
  },
)

it('refuses a tampered exact-inputs file on the live prepared action handle', () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const workflow = roxabiWorkflowFixtures()
  const initial = nativeFeatureSpec(SCOPE, 'preserves the region')
  const proposed = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone')
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const mandate = workflow.featureMandate(SCOPE, {
    branch: BRANCH,
    body: initial.body,
    ownSpec: initial.ownSpec,
    lineageHead: head,
    tier: 'F-lite',
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.body = proposed.body
    issue.comments.push(...workflow.framedBodies([mandate], 'operator').map((body) => ({ author: 'operator', body })))
  })
  const run = spawnSync(BUN, [TAMPER_RUNNER, cwd], { cwd, env: box.env, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`tamper runner failed: ${run.stderr}\n${run.stdout}`)
  expect(JSON.parse(run.stdout)).toMatchObject({
    before: { ok: true },
    after: { ok: false, diagnostics: [{ code: 'snapshot-mutated' }] },
  })
})

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
  const attribution = continueFeature(box, cwd) as {
    kind: string
    node: string
    followUp: {
      tasks: {
        tasks: { task: string; action: { inputs: ActionInputs; snapshot: { indexPath: string; actionId: string } } }[]
      }
    }
  }
  expect(attribution, 'approved head without attribution').toMatchObject({
    kind: 'action',
    node: 'attribute-ci',
  })
  const task = attribution.followUp.tasks.tasks[0]
  const operands = task.action.inputs.manifest.operands
  expect(operands?.action).toBe('attribute-ci')
  if (operands?.action !== 'attribute-ci') throw new Error('CI operands missing')
  const exact = operands.exactInputs
  expect(exact).toMatchObject({ candidateGitSHA: box.sha[BRANCH], scope: PULL_SCOPE, failedChecks: ['ci'] })
  expect(exact.failures).toEqual([
    { source: 'github-check-run', observationId: 'check-run-1', name: 'ci', conclusion: 'failure' },
    { source: 'github-status-context', observationId: 'status-1', name: 'ci', conclusion: 'failure' },
  ])
  expect(exact.evidenceDigest).toBe(failedCheckEvidenceDigest(exact))
  const directory = path.dirname(task.action.snapshot.indexPath)
  expect(JSON.parse(readFileSync(path.join(directory, 'action/exact-inputs.json'), 'utf8'))).toEqual(exact)
  expect(readFileSync(task.action.snapshot.indexPath, 'utf8')).toContain('CI failures: action/exact-inputs.json')
  expect(task.task).toContain(`Index: ${task.action.snapshot.indexPath}`)
  expect(task.task).not.toContain(JSON.stringify(exact))
  const start = pullHistory(box).operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.phase === 'start' &&
      operation.record.payload.action === 'attribute-ci',
  )?.record
  if (start?.kind !== 'action-receipt' || start.payload.phase !== 'start' || start.payload.action !== 'attribute-ci')
    throw new Error('CI start missing')
  expect(start.payload.exactInputs).toEqual(exact)
  rmSync(directory, { recursive: true, force: true })
  expect(replayInputs(box, cwd, task.action.inputs, task.action.snapshot.actionId), 'cold replay').toMatchObject({
    ok: true,
  })
  writeSim(box, (state) => {
    const head = box.sha[BRANCH]
    if (head === undefined) throw new Error('feature-head-missing')
    Object.assign(state.checks[head][0], { id: 'check-run-rerun' })
  })
  expect(replayInputs(box, cwd, task.action.inputs, task.action.snapshot.actionId), 'rerun at same SHA').toMatchObject({
    ok: false,
  })
  setFailedCi(box)

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
