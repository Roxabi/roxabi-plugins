import type { Gh } from '../adapters/github/types.ts'
import type { ActionInputs } from '../dist/contracts.js'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { deliveryTask } from '../roxabi/delivery-action.ts'
import type {
  FixIdentity,
  FixRecord,
  FixTarget,
  PreparedFix,
  PublishBinding,
  RecordPublisher,
} from '../roxabi/fix-contract.ts'
import { publishNativeContributions, taskSlot } from '../roxabi/fix-contributions-native.ts'
import { resolveFixOrigin } from '../roxabi/fix-origin.ts'
import { publishOperatorRequest, record } from '../roxabi/fix-records.ts'
import type { UwActionPorts } from '../roxabi/uw-action-contract.ts'
import { prepareUwAction, replayUwActionInputs } from '../roxabi/uw-action-inputs.ts'
import { verifyActionSnapshot } from '../roxabi/uw-action-snapshot.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { fixtureUwOperations } from './action-input-fixtures.ts'

/** Construct and publish a second, ordinary correction root using actual prepared inputs. */
export async function multiSlotCorrectionRoot(input: {
  cwd: string
  gh: Gh
  ports: UwActionPorts
  publisher: RecordPublisher
  identity: FixIdentity
  target: FixTarget
  intakeInputs: ActionInputs
  oldRequest: Extract<CanonicalRecord, { kind: 'fix-request' }>
  oldOperator: Extract<CanonicalRecord, { kind: 'contribution' }>
  role: string
  settle: (batch: NativeBatch) => Promise<NativeBatchResult>
}) {
  const raw = input.oldOperator.payload.rawAttempts[0]?.raw
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('operator-request-raw-missing')
  const publishBinding = raw.publishBinding as unknown as PublishBinding
  const operatorRequest = raw.operatorRequest
  if (operatorRequest === undefined || !publishBinding) throw new Error('operator-binding-missing')
  const published = await publishOperatorRequest(input.publisher, input.identity, input.target, {
    rawOperatorRequest: operatorRequest,
    publishBinding,
    scope: input.oldRequest.payload.scope,
    existingReviewId: null,
    contextInputs: [],
    originalSpec: input.oldRequest.payload.originalSpec,
  })
  if (!published.ok) throw new Error(`operator-root-refused: ${published.diagnostics.join(',')}`)
  const inventoryId = input.identity.nextRecordId('review-attempt')
  const request = {
    actionId: inventoryId,
    purpose: 'correction' as const,
    subject: input.intakeInputs.manifest.subject,
    code: input.intakeInputs.manifest.code,
    stageSources: [],
    expandedContext: [],
  }
  const preparedAction = await prepareUwAction(request, input.ports)
  if (!preparedAction.ok) throw new Error(`intake-prepare-refused: ${JSON.stringify(preparedAction.diagnostics)}`)
  const replay = await replayUwActionInputs({ reviewed: preparedAction.value.inputs, request }, input.ports)
  const snapshot = await verifyActionSnapshot(preparedAction.value.snapshot)
  if (!replay.ok || replay.value.fingerprint !== preparedAction.value.inputs.fingerprint || !snapshot.ok)
    throw new Error('intake-replay-or-seal-refused')
  const tasks = ['intake-one', 'intake-two'].map((name) =>
    deliveryTask({
      name,
      agent: input.role,
      procedure: 'Inspect the correction and return structured findings.',
      solutionSpace: 'Correction findings only.',
      prepared: preparedAction.value,
    }),
  )
  const policy = { version: 'baseline' as const }
  const inventory = record(
    input.identity,
    input.target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: input.target.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4',
      input: preparedAction.value.inputs.fingerprint,
      actionInputDigest: preparedAction.value.inputs.fingerprint,
      stage: 'initial',
      purpose: 'correction',
      requestId: published.value.request.recordId,
      policy,
      slots: tasks.map((task) => taskSlot(task, 'intake', 'findings')),
    },
    [published.value.request.recordId],
    inventoryId,
  )
  const saved = await input.publisher.publish(inventory)
  if (!saved.ok) throw new Error(`inventory-refused: ${saved.diagnostics.join(',')}`)
  const subject = preparedAction.value.inputs.manifest.subject
  if (subject.kind !== 'uw') throw new Error('bound-uw-missing')
  const origin = await resolveFixOrigin(
    subject.uw,
    createInstalledUwReadPort({ cwd: input.cwd, gh: input.gh, readAuthor: 'operator' }),
  )
  if (!origin.ok) throw new Error(`origin-refused: ${origin.diagnostics.join(',')}`)
  const batch = { operationId: input.identity.operationId, tasks: { context: 'Correction intake fixture.', tasks } }
  const prepared: PreparedFix = {
    target: input.target,
    requestId: published.value.request.recordId,
    inventoryId,
    batch,
    causeContext: origin.value,
    sourceContributionId: published.value.source.recordId,
    policy,
    cwd: input.cwd,
    publishBinding,
    subject,
  }
  const result = await input.settle(batch)
  const outputs = await publishNativeContributions(
    prepared,
    input.identity,
    input.publisher,
    inventoryId,
    tasks,
    'intake',
    'findings',
    [inventoryId],
    result,
  )
  if (!outputs.ok) throw new Error(`intake-output-refused: ${outputs.diagnostics.join(',')}`)
  const operations = {
    ...fixtureUwOperations(),
    prepareAction: (
      action: Parameters<typeof prepareUwAction>[0],
      projection?: Parameters<typeof prepareUwAction>[2],
      review?: Parameters<typeof prepareUwAction>[3],
      root?: Parameters<typeof prepareUwAction>[4],
    ) => prepareUwAction(action, input.ports, projection, review, root),
    replayActionInputs: (replayInput: Parameters<typeof replayUwActionInputs>[0]) =>
      replayUwActionInputs(replayInput, input.ports),
    verifyAction: verifyActionSnapshot,
  }
  return { prepared, inventory, outputs: outputs.value as FixRecord[], operations }
}
