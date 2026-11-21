import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function lifecycleFailure(box: Parameters<typeof readSim>[0], run: SpawnSyncReturns<string>): string {
  if (run.status === 0) return ''
  let simulatorCalls: number | string = 'unavailable'
  try {
    simulatorCalls = readSim(box).calls.length
  } catch {}
  return (
    `status=${run.status} signal=${run.signal} errorCode=${(run.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'} ` +
    `availableParallelism=${availableParallelism()} cpu=${cpus()[0]?.model ?? 'unknown'} simulatorCalls=${simulatorCalls}\n` +
    `${run.stderr}\n${run.stdout}`
  )
}

it('carries the activated candidate through real CI correction and review of the pushed head', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  writeFileSync(control, '{}')
  const run = spawnSync(
    BUN,
    [path.resolve(import.meta.dirname, '../../testing/ci-correction-lifecycle-runner.ts'), cwd],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      // Correction plus follow-on review completes beyond 55s in the bounded CPU repro.
      // This is a fixture process clock, not a Native admission bound.
      timeout: 90_000,
    },
  )
  expect(run.status, lifecycleFailure(box, run)).toBe(0)
  const observed = JSON.parse(run.stdout) as {
    priorHead: string
    commit: string
    manifests: Array<{ stage: string; inputs: ActionInputs }>
  }
  expect(observed.commit).not.toBe(observed.priorHead)
  expect(readSim(box).prs['7']?.headRefOid).toBe(observed.commit)
  const assertStagePins = () => {
    for (const stage of [
      'attribution',
      'intake',
      'synthesis',
      'apply',
      'post-apply',
      'follow-on-review',
      'follow-on-synthesis',
    ]) {
      const tasks = observed.manifests.filter((item) => item.stage === stage)
      expect(tasks.length, stage).toBeGreaterThan(0)
      for (const task of tasks) expect(task.inputs.manifest.plugin.commit, stage).toBe(pin.candidate)
    }
  }
  assertStagePins()
  const records = pullHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const attribution = records.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.phase === 'result' && record.payload.action === 'attribute-ci',
  )
  if (
    attribution?.kind !== 'action-receipt' ||
    attribution.payload.phase !== 'result' ||
    attribution.payload.action !== 'attribute-ci'
  )
    throw new Error('attribute-ci-result-missing')
  const request = records.find((record) => record.kind === 'fix-request')
  if (request?.kind !== 'fix-request') throw new Error('fix-request-missing')
  const root = records.find((record) => record.recordId === request.payload.requestContributionId)
  if (root?.kind !== 'contribution') throw new Error('operator-request-missing')
  expect(root.payload).toMatchObject({
    content: 'operator-request',
    inventoryId: null,
    host: { origin: 'operator', role: 'operator' },
  })
  const intake = records.find(
    (record) =>
      record.kind === 'review-attempt' &&
      record.payload.purpose === 'correction' &&
      record.payload.stage === 'initial' &&
      record.payload.slots.some((slot) => slot.phase === 'intake'),
  )
  if (intake?.kind !== 'review-attempt') throw new Error('intake-inventory-missing')
  const synthesis = records.find(
    (record) =>
      record.kind === 'review-attempt' &&
      record.payload.purpose === 'correction' &&
      record.payload.stage === 'synthesis' &&
      record.payload.rootAttemptId === intake.recordId,
  )
  if (synthesis?.kind !== 'review-attempt') throw new Error('synthesis-inventory-missing')
  expect(intake.inputs).toContain(request.recordId)
  expect(synthesis.payload.input).toEqual(intake.payload.input)
  const findings = records.filter(
    (record) =>
      record.kind === 'contribution' &&
      record.payload.inventoryId === intake.recordId &&
      record.payload.content === 'findings',
  )
  expect(findings.length).toBeGreaterThan(0)
  const intakeTask = observed.manifests.find((item) => item.stage === 'intake')
  const synthesisTask = observed.manifests.find((item) => item.stage === 'synthesis')
  if (!intakeTask || !synthesisTask) throw new Error('correction-task-missing')
  const assertBoundSubjects = () => {
    const attributionSubject = attribution.payload.inputs.manifest.subject
    const intakeSubject = intakeTask.inputs.manifest.subject
    if (
      attributionSubject.kind !== 'uw' ||
      intakeSubject.kind !== 'uw' ||
      !attributionSubject.binding ||
      !intakeSubject.binding
    )
      throw new Error('ci-bound-subject-missing')
    expect(attributionSubject.uw).toEqual({ repository: 'acme/app', target: 'acme/app#42' })
    expect(attributionSubject.binding).toEqual(intakeSubject.binding)
    const binding = records.find(
      (record) => record.kind === 'workflow-binding' && record.recordId === intakeSubject.binding?.record.recordId,
    )
    if (binding?.kind !== 'workflow-binding') throw new Error('ci-workflow-binding-missing')
    expect(attribution.payload.mandate).toEqual(binding.payload.mandate)
  }
  assertBoundSubjects()
  expect(intakeTask.inputs.stageSources.map((ref) => ref.record.recordId)).toEqual([attribution.recordId])
  expect(synthesisTask.inputs.stageSources.map((ref) => ref.record.recordId).sort()).toEqual(
    [attribution.recordId, ...findings.map((record) => record.recordId)].sort(),
  )
  const decisions = records.filter(
    (record) => record.kind === 'decision' && record.payload.judgment.purpose === 'correction',
  )
  expect(decisions).toHaveLength(1)
  const decision = decisions[0]
  if (decision?.kind !== 'decision') throw new Error('correction-decision-missing')
  expect([...decision.payload.judgment.sourceContributionIds].sort()).toEqual(
    findings.map((record) => record.recordId).sort(),
  )
  for (const item of observed.manifests.filter((item) => item.stage === 'apply' || item.stage === 'post-apply'))
    expect(
      item.inputs.stageSources.filter((ref) => ref.record.kind === 'decision').map((ref) => ref.record.recordId),
    ).toEqual([decision.recordId])
  const result = records.find((record) => record.kind === 'fix-result' && record.payload.requestId === request.recordId)
  if (result?.kind !== 'fix-result' || !result.payload.criterionReceipt)
    throw new Error('fix-result-criterion-receipt-missing')
  expect(result.payload.candidateGitSHA).toBe(observed.commit)
  expect(result.payload.criterionReceipt.criteria.length).toBeGreaterThan(0)
  for (const item of observed.manifests.filter((item) => item.stage === 'follow-on-review')) {
    expect(item.inputs.manifest.code.head).toBe(observed.commit)
    const data = item.inputs.manifest.deliveryData
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'implementation',
          record: expect.objectContaining({ recordId: result.recordId }),
        }),
        expect.objectContaining({
          role: 'correction-lineage',
          record: expect.objectContaining({ recordId: request.recordId }),
        }),
        expect.objectContaining({
          role: 'correction-lineage',
          record: expect.objectContaining({ recordId: root.recordId }),
        }),
      ]),
    )
  }
}, 120_000)

it('refuses an issue alias to a different PR at the CI entry before publication', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const before = readSim(box)
  const run = spawnSync(BUN, [path.resolve(import.meta.dirname, '../../testing/ci-alias-refusal-runner.ts'), cwd], {
    cwd,
    env: box.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  expect(JSON.parse(run.stdout)).toEqual({ ok: false, diagnostics: ['ci-correction-target-mismatch'] })
  const after = readSim(box)
  const durableComments = (comments: Array<{ body: string; author: string }> | undefined) => {
    if (comments === undefined) throw new Error('fixture-comments-missing')
    return comments.map(({ body, author }) => ({ body, author }))
  }
  expect(durableComments(after.issues['42']?.comments)).toEqual(durableComments(before.issues['42']?.comments))
  expect(durableComments(after.prs['7']?.comments)).toEqual(durableComments(before.prs['7']?.comments))
})

it.each(['fix-pr', 'fix-issue'] as const)(
  'runs ordinary %s through the native correction closure',
  async (scenario) => {
    const { box, cwd } = arrangeReviewFixture()
    roots.add(box.root)
    const pin = isolatedPinSandbox(box)
    const control = path.join(box.root, 'pin-control.json')
    writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
    box.env = { ...pin.env, PIN_CONTROL_FILE: control }
    await seedReviewFixture(box, cwd)
    appendApprovedReview(box, cwd)
    writeFileSync(control, '{}')
    const run = spawnSync(
      BUN,
      [path.resolve(import.meta.dirname, '../../testing/ci-correction-lifecycle-runner.ts'), cwd, scenario],
      {
        cwd,
        env: box.env,
        encoding: 'utf8',
        timeout: 55_000,
      },
    )
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    const observed = JSON.parse(run.stdout) as {
      priorHead: string
      commit: string
      manifests: Array<{ stage: string; inputs: ActionInputs }>
    }
    expect(observed.commit).not.toBe(observed.priorHead)
    expect(readSim(box).prs['7']?.headRefOid).toBe(observed.commit)
    for (const stage of ['intake', 'synthesis', 'apply', 'post-apply', 'follow-on-review']) {
      const tasks = observed.manifests.filter((item) => item.stage === stage)
      expect(tasks.length, stage).toBeGreaterThan(0)
      for (const task of tasks) expect(task.inputs.manifest.plugin.commit).toBe(pin.candidate)
    }
    const records = pullHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const request = records.find((record) => record.kind === 'fix-request')
    if (request?.kind !== 'fix-request') throw new Error('ordinary-fix-request-missing')
    const root = records.find((record) => record.recordId === request.payload.requestContributionId)
    expect(root).toMatchObject({
      kind: 'contribution',
      payload: { content: 'operator-request', host: { origin: 'operator' } },
    })
    const intake = records.find(
      (record) =>
        record.kind === 'review-attempt' &&
        record.payload.purpose === 'correction' &&
        record.payload.stage === 'initial' &&
        record.payload.slots.some((slot) => slot.phase === 'intake'),
    )
    if (intake?.kind !== 'review-attempt') throw new Error('ordinary-intake-missing')
    const findings = records.filter(
      (record) =>
        record.kind === 'contribution' &&
        record.payload.inventoryId === intake.recordId &&
        record.payload.content === 'findings',
    )
    expect(findings.length).toBeGreaterThan(0)
    const synthesis = observed.manifests.find((item) => item.stage === 'synthesis')
    if (!synthesis) throw new Error('ordinary-synthesis-missing')
    expect(synthesis.inputs.stageSources.map((ref) => ref.record.recordId).sort()).toEqual(
      findings.map((record) => record.recordId).sort(),
    )
    const decision = records.find(
      (record) => record.kind === 'decision' && record.payload.judgment.purpose === 'correction',
    )
    if (decision?.kind !== 'decision') throw new Error('ordinary-correction-decision-missing')
    expect([...decision.payload.judgment.sourceContributionIds].sort()).toEqual(
      findings.map((record) => record.recordId).sort(),
    )
    const result = records.find(
      (record) => record.kind === 'fix-result' && record.payload.requestId === request.recordId,
    )
    expect(result).toMatchObject({
      kind: 'fix-result',
      payload: { candidateGitSHA: observed.commit, criterionReceipt: expect.any(Object) },
    })
  },
)
