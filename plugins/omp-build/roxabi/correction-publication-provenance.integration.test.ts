import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { githubScope } from '../adapters/github/transport.ts'
import { validateProspectiveRecord, validateRecordGraph } from '../engine/history-graph.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from '../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../testing/isolated-pin-sandbox.ts'
import { readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { RecordPublisher } from './fix-contract.ts'
import { captureConfirmedFixRequest } from './fix-entry-review-bound.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import { prepareUwAction } from './uw-action-inputs.ts'
import { verifyActionSnapshot } from './uw-action-snapshot.ts'
import { createProductionActionPorts } from './uw-input-readers.ts'

const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses a changed synthesis input at the real publication boundary before writing', async () => {
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
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  const run = spawnSync(
    bun,
    [path.resolve(import.meta.dirname, '../testing/correction-publication-provenance-runner.ts'), cwd],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const history = pullHistory(box)
  const operation = history.operations.find(
    (item) =>
      item.record?.kind === 'review-attempt' &&
      item.record.payload.purpose === 'correction' &&
      item.record.payload.stage === 'synthesis',
  )
  const synthesis = operation?.record
  if (!operation || synthesis?.kind !== 'review-attempt' || synthesis.payload.stage !== 'synthesis')
    throw new Error('captured-synthesis-missing')
  const remove = new Set(operation.parts.map((part) => part.nativeId))
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (!pull) throw new Error('pull-missing')
    pull.comments = pull.comments.filter((_comment, index) => !remove.has(String(index + 1)))
  })
  const before = readSim(box).prs['7']?.comments
  expect(validateRecordGraph(pullHistory(box)).ok).toBe(true)
  const initial = history.operations.find(
    (item) =>
      item.record?.kind === 'review-attempt' &&
      item.record.payload.stage === 'initial' &&
      item.record.payload.purpose === 'correction',
  )?.record
  const action = synthesis.payload.slots[0]?.action
  if (
    initial?.kind !== 'review-attempt' ||
    initial.payload.stage !== 'initial' ||
    initial.payload.purpose !== 'correction' ||
    !action
  )
    throw new Error('captured-intake-or-action-missing')
  const gh = async (dir: string, args: string[]) =>
    execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' })
  const inputs = action.inputs
  const request = {
    actionId: 'provenance-prepare-probe',
    purpose: 'correction' as const,
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: inputs.stageSources,
    expandedContext: inputs.manifest.expandedContext,
  }
  const correctionRoot = {
    inventory: { scope: githubScope('acme/app', 7), kind: 'review-attempt' as const, recordId: initial.recordId },
    requestId: initial.payload.requestId,
  }
  const ports = createProductionActionPorts({
    cwd,
    gh,
    readAuthor: 'operator',
    artifactsDir: path.join(box.root, 'prepare-probes'),
    pluginPin: {
      repository: inputs.manifest.plugin.repository,
      commit: inputs.manifest.plugin.commit,
      installedRoot: path.resolve(import.meta.dirname, '..'),
    },
  })
  expect((await prepareUwAction(request, ports, undefined, undefined, correctionRoot)).ok).toBe(true)
  const withoutEvidence = {
    ...request,
    stageSources: request.stageSources.filter((ref) => ref.record.kind === 'contribution'),
  }
  const missing = await prepareUwAction(withoutEvidence, ports, undefined, undefined, correctionRoot)
  expect(missing).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'self-output' })]),
  })
  expect(readSim(box).prs['7']?.comments).toEqual(before)
  expect(validateRecordGraph(pullHistory(box)).ok).toBe(true)
  const bytes = execFileSync('git', ['show', `${inputs.manifest.code.head}:README.md`], { cwd, env: box.env })
  const additionalContext = {
    source: 'git-file' as const,
    repository: inputs.manifest.code.repository,
    commit: inputs.manifest.code.head,
    path: 'README.md',
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  const drifted = await prepareUwAction(
    { ...request, actionId: synthesis.recordId, expandedContext: [additionalContext] },
    ports,
    undefined,
    undefined,
    correctionRoot,
  )
  if (!drifted.ok) throw new Error(`drift-prepare-refused: ${JSON.stringify(drifted.diagnostics)}`)
  expect((await verifyActionSnapshot(drifted.value.snapshot)).ok).toBe(true)
  expect(drifted.value.inputs.manifest).toEqual({ ...inputs.manifest, expandedContext: [additionalContext] })
  expect(drifted.value.inputs.stageSources).toEqual(inputs.stageSources)
  expect(synthesis.payload.input).toBe(initial.payload.input)
  expect(drifted.value.inputs.fingerprint).not.toBe(initial.payload.input)
  const slots = synthesis.payload.slots.map((slot) => {
    if (!slot.action) throw new Error('synthesis-action-missing')
    return { ...slot, action: { ...slot.action, inputs: drifted.value.inputs } }
  })
  const drift = {
    ...synthesis,
    payload: {
      ...synthesis.payload,
      input: drifted.value.inputs.fingerprint,
      actionInputDigest: drifted.value.inputs.fingerprint,
      slots,
    },
  }
  const prefix = pullHistory(box)
  expect(validateProspectiveRecord(synthesis, prefix)).toEqual([])
  expect(validateProspectiveRecord(drift, prefix).map((diagnostic) => diagnostic.code)).toEqual(['unbound'])
  const publisher = createGitHubRecordPublisher(githubScope('acme/app', 7), { cwd, gh }, null)
  expect(await publisher.publish(drift)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining(['unbound']) })
  expect(readSim(box).prs['7']?.comments).toEqual(before)
  expect(validateRecordGraph(pullHistory(box)).ok).toBe(true)
  const adapter: RecordPublisher = {
    publish: async (record, canPublish) => {
      const saved = await publisher.publish(record, [], canPublish)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  let captured = false
  const wrapped = captureConfirmedFixRequest(adapter, () => {
    captured = true
  })
  expect(prefix.operations.some((entry) => entry.recordId === synthesis.recordId)).toBe(false)
  expect(await wrapped.publish(synthesis, () => false)).toEqual({
    ok: false,
    diagnostics: ['publication-ownership-revoked'],
  })
  expect(captured).toBe(false)
  expect(readSim(box).prs['7']?.comments).toEqual(before)
  expect(validateRecordGraph(pullHistory(box)).ok).toBe(true)
  expect(await wrapped.publish(synthesis, () => true)).toEqual({ ok: true, value: undefined })
  expect(validateRecordGraph(pullHistory(box)).ok).toBe(true)
})

it('rejects a complete older root and an incomplete findings set before publication', async () => {
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
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  const run = spawnSync(
    bun,
    [path.resolve(import.meta.dirname, '../testing/correction-publication-provenance-roots-runner.ts'), cwd],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const observed = JSON.parse(run.stdout)
  expect(observed.findingsA).toBeGreaterThan(0)
  expect(observed.findingsB).toBe(2)
  expect(observed.oldRoot).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'self-output' })]),
  })
  expect(observed.omitted).toEqual({ ok: false, diagnostics: ['prepare-action-unavailable'] })
  expect(observed.foreign).toEqual({ ok: false, diagnostics: ['correction-synthesis-sources-invalid'] })
  expect(observed.unchanged).toBe(true)
  expect(observed.graphAfter).toBe(true)
  expect(observed.baseline).toBe(true)
  expect(observed.graphFinal).toBe(true)
})
