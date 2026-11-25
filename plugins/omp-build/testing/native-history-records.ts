import { randomUUID } from 'node:crypto'
import { encodeRecord } from '../adapters/github/history-codec.ts'
import type { Gh } from '../adapters/github/types.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputManifest, ActionInputs, RecordInputRef } from '../engine/action-input-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { historyFor, type MandateRecord } from '../engine/workflow-control.ts'
import { planMacro } from '../engine/workflow-plan-macro.ts'
import { ACTION_RECEIPT_FORMAT, type ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { UwOperations, UwRead } from '../roxabi/uw-contract.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { pinAcceptedSources } from './workflow-record-pins.ts'

export type HistoryWorld = { cwd: string; gh: Gh; operations: UwOperations }

type ReceiptFields<T = ActionReceiptPayload> = T extends ActionReceiptPayload ? Omit<T, 'format'> : never

/** Seed a historical receipt through the same comment transport the reader observes. */
export async function appendNativeReceipt(world: HistoryWorld, scope: Scope, payload: ReceiptFields) {
  const read = await world.operations.readUw(scope)
  const history = historyFor(scope, read.histories)
  if (!history?.source.complete) throw new Error(`Fixture history is incomplete: ${scope.target}`)
  const built = buildRecord({
    ...scope,
    version: 1,
    kind: 'action-receipt',
    runId: randomUUID(),
    recordId: randomUUID(),
    operationId: payload.phase === 'start' ? payload.actionId : `${payload.actionId}:result`,
    payload: { ...payload, format: ACTION_RECEIPT_FORMAT },
  })
  if (!built.ok || built.value.kind !== 'action-receipt')
    throw new Error(`Fixture receipt is invalid: ${JSON.stringify(built)}`)
  const encoded = encodeRecord(built.value, history.source, null, read.histories)
  if (!encoded.ok) throw new Error(`Fixture receipt could not be encoded: ${JSON.stringify(encoded.diagnostics)}`)
  const number = scope.target.slice(scope.repository.length + 1)
  for (const body of encoded.value)
    await world.gh(world.cwd, [
      'api',
      '--method',
      'POST',
      `repos/${scope.repository}/issues/${number}/comments`,
      '-f',
      `body=${body}`,
    ])
  return { record: built.value, ref: { scope, recordId: built.value.recordId, kind: 'action-receipt' as const } }
}

export function historicalPlan(read: UwRead, scope: Scope, mandate: MandateRecord) {
  const issue = historyFor(scope, read.histories)
  if (!issue || read.observation.status !== 'complete')
    throw new Error(`Incomplete fixture observation: ${scope.target}`)
  return planMacro(
    {
      issue,
      pullRequest: null,
      parents: read.histories.filter((history) => history !== issue),
      causal: {
        histories: read.observation.histories,
        catalogues: read.observation.catalogues,
        observation: read.observation,
      },
    },
    mandate,
  )
}

export function historicalAcceptedInputs(
  read: UwRead,
  mandate: MandateRecord,
  purpose: ActionInputManifest['purpose'],
  code: ActionInputManifest['code'],
  operands?: ActionInputManifest['operands'],
): ActionInputs {
  if (read.accepted.status !== 'accepted' || read.observation.status !== 'complete')
    throw new Error(`Historical ${purpose} fixture has no accepted Spec: ${read.uw.target}`)
  const accepted = read.accepted.value
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.ref,
    histories: read.observation.histories,
    graph: read.observation.graph,
  })
  if (!effective.ok) throw new Error(`Historical ${purpose} effective Spec unavailable: ${JSON.stringify(effective)}`)
  const inputs = acceptedActionInputs(mandate, purpose, effective.value, code)
  const pins = pinAcceptedSources(read.observation.histories, [
    ...accepted.sourceRefs,
    ...[accepted.ref, ...accepted.inheritedOwnSpecRefs].map((item) => item.sourceAccepted),
  ])
  if (!pins.ok) throw new Error(`Historical ${purpose} source pins unavailable: ${JSON.stringify(pins)}`)
  const manifest = {
    ...inputs.manifest,
    acceptedSources: pins.value,
    ...(operands === undefined ? {} : { operands }),
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

export async function openHistoricalDelivery(
  input: {
    world: HistoryWorld
    scope: Scope
    mandate: MandateRecord
    read: UwRead
    code: ActionInputManifest['code']
  } & ({ action: 'implement' } | { action: 'integrate'; childProofs: readonly ExternalRecordRef[] }),
) {
  const { world, scope, mandate, read, action, code } = input
  const plan = historicalPlan(read, scope, mandate)
  const planActionId = plan.amendmentActionId ?? plan.draftActionId
  if (plan.phase !== 'eligible' || planActionId === null) throw new Error(`${action} fixture needs an eligible plan`)
  const actionId = randomUUID()
  const exactInputs = { mandateId: mandate.recordId, planActionId }
  const inputs = historicalAcceptedInputs(
    read,
    mandate,
    action,
    code,
    action === 'integrate' ? { action, exactInputs } : undefined,
  )
  let stageSources: RecordInputRef[] = []
  if (input.action === 'integrate') {
    const stage = pinAcceptedSources(read.histories, input.childProofs)
    if (!stage.ok) throw new Error(`Historical integration child pins unavailable: ${JSON.stringify(stage)}`)
    const parentPins = new Set(inputs.manifest.acceptedSources.map(canonicalValueDigest))
    stageSources = stage.value.filter((pin) => !parentPins.has(canonicalValueDigest(pin)))
    if (stageSources.length === 0) throw new Error('Historical integration lacks child proof')
  }
  const authority = {
    action,
    actionId,
    mandate: { scope, kind: 'mandate' as const, recordId: mandate.recordId },
    inputs: { ...inputs, stageSources },
    exactInputs,
  }
  const start = await appendNativeReceipt(world, scope, { ...authority, phase: 'start' })
  return { authority, start: start.ref }
}
