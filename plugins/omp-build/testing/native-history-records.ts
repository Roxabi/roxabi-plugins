import { randomUUID } from 'node:crypto'
import { encodeRecord } from '../adapters/github/history-codec.ts'
import type { Gh } from '../adapters/github/types.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { Scope } from '../engine/record-values.ts'
import { historyFor, type MandateRecord } from '../engine/workflow-control.ts'
import { planMacro } from '../engine/workflow-plan-macro.ts'
import { ACTION_RECEIPT_FORMAT, type ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { PreparedUwAction, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { integrationProofInputs } from '../roxabi/uw-action-stage-closure.ts'
import type { UwOperations, UwRead } from '../roxabi/uw-contract.ts'

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

export async function prepareHistoricalAction(
  world: HistoryWorld,
  scope: Scope,
  input: Omit<UwActionRequest, 'subject' | 'expandedContext' | 'stageSources'> &
    Partial<Pick<UwActionRequest, 'stageSources'>>,
): Promise<PreparedUwAction> {
  const prepared = await world.operations.prepareAction({
    stageSources: [],
    expandedContext: [],
    ...input,
    subject: { kind: 'uw', uw: scope, pullRequest: null, binding: null },
  })
  if (!prepared.ok)
    throw new Error(`Historical ${input.purpose} inputs unavailable: ${JSON.stringify(prepared.diagnostics)}`)
  return prepared.value
}

export async function openHistoricalDelivery(input: {
  world: HistoryWorld
  scope: Scope
  mandate: MandateRecord
  read: UwRead
  action: 'implement' | 'integrate'
  code: UwActionRequest['code']
}) {
  const { world, scope, mandate, read, action, code } = input
  const plan = historicalPlan(read, scope, mandate)
  const planActionId = plan.amendmentActionId ?? plan.draftActionId
  if (plan.phase !== 'eligible' || planActionId === null) throw new Error(`${action} fixture needs an eligible plan`)
  const actionId = randomUUID()
  const exactInputs = { mandateId: mandate.recordId, planActionId }
  const closure = action === 'integrate' ? integrationProofInputs(read) : null
  if (closure !== null && !closure.ok)
    throw new Error(`Integration proof is unavailable: ${JSON.stringify(closure.diagnostics)}`)
  const prepared = await prepareHistoricalAction(world, scope, {
    actionId,
    purpose: action,
    code,
    ...(closure === null
      ? {}
      : { operands: { action: 'integrate', exactInputs }, stageSources: closure.value.stageSources }),
  })
  const authority = {
    action,
    actionId,
    mandate: { scope, kind: 'mandate' as const, recordId: mandate.recordId },
    inputs: prepared.inputs,
    exactInputs,
  }
  const start = await appendNativeReceipt(world, scope, { ...authority, phase: 'start' })
  return { authority, start: start.ref }
}
