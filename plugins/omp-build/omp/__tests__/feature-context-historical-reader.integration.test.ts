import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { createInstalledObservedUwReadPort, createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const PLANNER = path.resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts')
afterEach(cleanupFeatureRecoveryRoots)

it('reconstructs a genuine successor on a cold no-hint read without granting dirty or negative continuation', async () => {
  const { box, checkout: originalCheckout } = featureFixture('mandate')
  const worktreeRoot = path.join(box.root, 'context-worktrees')
  const checkout = path.join(worktreeRoot, 'app', 'feat-42-save')
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(box, box.principal, ['worktree', 'move', originalCheckout, checkout])
  const env = { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }
  const run = (operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [
        RUNNER,
        operation,
        checkout,
        JSON.stringify({
          reference: '#42',
          control: 'continue',
          negativeRecordId,
        }),
      ],
      { cwd: checkout, env, encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`Feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as {
      kind?: string
      admitted?: boolean
      after?: { version: string }
      selected?: { kind: string; node: string }
    }
  }
  const history = () =>
    decodeHistory({
      scope: SCOPE,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
        locator: `${SCOPE.target}:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  const planner = spawnSync(BUN, [PLANNER, checkout, 'positive-both'], { cwd: checkout, env, encoding: 'utf8' })
  if (planner.status !== 0) throw new Error(`Native planning failed: ${planner.stderr}\n${planner.stdout}`)
  expect(run('omp-context-initial-negative').admitted).toBe(true)
  const negative = history().operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' &&
      record.payload.action === 'implement' &&
      record.payload.phase === 'result' &&
      record.payload.admission === null,
  )?.record
  if (!negative) throw new Error('Native negative unavailable')
  const retained = JSON.stringify(negative)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Fixture issue unavailable')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone').body
  })
  const material = run('accept-context-material')
  expect(material.after?.version).toBeDefined()
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned' })
  expect(run('confirmed-context-successor-plan', negative.recordId).selected).toMatchObject({
    kind: 'action',
    node: 'plan',
  })

  const gh = async (cwd: string, args: string[]) =>
    execFileSync('gh', args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  const native = await createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' }).readUw(SCOPE)
  const read = () => createInstalledObservedUwReadPort({ observation: native.observation }).readUw(SCOPE)
  const cold = await read()
  expect(cold.accepted).toMatchObject({ status: 'accepted', value: { ref: { version: material.after?.version } } })
  expect(cold.identity.ok).toBe(true)
  expect(cold.admission.applicability).toBe('resolved')
  expect(cold.admission).toEqual(native.admission)

  const ownHistory = native.observation.histories.find((entry) => entry.source.scope.target === SCOPE.target)
  const selection = ownHistory?.operations.find(
    ({ record }) =>
      record?.kind === 'operator-control' &&
      record.payload.control === 'select-successor' &&
      record.payload.contextDisposition?.negative.record.recordId === negative.recordId,
  )
  if (!ownHistory || !selection || selection.record?.kind !== 'operator-control' || selection.parts.length === 0)
    throw new Error('Genuine successor selection unavailable')
  const selectionIds = new Set(selection.parts.map((part) => part.nativeId))
  const withoutSelection = ownHistory.source.comments.filter((comment) => !selectionIds.has(comment.nativeId))
  const replayParts = selection.parts.map((part, index) => ({
    ...part,
    nativeId: `replay-${index}`,
    locator: `${SCOPE.target}:replay-${index}`,
  }))
  const replayHistory = decodeHistory({
    ...ownHistory.source,
    comments: [...ownHistory.source.comments, ...replayParts],
  })
  const replayObservation = {
    ...native.observation,
    histories: native.observation.histories.map((entry) => (entry === ownHistory ? replayHistory : entry)),
  }
  const replay = await createInstalledObservedUwReadPort({ observation: replayObservation }).readUw(SCOPE)
  expect(replay.accepted).toEqual(cold.accepted)
  expect(replay.identity).toEqual(cold.identity)
  expect(replay.admission).toEqual(cold.admission)

  // This is a forged competing claim, not a second operator confirmation.
  const forged = encodeParts(
    { ...selection.record, recordId: 'competing-selection', operationId: 'competing-selection-op' },
    '# Competing successor selection',
    65536,
  )
  if (!forged.ok) throw new Error('Competing selection frames unavailable')
  const template = selection.parts[0]
  if (!template) throw new Error('Selection frame template missing')
  const competing = forged.value.map((body, index) => ({
    ...template,
    body,
    nativeId: `competing-${index}`,
    locator: `${SCOPE.target}:competing-${index}`,
  }))
  const variants = [
    ['incomplete', decodeHistory({ ...ownHistory.source, complete: false })],
    ['missing selection', decodeHistory({ ...ownHistory.source, comments: withoutSelection })],
    [
      'forged competing selection',
      decodeHistory({ ...ownHistory.source, comments: [...ownHistory.source.comments, ...competing] }),
    ],
  ] as const
  for (const [name, variant] of variants) {
    const observation = {
      ...native.observation,
      histories: native.observation.histories.map((entry) => (entry === ownHistory ? variant : entry)),
    }
    const refused = await createInstalledObservedUwReadPort({ observation }).readUw(SCOPE)
    expect(refused.accepted.status, name).not.toBe('accepted')
    expect(refused.identity.ok, name).toBe(false)
    expect(refused.admission.applicability, name).not.toBe('resolved')
  }

  const originalReadme = readFileSync(path.join(checkout, 'README.md'), 'utf8')
  writeFileSync(path.join(checkout, 'README.md'), 'unreconciled local effect\n')
  const dirty = await read()
  expect(dirty.accepted).toEqual(cold.accepted)
  expect(dirty.identity).toEqual(cold.identity)
  const startsBefore = history().operations.filter(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
  ).length
  expect(run('continue')).toMatchObject({ kind: 'blocked' })
  expect(
    history().operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
    ),
  ).toHaveLength(startsBefore)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
  ).toBe(retained)
  writeFileSync(path.join(checkout, 'README.md'), originalReadme)
  expect(run('omp-context-initial-negative').admitted).toBe(true)
  const currentResults = history().operations.filter(
    ({ record }) =>
      record?.kind === 'action-receipt' &&
      record.payload.action === 'implement' &&
      record.payload.phase === 'result' &&
      record.payload.admission === null,
  )
  expect(currentResults).toHaveLength(2)
  const startsAfterCurrentNegative = history().operations.filter(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
  ).length
  expect(run('continue')).toMatchObject({ kind: 'blocked' })
  expect(
    history().operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
    ),
  ).toHaveLength(startsAfterCurrentNegative)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
  ).toBe(retained)

  const secondNegative = currentResults[1]?.record
  if (!secondNegative) throw new Error('Successor negative unavailable')
  const retainedSecond = JSON.stringify(secondNegative)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Fixture issue unavailable')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves the region, timezone and locale').body
  })
  const thirdMaterial = run('accept-context-material')
  expect(thirdMaterial.after?.version).toBeDefined()
  expect(thirdMaterial.after?.version).not.toBe(material.after?.version)
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned' })
  expect(run('confirmed-context-successor-plan', secondNegative.recordId).selected).toMatchObject({
    kind: 'action',
    node: 'plan',
  })
  const thirdNative = await createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' }).readUw(SCOPE)
  const thirdCold = await createInstalledObservedUwReadPort({ observation: thirdNative.observation }).readUw(SCOPE)
  const thirdDiagnostics = JSON.stringify({ accepted: thirdCold.accepted, identity: thirdCold.identity })
  expect(thirdCold.accepted, thirdDiagnostics).toMatchObject({
    status: 'accepted',
    value: { ref: { version: thirdMaterial.after?.version } },
  })
  expect(thirdCold.identity.ok, thirdDiagnostics).toBe(true)
  expect(thirdCold.admission.applicability).toBe('resolved')
  expect(
    history().operations.filter(
      ({ record }) =>
        record?.kind === 'operator-control' &&
        record.payload.control === 'select-successor' &&
        record.payload.contextDisposition,
    ),
  ).toHaveLength(2)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
  ).toBe(retained)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === secondNegative.recordId)?.record),
  ).toBe(retainedSecond)
}, 120_000)
