import { buildRecord } from '../engine/record-construction.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Contribution, Json, NativeOutcome } from '../engine/record-values.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import { type PlanOutput, planDigest } from '../engine/workflow-output-schema.ts'
import type { ActionReceiptPayload, PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'

export type WorkflowActionFixtureContext = {
  planOutput: PlanOutput
  planSlots: readonly PlanReviewSlot[]
  nativeOutcome: NativeOutcome
  head: string
}

function mustRecord(draft: Parameters<typeof buildRecord>[0]): CanonicalRecord {
  const result = buildRecord(draft)
  if (!result.ok) throw new Error(result.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
  return result.value
}

function mustReceipt(draft: Parameters<typeof buildRecord>[0]): ReceiptRecord {
  const record = mustRecord(draft)
  if (record.kind !== 'action-receipt') throw new Error('fixture is not an action receipt')
  return record
}

function recordRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

function mandateRef(record: MandateRecord): ExternalRecordRef {
  return { ...recordRef(record), kind: 'mandate' }
}

function specSha(mandate: MandateRecord): string {
  return mandate.payload.ownSpec.version
}

export function createWorkflowActionFixtures(context: WorkflowActionFixtureContext) {
  const receipt = (
    mandate: MandateRecord,
    recordId: string,
    operationId: string,
    payload: ActionReceiptPayload,
  ): ReceiptRecord =>
    mustReceipt({
      version: 1,
      recordId,
      runId: mandate.runId,
      operationId,
      repository: mandate.repository,
      target: mandate.target,
      kind: 'action-receipt',
      payload,
    })
  const implementStart = (mandate: MandateRecord, actionId = 'act-implement-1') =>
    receipt(mandate, `${actionId}-start`, `op-${actionId}-start`, {
      phase: 'start',
      action: 'implement',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: { mandateId: mandate.recordId, planActionId: 'act-plan-1' },
    })
  const planDraftRecords = (mandate: MandateRecord, actionId = 'act-plan-1', specVersion = specSha(mandate)) => {
    const start = receipt(mandate, `${actionId}-start`, `op-${actionId}-start`, {
      phase: 'start',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specVersion,
        amendsReviewActionId: null,
        requiredBlockers: [],
      },
    })
    const result = receipt(mandate, `${actionId}-result`, `op-${actionId}-result`, {
      phase: 'result',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      start: recordRef(start),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specVersion,
        amendsReviewActionId: null,
        requiredBlockers: [],
      },
      native: context.nativeOutcome,
      structured: context.planOutput,
      admission: null,
      diagnostics: [],
    })
    return [start, result]
  }
  const planReviewStart = (
    mandate: MandateRecord,
    draftActionId: string,
    digest: string,
    actionId = 'act-plan-review-1',
    specVersion = specSha(mandate),
  ) =>
    receipt(mandate, `${actionId}-start`, `op-${actionId}-start`, {
      phase: 'start',
      action: 'plan-review',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: { mandateId: mandate.recordId, specDigest: specVersion, planDigest: digest, draftActionId },
      slots: [...context.planSlots],
    })
  const planReviewRecord = (
    mandate: MandateRecord,
    draftActionId: string,
    digest: string,
    contributions: Contribution[],
    actionId = 'act-plan-review-1',
    specVersion = specSha(mandate),
  ) => {
    const start = planReviewStart(mandate, draftActionId, digest, actionId, specVersion)
    return receipt(mandate, `${actionId}-result`, `op-${actionId}-result`, {
      phase: 'result',
      action: 'plan-review',
      actionId,
      mandate: mandateRef(mandate),
      start: recordRef(start),
      exactInputs: { mandateId: mandate.recordId, specDigest: specVersion, planDigest: digest, draftActionId },
      slots: [...context.planSlots],
      contributions,
      native: context.nativeOutcome,
      structured: null,
      admission: null,
      diagnostics: [],
    })
  }
  const planContribution = (slotId: string, specialist: string, structured: Json): Contribution => ({
    content: 'findings',
    inventoryId: null,
    host: { origin: 'native', phase: null, role: specialist, slotId, chunk: 0, childId: slotId },
    rawAttempts: [],
    native: context.nativeOutcome,
    structured,
    findings: null,
  })
  const clearPlanContribution = (slotId: string, specialist: string) =>
    planContribution(slotId, specialist, { outcome: 'clear', blockers: [] })
  const blockingPlanContribution = (slotId: string, specialist: string, blockerId: string) =>
    planContribution(slotId, specialist, {
      outcome: 'blocking',
      blockers: [{ id: blockerId, criterion: 'save', gap: 'the mapping omits the stale-region path' }],
    })
  const planAmendmentRecords = (
    mandate: MandateRecord,
    reviewActionId: string,
    requiredBlockers: { sourceId: string; slotId: string; blockerId: string }[],
    resolutions: PlanOutput['resolutions'],
    actionId = 'act-plan-2',
  ) => {
    const exactInputs = {
      mandateId: mandate.recordId,
      specDigest: specSha(mandate),
      amendsReviewActionId: reviewActionId,
      requiredBlockers,
    }
    const start = receipt(mandate, `${actionId}-start`, `op-${actionId}-start`, {
      phase: 'start',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs,
    })
    const result = receipt(mandate, `${actionId}-result`, `op-${actionId}-result`, {
      phase: 'result',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      start: recordRef(start),
      exactInputs,
      native: context.nativeOutcome,
      structured: { steps: context.planOutput.steps, resolutions },
      admission: null,
      diagnostics: [],
    })
    return [start, result]
  }
  const publishedPlanDigest = () => planDigest(context.planOutput)
  const rejectedImplementResult = (mandate: MandateRecord, actionId = 'act-implement-1') => {
    const start = implementStart(mandate, actionId)
    return receipt(mandate, `${actionId}-result`, `op-${actionId}-result`, {
      phase: 'result',
      action: 'implement',
      actionId,
      mandate: mandateRef(mandate),
      start: recordRef(start),
      exactInputs: { mandateId: mandate.recordId, planActionId: 'act-plan-1' },
      native: context.nativeOutcome,
      structured: {
        outcome: 'implemented',
        commitSHAs: [context.head],
        commands: [{ toolCallId: 'call-1', command: 'git status', exitCode: 0 }],
        proofToolCallId: 'proof-1',
        proofUnavailableReason: null,
        reason: 'model claims implemented',
      },
      admission: {
        admitted: false,
        commits: [],
        paths: [],
        commands: [{ toolCallId: 'call-1', command: 'git status', exitCode: 0, cwd: '/tmp/worktree' }],
        remoteBranch: null,
        remoteTip: null,
        published: false,
        reason: 'remote tip unreachable',
      },
      diagnostics: [],
    })
  }
  const pauseRequested = (mandate: MandateRecord, controlId = 'control-pause-1') =>
    mustRecord({
      version: 1,
      recordId: `${controlId}-requested`,
      runId: mandate.runId,
      operationId: `op-${controlId}-requested`,
      repository: mandate.repository,
      target: mandate.target,
      kind: 'operator-control',
      payload: { control: 'pause-requested', predecessor: null, controlId, mandate: mandateRef(mandate) },
    })
  const pauseConfirmed = (mandate: MandateRecord, request: CanonicalRecord, controlId = 'control-pause-1') =>
    mustRecord({
      version: 1,
      recordId: `${controlId}-confirmed`,
      runId: mandate.runId,
      operationId: `op-${controlId}-confirmed`,
      repository: mandate.repository,
      target: mandate.target,
      kind: 'operator-control',
      payload: {
        control: 'pause-confirmed',
        predecessor: recordRef(request),
        controlId,
        mandate: mandateRef(mandate),
        disarm: { observed: true, evidence: { pr: 20, disabled: true } },
      },
    })
  return {
    pauseRequested,
    pauseConfirmed,
    implementStart,
    planDraftRecords,
    planReviewStart,
    planReviewRecord,
    clearPlanContribution,
    blockingPlanContribution,
    planAmendmentRecords,
    publishedPlanDigest,
    rejectedImplementResult,
  }
}
