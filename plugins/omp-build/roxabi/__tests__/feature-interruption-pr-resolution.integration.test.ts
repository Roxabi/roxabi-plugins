import { afterEach, expect, it } from 'vitest'
import { interruptionResolution } from '../../engine/__tests__/workflow-interruption-support.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import { buildRecord, parseRecord } from '../../engine/record-construction.ts'
import { failedCheckEvidenceDigest } from '../../engine/record-digests.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { interruptionResolutionRecordId } from '../../engine/workflow-interruption-proof.ts'
import { ACTION_RECEIPT_FORMAT } from '../../engine/workflow-receipt-schema.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import {
  pauseRecords,
  post,
  readHistoricalResolution,
  sandboxMandate,
  type World,
} from '../../testing/feature-interruption-resolution-fixture.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const TIMEOUT = 180_000
const fixtures = roxabiWorkflowFixtures()
afterEach(cleanupFeatureRecoveryRoots)
/** A historical attribute-ci resolution on a real simulated PR, bound to its paused issue mandate. */
function ciResolution(): World & { pull: typeof SCOPE; resolution: CanonicalRecord } {
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
  const [pauseRequest, pause] = pauseRecords(mandate)
  if (pauseRequest === undefined || pause === undefined) throw new Error('missing pause fixture')
  const issueRecords = [mandate, pauseRequest, pause]
  const historical = parseRecord(
    interruptionResolution({
      mandate,
      pause,
      start: built.value,
      result: null,
      recordId: interruptionResolutionRecordId(built.value.recordId),
    }),
  )
  if (!historical.ok) throw new Error(JSON.stringify(historical))
  const binding = fixtures.workflowBinding(pull, mandate, mandate.payload.branch, mandate.payload.base)
  const prBodies = fixtures.framedBodies([binding, built.value, historical.value], 'operator', [
    fixtures.historyFrom(issueRecords),
  ])
  post(box, issueRecords)
  writeSim(box, (state) => {
    const pr = state.prs['9']
    if (!pr) throw new Error('missing simulated PR')
    pr.labels = []
    pr.closes = [42]
    pr.body = 'Closes #42'
    pr.comments = prBodies.map((body) => ({ author: 'operator', body }))
  })
  return { box, mandate, start: built.value, pull, resolution: historical.value }
}

it(
  'authenticates a historical PR attribute-ci resolution without changing the paused mandate',
  () => {
    const world = ciResolution()
    const before = readSim(world.box)
    expect(readHistoricalResolution(world)).toMatchObject({
      selection: { status: 'refused', reason: 'paused' },
      resolution: {
        ok: true,
        value: {
          start: world.start,
          pause: { payload: { control: 'pause-confirmed', disarm: { observed: true } } },
          record: world.resolution,
        },
      },
    })
    const after = readSim(world.box)
    const authored = (comments: (typeof before.issues)[string]['comments'] | undefined) =>
      comments?.map(({ author, body }) => ({ author, body }))
    expect(authored(after.issues['42']?.comments)).toEqual(authored(before.issues['42']?.comments))
    expect(authored(after.prs['9']?.comments)).toEqual(authored(before.prs['9']?.comments))
  },
  TIMEOUT,
)
