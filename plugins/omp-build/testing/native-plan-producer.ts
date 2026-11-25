import { randomUUID } from 'node:crypto'
import { type MissingContextOutput, missingContextOutputSchema } from '../engine/action-context.ts'
import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import { type PlanOutput, type PlanReview, planDigest, planOutputSchema } from '../engine/workflow-output-schema.ts'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
import type { UwRead } from '../roxabi/uw-contract.ts'
import {
  appendNativeReceipt,
  type HistoryWorld,
  historicalAcceptedInputs,
  historicalPlan,
} from './native-history-records.ts'
import { captureNativePlanBatch, type HistoricalPlanBatch, type HistoricalPlanCapture } from './native-plan-capture.ts'

type Context = {
  world: HistoryWorld
  scope: Scope
  mandate: MandateRecord
  parentScopes: readonly Scope[]
  git: { repository: string; commit: string; tree: string }
}
type StartRef = { scope: Scope; recordId: string; kind: 'action-receipt' }
type OpenedPlanStep = {
  opened: { start: StartRef; followUp: HistoricalPlanBatch }
  start: StartRef
  startRecord: ReceiptRecord
  before: UwRead
  after: UwRead
}

/** Seed a historical START from the observed Accepted Spec. */
export async function openNativePlanStep(input: Context, action: 'plan' | 'plan-review'): Promise<OpenedPlanStep> {
  const { world, scope, mandate } = input
  const before = await world.operations.readUw(scope)
  const macro = historicalPlan(before, scope, mandate)
  const actionId = randomUUID()
  const commit = input.git.commit
  const code = { repository: scope.repository, base: commit, head: commit, referenceCommit: commit }
  const inputs = historicalAcceptedInputs(before, mandate, action, code)
  const authority = { actionId, mandate: { scope, recordId: mandate.recordId, kind: 'mandate' as const } }
  const specDigest = macro.specDigest
  if (specDigest === null) throw new Error('Historical plan has no authenticated Spec')
  const seed = async () => {
    if (action === 'plan') {
      const start = await appendNativeReceipt(world, scope, {
        ...authority,
        action,
        phase: 'start',
        inputs,
        exactInputs: { mandateId: mandate.recordId, specDigest, amendsReviewActionId: null, requiredBlockers: [] },
      })
      return { start, tasks: [{ name: 'R-workflow-plan' }] }
    }
    if (macro.phase !== 'needs-review' || !macro.draftActionId) throw new Error('Historical review needs a draft')
    const plan = before.histories
      .flatMap((history) => history.operations)
      .find(
        ({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'plan' &&
          record.payload.phase === 'result' &&
          record.payload.actionId === macro.draftActionId,
      )?.record
    if (plan?.kind !== 'action-receipt' || plan.payload.action !== 'plan' || plan.payload.phase !== 'result')
      throw new Error('Historical plan result is unavailable')
    const slots: PlanReviewSlot[] = [
      {
        slotId: 'architect',
        specialist: 'R-workflow-plan-architect',
        action: { actionId: randomUUID(), inputs },
      },
      {
        slotId: 'adversarial',
        specialist: 'R-workflow-plan-adversarial',
        action: { actionId: randomUUID(), inputs },
      },
    ]
    const start = await appendNativeReceipt(world, scope, {
      ...authority,
      action,
      phase: 'start',
      inputs,
      slots,
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest,
        draftActionId: macro.draftActionId,
        planDigest: planDigest(planOutputSchema.parse(plan.payload.structured)),
      },
    })
    return { start, tasks: slots.map(({ slotId }) => ({ name: slotId })) }
  }
  const { start, tasks } = await seed()
  const opened = { start: start.ref, followUp: { operationId: actionId, tasks: { tasks } } }
  return { opened, start: start.ref, startRecord: start.record, before, after: await world.operations.readUw(scope) }
}

export async function publishNativePlanStep(
  input: Context,
  step: OpenedPlanStep,
  claims: readonly { task: string; childId: string; value: PlanOutput | PlanReview | MissingContextOutput }[],
) {
  const result = captureNativePlanBatch({ batch: step.opened.followUp, claims })
  return retainHistoricalPlanResult(input, step, result)
}

async function retainHistoricalPlanResult(input: Context, step: OpenedPlanStep, result: HistoricalPlanCapture) {
  const { payload } = step.startRecord
  const { world, scope } = input
  const negative = result.children.find((item) => item.contextBlock)
  const child = negative ?? result.children[0]
  if ((!result.complete && !negative) || !child)
    return {
      published: { published: false, reason: 'action-uncertain' } as const,
      result,
      read: await world.operations.readUw(scope),
    }
  const common = {
    phase: 'result' as const,
    start: step.start,
    native: child.native,
    admission: null,
    diagnostics: [],
  }
  if (payload.phase !== 'start') throw new Error('Historical planner does not have a START')
  const saved =
    payload.action === 'plan'
      ? await appendNativeReceipt(world, scope, {
          ...payload,
          ...common,
          structured: negative
            ? missingContextOutputSchema.parse(negative.structured)
            : planOutputSchema.parse(child.structured),
        })
      : payload.action === 'plan-review'
        ? await appendNativeReceipt(world, scope, {
            ...payload,
            ...common,
            structured: negative ? missingContextOutputSchema.parse(negative.structured) : null,
            contributions: payload.slots.flatMap(({ slotId, specialist, action }) => {
              const captured = result.children.find((item) => item.expectedId === slotId)
              if (!captured && negative) return []
              if (!captured || !action) throw new Error(`Unbound fixture specialist ${slotId}`)
              return [
                {
                  content: 'action-result',
                  inventoryId: null,
                  host: {
                    origin: 'native',
                    phase: null,
                    role: specialist,
                    slotId,
                    chunk: null,
                    childId: captured.id,
                    action,
                  },
                  rawAttempts: captured.submissions,
                  native: captured.native,
                  structured: captured.structured,
                  findings: null,
                },
              ]
            }),
          })
        : undefined
  if (!saved) throw new Error('Historical planner has the wrong action')
  return {
    published: { published: true } as const,
    result,
    read: await world.operations.readUw(scope),
    receipt: saved.ref,
    record: saved.record,
  }
}
