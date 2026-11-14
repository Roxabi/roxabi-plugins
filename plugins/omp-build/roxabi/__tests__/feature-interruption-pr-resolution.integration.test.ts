import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { failedCheckEvidenceDigest } from '../../engine/record-digests.ts'
import { scopedRecordRefSchema } from '../../engine/record-references.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import {
  interruptionResolutionDigest,
  interruptionResolutionRecordId,
} from '../../engine/workflow-interruption-proof.ts'
import { ACTION_RECEIPT_FORMAT } from '../../engine/workflow-receipt-schema.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import {
  controls,
  type Outcome,
  type Prompt,
  pauseRecords,
  post,
  proposalOf,
  resolve,
  runtimeOf,
  sandboxMandate,
  type World,
} from '../../testing/feature-interruption-resolution-fixture.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const FORMAT = 'omp-build-interruption-resolution/2'
const TIMEOUT = 180_000
const fixtures = roxabiWorkflowFixtures()
afterEach(cleanupFeatureRecoveryRoots)
/** An orphan attribute-ci START on a real simulated PR, bound to the paused issue mandate. */
function ciOrphan(): World & { pull: typeof SCOPE } {
  const { box } = featureFixture('start', { malformedDisarmPr: true })
  const mandate = sandboxMandate(box)
  const head = box.sha.main
  if (!head || !mandate.payload.branch) throw new Error('missing PR fixture head or branch')
  const pull = { repository: SCOPE.repository, target: 'acme/app#9' }
  const failures = [{ name: 'test', source: 'ci', observationId: 'check-11', conclusion: 'FAILURE' }]
  const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA: head, scope: pull, failures })
  if (evidenceDigest === null) throw new Error('missing CI evidence digest')
  const exactInputs = { candidateGitSHA: head, scope: pull, failedChecks: ['test'], evidenceDigest, failures }
  const inputs = acceptedActionInputs(mandate, 'attribute-ci')
  const manifest = {
    ...inputs.manifest,
    code: { ...inputs.manifest.code, base: head, head, referenceCommit: head },
    operands: { action: 'attribute-ci' as const, exactInputs },
  }
  const built = buildRecord({
    ...pull,
    version: 1,
    recordId: 'ci-start',
    runId: 'ci-run',
    operationId: 'ci-start-op',
    kind: 'action-receipt',
    payload: {
      format: ACTION_RECEIPT_FORMAT,
      phase: 'start',
      action: 'attribute-ci',
      actionId: 'act-ci-1',
      mandate: { scope: SCOPE, recordId: mandate.recordId, kind: 'mandate' },
      exactInputs,
      inputs: { ...inputs, manifest, fingerprint: actionInputDigest(manifest) },
    },
  })
  if (!built.ok || built.value.kind !== 'action-receipt') throw new Error('invalid CI START fixture')
  const issueRecords = [mandate, ...pauseRecords(mandate)]
  const binding = fixtures.workflowBinding(pull, mandate, mandate.payload.branch, mandate.payload.base)
  const prBodies = fixtures.framedBodies([binding, built.value], 'operator', [fixtures.historyFrom(issueRecords)])
  post(box, issueRecords)
  writeSim(box, (state) => {
    const pr = state.prs['9']
    if (!pr) throw new Error('missing simulated PR')
    pr.labels = []
    pr.closes = [42]
    pr.body = 'Closes #42'
    pr.comments = prBodies.map((body) => ({ author: 'operator', body }))
  })
  return { box, mandate, start: built.value, pull }
}
it(
  'publishes and authenticates a non-dispatched PR attribute-ci resolution through installed UW and GitHub',
  () => {
    const world = ciOrphan()
    const before = readSim(world.box)
    const outcome = resolve(world, 'ci-cross-scope', {
      startTarget: world.pull.target,
      mandateId: world.mandate.recordId,
    }) as Outcome & {
      dialog: string
      confirmations: number
      dispatch: { kind: string } | null
      before: { status: string; starts: Array<{ scope: typeof SCOPE; recordId: string }> }
      readback: {
        status: string
        admitted: {
          ok: boolean
          value?: { record: CanonicalRecord; start: CanonicalRecord; pause: CanonicalRecord } | null
        }
        selection: { status: string; reason?: string } | null
        starts: Array<{ scope: typeof SCOPE; recordId: string }>
      }
    }

    expect(outcome.result).toMatchObject({
      status: 'resolved',
      start: { scope: world.pull, recordId: world.start.recordId },
    })
    expect(outcome.confirmations).toBe(1)
    expect(outcome.dialog).toContain(world.start.recordId)
    expect(outcome.before.status).toBe('complete')
    expect(outcome.before.starts).toContainEqual({ scope: world.pull, recordId: world.start.recordId })
    expect(outcome.dispatch).toEqual({ kind: 'not-activated' })
    expect(outcome.prompts).toHaveLength(1)
    const prompt = outcome.prompts[0] as Prompt
    expect(prompt.proposal).toMatchObject({
      format: FORMAT,
      action: 'attribute-ci',
      actionId: 'act-ci-1',
      mandate: { scope: SCOPE, recordId: world.mandate.recordId },
      start: { scope: world.pull, recordId: world.start.recordId },
      executor: { kind: 'not-dispatched' },
      result: null,
      runtime: runtimeOf(world.mandate),
    })
    expect(outcome.readback.status).toBe('complete')
    expect(outcome.readback.selection).toMatchObject({ status: 'refused', reason: 'paused' })
    expect(outcome.readback.starts).toEqual(outcome.before.starts)
    expect(outcome.readback.admitted.ok).toBe(true)
    const admitted = outcome.readback.admitted.value
    if (!admitted) throw new Error('installed GitHub readback did not authenticate the CI resolution')
    expect(admitted.start).toEqual(world.start)
    expect(admitted.pause).toMatchObject({ payload: { control: 'pause-confirmed', disarm: { observed: true } } })
    expect(admitted.record).toMatchObject({
      recordId: interruptionResolutionRecordId(world.start.recordId),
      payload: {
        start: { scope: world.pull, recordId: world.start.recordId },
        proposalDigest: prompt.digest,
        confirmation: {
          route: 'omp-native-command',
          operationId: prompt.proposal.operationId,
          proposalDigest: prompt.digest,
        },
      },
    })
    expect(interruptionResolutionDigest(proposalOf(admitted.record))).toBe(prompt.digest)
    const parsedResolution = scopedRecordRefSchema.safeParse(outcome.result.resolution)
    if (!parsedResolution.success) throw new Error('resolution is not a canonical scoped record reference')
    const selected = parsedResolution.data
    expect(selected).toEqual({
      kind: 'operator-control',
      scope: { repository: admitted.record.repository, target: admitted.record.target },
      recordId: admitted.record.recordId,
    })
    const after = readSim(world.box)
    const home =
      selected.scope.target === SCOPE.target
        ? after.issues['42']
        : selected.scope.target === world.pull.target
          ? after.prs['9']
          : null
    if (!home) throw new Error(`unexpected selected resolution home ${selected.scope.target}`)
    const decoded = decodeHistory({
      scope: selected.scope,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: home.comments.map((comment, index) => ({
        locator: `${selected.scope.target}:comment:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
    expect(decoded.operations.filter((operation) => operation.record?.recordId === selected.recordId)).toMatchObject([
      { status: 'complete', authority: 'accounted', record: admitted.record },
    ])
    const beforeCount = (before.issues['42']?.comments.length ?? 0) + (before.prs['9']?.comments.length ?? 0)
    const afterCount = (after.issues['42']?.comments.length ?? 0) + (after.prs['9']?.comments.length ?? 0)
    expect(afterCount).toBeGreaterThan(beforeCount)
    expect(controls(world.box)).not.toContain('resume')
  },
  TIMEOUT,
)
