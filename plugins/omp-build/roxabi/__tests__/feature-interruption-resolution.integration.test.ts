import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { actionInputDigest } from '../../engine/action-input.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import {
  interruptionResolutionDigest,
  interruptionResolutionRecordId,
} from '../../engine/workflow-interruption-proof.ts'
import {
  controls,
  type Prompt,
  pauseRecords,
  post,
  proposalOf,
  records,
  resolutions,
  resolve,
  runtimeOf,
  sandboxMandate,
  type World,
} from '../../testing/feature-interruption-resolution-fixture.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim } from '../../testing/sandbox/sandbox-repository.ts'
import { eligiblePlan } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { featureStopMessage } from '../feature-presentation.ts'
import { coldCheckout, invoke } from '../feature-recovery-process-fixture.ts'

const FORMAT = 'omp-build-interruption-resolution/2'
const TIMEOUT = 180_000
const fixtures = roxabiWorkflowFixtures()

afterEach(cleanupFeatureRecoveryRoots)

/** A read-only plan START left orphan by the interrupted session, under that session's confirmed pause. */
function planOrphan(options: { paused?: boolean; productVersion?: string } = {}): World {
  const { box } = featureFixture('start')
  const mandate = sandboxMandate(box, options.productVersion)
  const [start] = fixtures.planDraftRecords(mandate)
  if (start === undefined) throw new Error('missing plan START fixture')
  post(box, [mandate, start, ...(options.paused === false ? [] : pauseRecords(mandate))])
  return { box, mandate, start }
}

function atHead(record: CanonicalRecord, head: string): CanonicalRecord {
  if (record.kind !== 'action-receipt') return record
  const previous = record.payload.inputs
  const manifest = {
    ...previous.manifest,
    code: { repository: SCOPE.repository, base: head, head, referenceCommit: head },
  }
  const built = buildRecord({
    ...record,
    payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
  })
  if (!built.ok) throw new Error(`invalid fixture receipt ${JSON.stringify(built.diagnostics)}`)
  return built.value
}

/** An implement START at the real branch tip, left orphan under the session's confirmed pause. */
function implementationOrphan(): World {
  const { box } = featureFixture('start')
  const mandate = sandboxMandate(box)
  const head = box.sha.main
  if (!head) throw new Error('missing sandbox main')
  const plan = eligiblePlan(mandate, [fixtures.historyFrom([mandate])]).map((record) => atHead(record, head))
  const start = atHead(fixtures.implementStart(mandate), head)
  if (start.kind !== 'action-receipt') throw new Error('invalid implement START fixture')
  post(box, [...plan, start, ...pauseRecords(mandate)])
  return { box, mandate, start }
}

/** A real detached Parent checkout and an orphan integrate START at the published base. */
function integrationOrphan(name: string): World & { checkout: string; head: string } {
  const { box } = featureFixture('start')
  const mandate = sandboxMandate(box)
  const head = box.sha.main
  if (!head) throw new Error('missing sandbox main')
  const implement = atHead(fixtures.implementStart(mandate), head)
  if (
    implement.kind !== 'action-receipt' ||
    implement.payload.phase !== 'start' ||
    implement.payload.action !== 'implement'
  )
    throw new Error('invalid implement START fixture')
  const exactInputs = { mandateId: mandate.recordId, planActionId: 'act-plan-1' }
  const manifest = {
    ...implement.payload.inputs.manifest,
    purpose: 'integrate' as const,
    operands: { action: 'integrate' as const, exactInputs },
  }
  const built = buildRecord({
    ...implement,
    recordId: 'act-integrate-1-start',
    operationId: 'op-act-integrate-1-start',
    payload: {
      ...implement.payload,
      action: 'integrate',
      actionId: 'act-integrate-1',
      exactInputs,
      inputs: { ...implement.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) },
    },
  })
  if (!built.ok || built.value.kind !== 'action-receipt') throw new Error('invalid integrate START fixture')
  const plan = eligiblePlan(mandate, [fixtures.historyFrom([mandate])]).map((record) => atHead(record, head))
  post(box, [...plan, built.value, ...pauseRecords(mandate)])
  const root = path.join(box.root, `parent-worktrees-${name}`)
  box.env.OMP_WORKTREE_DIR = root
  const checkout = path.join(root, 'app', 'parents', 'acme-42')
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(box, box.principal, ['worktree', 'add', '-q', '--detach', checkout, head])
  return { box, mandate, start: built.value, checkout, head }
}

describe('/feature resolve-interruption over a read-only START', () => {
  it(
    'reports partial rather than paused when a genuine abandonment is observed after publication',
    () => {
      const world = planOrphan()
      const outcome = resolve(world, 'abandoned-readback', { operator: 'abandon-readback' })

      expect(outcome.observed).toContainEqual({
        abandon: 'abandoned',
        selection: 'abandoned',
        historicalResolution: true,
      })
      expect(outcome.result).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('uw-partial; resolution may exist; no automatic retry or resume'),
        diagnostics: [expect.objectContaining({ code: 'interruption-pause-unconfirmed' })],
      })
      expect(resolutions(world.box)).toHaveLength(1)
      expect(controls(world.box)).toContain('abandon')
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'refuses before any observation, proposal or effect when the session pause is not confirmed',
    () => {
      const world = planOrphan({ paused: false })
      const before = readSim(world.box).issues['42']?.comments.length

      const outcome = resolve(world, 'unpaused')

      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-not-paused' })
      expect(outcome.observed).toEqual([])
      expect(outcome.prompts).toEqual([])
      expect(readSim(world.box).issues['42']?.comments.length).toBe(before)
    },
    TIMEOUT,
  )

  it(
    'refuses a drifted runtime before any observation, proposal or effect',
    () => {
      const world = planOrphan({ productVersion: '0.18.8' })

      const outcome = resolve(world, 'drift')

      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'config-drift' })
      expect(outcome.observed).toEqual([])
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'refuses when native dispatch has already been admitted',
    () => {
      const world = planOrphan()

      const outcome = resolve(world, 'busy', { executor: 'busy' })

      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-dispatch-unproven' })
      expect(outcome.observed).toEqual([])
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'refuses an orphan with admitted dispatch even when its RESULT is missing',
    () => {
      const world = planOrphan()
      const outcome = resolve(world, 'known-unretained-terminal', {
        start: world.start.recordId,
        executor: 'known-unretained-terminal',
      })
      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-dispatch-unproven' })
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
      expect(outcome.observed).toEqual([{ admitted: true }, { terminal: 'invalid-terminal' }])
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'refuses missing process dispatch evidence before offering confirmation',
    () => {
      const world = planOrphan()
      const outcome = resolve(world, 'missing-dispatch-proof', { executor: 'missing' })
      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-dispatch-unproven' })
      expect(outcome.observed).toEqual([])
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'reports a refusal before publication',
    () => {
      const world = planOrphan()
      const refused = resolve(world, 'throw-before', { operator: 'throw-before' })
      expect(refused.result).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/refused/) })
      expect(resolutions(world.box)).toEqual([])
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'warns visibly that a resolution may exist after a publication failure',
    () => {
      const world = planOrphan()
      const partial = resolve(world, 'throw-after', { operator: 'throw-after' })
      expect(partial.result).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/partial/) })
      const message = featureStopMessage(partial.result as never) ?? ''
      expect(message).toMatch(/partial/i)
      expect(message).toMatch(/(?:may|peut).*(?:exist|exister)/i)
      expect(message).toMatch(/(?:no|aucun).*(?:automatic|automatique).*(?:retry|resume|reprise)/i)
      expect(resolutions(world.box)).toHaveLength(1)
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'publishes a not-dispatched resolution of the exact START after genuine confirmation and stays paused',
    () => {
      const world = planOrphan()

      const outcome = resolve(world, 'settled', { start: world.start.recordId })

      expect(outcome.result).toEqual({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' })
      expect(outcome.prompts).toHaveLength(1)
      const prompt = outcome.prompts[0] as Prompt
      expect(prompt.proposal).toMatchObject({
        format: FORMAT,
        control: 'resolve-interruption',
        action: 'plan',
        actionId: world.start.payload.actionId,
        start: { recordId: world.start.recordId, kind: 'action-receipt' },
        result: null,
        executor: { kind: 'not-dispatched' },
        runtime: runtimeOf(world.mandate),
      })

      const published = resolutions(world.box)
      expect(published).toHaveLength(1)
      const record = published[0] as CanonicalRecord
      expect(record.recordId).toBe(interruptionResolutionRecordId(world.start.recordId))
      expect(record).toMatchObject({
        payload: {
          start: { recordId: world.start.recordId },
          executor: { kind: 'not-dispatched' },
          proposalDigest: prompt.digest,
          confirmation: {
            route: 'omp-native-command',
            operationId: prompt.proposal.operationId,
            proposalDigest: prompt.digest,
          },
        },
      })
      expect(interruptionResolutionDigest(proposalOf(record))).toBe(prompt.digest)
      expect(records(world.box).some((item) => item.recordId === world.start.recordId)).toBe(true)
      expect(controls(world.box)).not.toContain('resume')

      const after = invoke<Record<string, unknown>>(
        world.box,
        coldCheckout(world.box, 'after-resolution'),
        path.join(world.box.root, 'home-after-resolution'),
        'continue',
        { reference: '#42' },
      )
      expect(after).toEqual({ kind: 'paused', confirmed: true, reason: 'paused' })
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )

  it(
    'refuses an unobserved dispatch without offering attestation or confirmation',
    () => {
      const world = planOrphan()
      const outcome = resolve(world, 'unobserved', { executor: 'unobserved' })
      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-dispatch-unproven' })
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'publishes nothing when the confirming session is replaced',
    () => {
      const world = planOrphan()

      const outcome = resolve(world, 'deferred', { operator: 'defer' })

      expect(outcome.prompts).toHaveLength(1)
      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'operator-confirmation-deferred' })
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'refuses a proposal made stale by a late RESULT before publication',
    () => {
      const world = planOrphan()
      const [, result] = fixtures.planDraftRecords(world.mandate)
      if (result === undefined) throw new Error('missing plan RESULT fixture')
      const sequence = [world.mandate, world.start, ...pauseRecords(world.mandate), result]
      const inject = fixtures.framedBodies(sequence, 'operator').at(-1) ?? null

      const outcome = resolve(world, 'stale-result', { operator: 'stale-comment', inject })

      expect(outcome.prompts).toHaveLength(1)
      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'proposal-stale' })
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'denies a duplicate resolution of an already-resolved START',
    () => {
      const world = planOrphan()
      expect(resolve(world, 'first').result).toMatchObject({ reason: 'interruption-resolved' })

      const second = resolve(world, 'second', { start: world.start.recordId })

      expect(second.result).toMatchObject({ kind: 'blocked', reason: 'interruption-target-none' })
      expect(second.prompts).toEqual([])
      expect(resolutions(world.box)).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'refuses an explicit START selector that names no unresolved START',
    () => {
      const world = planOrphan()

      const outcome = resolve(world, 'unknown-start', { start: 'act-unknown-start' })

      expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'interruption-target-none' })
      expect(outcome.prompts).toEqual([])
      expect(resolutions(world.box)).toEqual([])
    },
    TIMEOUT,
  )
})

describe('safe-stop resolution and Git state', () => {
  it.each(['implement', 'integrate'] as const)(
    'records no code effects for %s',
    (action) => {
      const world = action === 'integrate' ? integrationOrphan('safe-stop') : implementationOrphan()
      const checkout =
        action === 'integrate' && 'checkout' in world
          ? world.checkout
          : coldCheckout(world.box, 'safe-stop-implementation')
      if (typeof checkout !== 'string') throw new Error('Expected checkout path')
      const head = git(world.box, checkout, ['rev-parse', 'HEAD'])
      const status = git(world.box, checkout, ['status', '--porcelain'])
      const trace = path.join(world.box.root, `safe-stop-${action}.trace`)
      world.box.env.GIT_TRACE = trace
      writeFileSync(trace, '')
      const outcome = resolve(world, `safe-stop-${action}`, {}, checkout)
      expect(outcome.result).toEqual({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' })
      expect(outcome.prompts[0]?.proposal).toMatchObject({ action, executor: { kind: 'not-dispatched' } })
      expect(outcome.prompts[0]?.proposal).not.toHaveProperty('effects')
      expect(outcome.prompts[0]?.proposal).not.toHaveProperty('adopted')
      expect(git(world.box, checkout, ['rev-parse', 'HEAD'])).toBe(head)
      expect(git(world.box, checkout, ['status', '--porcelain'])).toBe(status)
      expect(readFileSync(trace, 'utf8')).not.toMatch(
        /built-in: git (?:commit|checkout|switch|push|reset|rebase|cherry-pick|merge|revert)\b/,
      )
      expect(controls(world.box)).not.toContain('resume')
    },
    TIMEOUT,
  )
})
