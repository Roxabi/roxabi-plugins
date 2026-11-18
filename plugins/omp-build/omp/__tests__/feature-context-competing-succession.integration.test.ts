import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { contextHandoffPrefixHistories } from '../../engine/workflow-context-handoff-history.ts'
import { admitContextSuccession } from '../../engine/workflow-context-succession.ts'
import { createHistoricalAcceptedSpecContext } from '../../engine/workflow-context-succession-inspection.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { createInstalledObservedUwReadPort, createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { assertConfirmationRollback } from './feature-context-confirmation-rollback-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const PLANNER = path.resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts')
afterEach(cleanupFeatureRecoveryRoots)

it('refuses two independently confirmed successor selections over one native negative while accepting identical replay', async () => {
  const { box, checkout: originalCheckout } = featureFixture('mandate')
  const worktreeRoot = path.join(box.root, 'context-worktrees')
  const checkout = path.join(worktreeRoot, 'app', 'feat-42-save')
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(box, box.principal, ['worktree', 'move', originalCheckout, checkout])
  const env = { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }
  const run = (operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [RUNNER, operation, checkout, JSON.stringify({ reference: '#42', control: 'continue', negativeRecordId })],
      { cwd: checkout, env, encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`Feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as {
      kind?: string
      node?: string
      admitted?: boolean
      confirmed?: boolean
      after?: { version: string }
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
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
  // Fork only this disposable native simulator's state; Git and the captured authority stay identical.
  const prefixState = readFileSync(box.stateFile, 'utf8')
  const prefixComments = readSim(box).issues['42']?.comments.length
  if (prefixComments === undefined) throw new Error('Native prefix unavailable')
  const gh = async (cwd: string, args: string[]) => execFileSync('gh', args, { cwd, env, encoding: 'utf8' })
  const produce = async () => {
    expect(run('confirmed-context-successor', negative.recordId)).toMatchObject({ kind: 'action', node: 'plan' })
    const native = await createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' }).readUw(SCOPE)
    const cold = await createInstalledObservedUwReadPort({ observation: native.observation }).readUw(SCOPE)
    expect(cold.accepted).toMatchObject({ status: 'accepted', value: { ref: { version: material.after?.version } } })
    expect(cold.identity.ok).toBe(true)
    expect(cold.admission.applicability).toBe('resolved')
    const home = native.observation.histories.find((entry) => entry.source.scope.target === SCOPE.target)
    const selection = home?.operations.find(
      ({ record }) =>
        record?.kind === 'operator-control' &&
        record.payload.control === 'select-successor' &&
        record.payload.contextDisposition?.negative.record.recordId === negative.recordId,
    )
    if (
      !home ||
      selection?.record?.kind !== 'operator-control' ||
      selection.record.payload.control !== 'select-successor'
    )
      throw new Error('Confirmed successor selection unavailable')
    expect(admitContextSuccession(selection.record, native.observation.histories)).toMatchObject({ ok: true })
    return { native, cold, home, selection: selection.record, parts: selection.parts }
  }
  const first = await produce()
  assertConfirmationRollback(first.native.observation.histories, first.home, first.selection, first.parts)
  writeFileSync(box.stateFile, prefixState)
  const second = await produce()
  expect(first.selection.recordId).not.toBe(second.selection.recordId)
  if (first.selection.payload.control !== 'select-successor' || second.selection.payload.control !== 'select-successor')
    throw new Error('Expected successor controls')
  expect(first.selection.payload.predecessor).toEqual(second.selection.payload.predecessor)
  expect(first.selection.payload.successor.recordId).not.toBe(second.selection.payload.successor.recordId)
  expect(first.home.source.comments.slice(0, prefixComments)).toEqual(
    second.home.source.comments.slice(0, prefixComments),
  )
  const appendSecond = second.home.source.comments.slice(prefixComments).map((comment, index) => ({
    ...comment,
    nativeId: `fork-b-${index}`,
    locator: `${SCOPE.target}:fork-b-${index}`,
  }))
  const combinedHome = decodeHistory({
    ...first.home.source,
    comments: [...first.home.source.comments, ...appendSecond],
  })
  const combinedObservation = {
    ...first.native.observation,
    histories: first.native.observation.histories.map((entry) => (entry === first.home ? combinedHome : entry)),
  }
  const combined = await createInstalledObservedUwReadPort({ observation: combinedObservation }).readUw(SCOPE)
  expect(combined.accepted.status).not.toBe('accepted')
  expect(combined.identity.ok).toBe(false)
  expect(combined.admission.applicability).not.toBe('resolved')
  const firstSuccessorId = first.selection.payload.successor.recordId
  const firstPredecessorId = first.selection.payload.predecessor.recordId
  const successor = recordsOf(combinedHome).find(
    (record) => record.kind === 'mandate' && record.recordId === firstSuccessorId,
  )
  const predecessor = recordsOf(combinedHome).find(
    (record) => record.kind === 'mandate' && record.recordId === firstPredecessorId,
  )
  const disposition = first.selection.payload.contextDisposition
  if (successor?.kind !== 'mandate' || predecessor?.kind !== 'mandate' || !disposition)
    throw new Error('Successor, predecessor or confirmed cut unavailable')
  const cut = contextHandoffPrefixHistories(combinedObservation.histories, disposition.reconciliation.cuts)
  if (cut === null) throw new Error('Confirmed historical cut unavailable')
  const historical = createHistoricalAcceptedSpecContext(combinedObservation.histories)
  const cutContext = createHistoricalAcceptedSpecContext(cut)
  if (!historical.ok || !cutContext.ok) throw new Error('Historical contexts unavailable')
  expect(resolveAcceptedSpec(predecessor, cut, undefined, undefined, cutContext.value)).toMatchObject({ ok: true })
  const refusedSuccessor = resolveAcceptedSpec(
    successor,
    combinedObservation.histories,
    undefined,
    undefined,
    historical.value,
  )
  expect(refusedSuccessor, JSON.stringify(refusedSuccessor)).toMatchObject({ ok: false })
  const refusedCut = resolveAcceptedSpec(predecessor, cut, undefined, undefined, historical.value)
  expect(refusedCut, JSON.stringify(refusedCut)).toMatchObject({
    ok: false,
    reason: 'incomplete',
    evidence: expect.arrayContaining([expect.objectContaining({ code: 'unconfirmed' })]),
  })
  const replayParts = first.parts.map((part, index) => ({
    ...part,
    nativeId: `replay-${index}`,
    locator: `${SCOPE.target}:replay-${index}`,
  }))
  const replayHome = decodeHistory({ ...first.home.source, comments: [...first.home.source.comments, ...replayParts] })
  const replayObservation = {
    ...first.native.observation,
    histories: first.native.observation.histories.map((entry) => (entry === first.home ? replayHome : entry)),
  }
  const replay = await createInstalledObservedUwReadPort({ observation: replayObservation }).readUw(SCOPE)
  expect(replay.accepted).toEqual(first.cold.accepted)
  expect(replay.identity).toEqual(first.cold.identity)
  expect(replay.admission).toEqual(first.cold.admission)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
  ).toBe(retained)
}, 120_000)
