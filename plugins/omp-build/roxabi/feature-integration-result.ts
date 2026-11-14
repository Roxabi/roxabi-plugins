import { randomUUID } from 'node:crypto'
import {
  canonicalValueDigest,
  type DeliveryMissingContext,
  deliveryMissingContextSchema,
  hostInterruptionDiagnostic,
  integrationOutputSchema,
} from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { IntegrationOutput } from '../engine/uw-integration-schema.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { publishTerminalNegative } from './feature-action-terminal-result.ts'
import { matchesContextNegative } from './feature-context-negative.ts'
import { publishRecord } from './feature-engine.ts'
import { hostCompletedStructured } from './feature-implementation-receipt.ts'
import { admitIntegration, type IntegrationAdmission } from './feature-integration-admission.ts'
import { IntegrationRefusal } from './feature-integration-observation.ts'
import { implementNativeOutcome, type nativeOutcome } from './feature-native-outcome.ts'
import type { GitRunner } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

function selectContribution(
  result: NativeBatchResult,
  opened: NonImplementPublication['opened'],
): { reason: string } | { child: NativeBatchResult['children'][number] } {
  const tasks = result.batch.tasks.tasks
  const task = tasks[0]
  if (
    tasks.length !== 1 ||
    task?.agent !== 'R-workflow-implement' ||
    task.action === undefined ||
    !equal(task.action.inputs, opened.payload.inputs) ||
    result.batch.operationId !== opened.payload.actionId
  )
    return { reason: 'integration-task-mismatch' }
  const children = result.children.filter((child) => child.expectedId === task.name)
  const child = children[0]
  if (children.length !== 1 || child === undefined || child.id === null) return { reason: 'missing-contribution' }
  if (result.canPublishContext?.() === false) return { reason: 'publication-ownership-revoked' }
  return { child }
}

export type IntegrationPublicationInput = {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  stop?: NativeStop
  gh: Gh
  git: GitRunner
}

function prepareIntegrationContextNegative(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  child: NativeBatchResult['children'][number],
) {
  if (
    input.result.canPublishContext?.() !== true ||
    !matchesContextNegative(child, context.opened.payload.actionId, context.opened.payload.inputs)
  )
    return { reason: 'integration-context-binding-mismatch' }
  const negative = deliveryMissingContextSchema.safeParse(child.structured)
  if (!negative.success) return { reason: 'integration-output-invalid' }
  const ids =
    'commands' in negative.data
      ? new Set(negative.data.commands.map((command) => command.toolCallId))
      : new Set<string>()
  return { structured: negative.data, native: implementNativeOutcome(child, true, ids), admission: null }
}

async function prepareIntegrationEvidence(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  child: NativeBatchResult['children'][number],
): Promise<
  | { reason: string }
  | {
      structured: IntegrationOutput | DeliveryMissingContext
      native: ReturnType<typeof nativeOutcome>
      admission: IntegrationAdmission | null
    }
> {
  if (child.contextBlock !== undefined) return prepareIntegrationContextNegative(input, context, child)
  if (!input.result.complete || !child.usable) return { reason: 'action-uncertain' }
  const parsed = integrationOutputSchema.safeParse(hostCompletedStructured(child))
  if (!parsed.success) return { reason: 'integration-output-invalid' }
  const structured = parsed.data
  try {
    const admission = await admitIntegration(input, context, child, structured)
    const ids = new Set(structured.commands.map((command) => command.toolCallId))
    return { structured, native: implementNativeOutcome(child, true, ids), admission }
  } catch (error) {
    if (error instanceof IntegrationRefusal && error.message === 'integration-start-resolved')
      return { reason: error.message }
    if (!(error instanceof IntegrationRefusal)) throw error
    const ids = new Set(structured.commands.map((command) => command.toolCallId))
    const native = implementNativeOutcome(child, true, ids)
    return {
      structured,
      native,
      admission: {
        admitted: false,
        commits: [],
        paths: [],
        commands: [],
        remoteBranch: null,
        remoteTip: null,
        published: false,
        reason: error.message,
      },
    }
  }
}

async function publishInterruptedIntegration(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  opened: Extract<ActionReceiptPayload, { action: 'integrate'; phase: 'start' }>,
  origin: string,
) {
  const finalContext = await resolvePublication(input)
  if ('reason' in finalContext) return { published: false as const, reason: finalContext.reason }
  const recordId = randomUUID()
  const published = await publishRecord(
    context.loaded,
    finalContext.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'result',
        action: 'integrate',
        actionId: opened.actionId,
        mandate: opened.mandate,
        start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
        inputs: opened.inputs,
        exactInputs: opened.exactInputs,
        native: { completion: 'incomplete', strict: 'absent', raw: input.result.children[0]?.raw ?? null },
        structured: null,
        admission: null,
        diagnostics: [hostInterruptionDiagnostic(origin)],
      },
    },
    context.gh,
    input.cwd,
    finalContext.publicationParents,
  )
  return published.ok ? { published: true as const, recordId } : { published: false as const, reason: published.reason }
}

function integrationTerminalFailure(result: NativeBatchResult, stop: NativeStop | undefined) {
  if (result.children.some((child) => child.contextBlock !== undefined)) return null
  if (stop?.kind === 'invalid-terminal') return { reason: 'integration-output-invalid', strict: 'invalid' as const }
  if (stop?.kind === 'withheld')
    return {
      reason: 'action-uncertain',
      strict: result.children[0]?.usable ? ('valid' as const) : ('invalid' as const),
    }
  return null
}

/** Admit only actual, pinned child deliveries and host-observed integration effects. */
export async function publishIntegrationResult(
  input: IntegrationPublicationInput,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  const opened = context.opened
  if (opened.payload.action !== 'integrate' || opened.payload.inputs.manifest.purpose !== 'integrate')
    return { published: false, reason: 'integration-start-unconfirmed' }
  if (input.stop?.kind === 'interrupted')
    return publishInterruptedIntegration(input, context, opened.payload, input.stop.origin)
  const failure = integrationTerminalFailure(input.result, input.stop)
  if (failure !== null) return publishTerminalNegative(context, input.result, failure.reason, failure.strict)
  const selected = selectContribution(input.result, opened)
  if ('reason' in selected) return { published: false, reason: selected.reason }
  const evidence = await prepareIntegrationEvidence(input, context, selected.child)
  if ('reason' in evidence) {
    if (evidence.reason === 'integration-output-invalid' && selected.child.contextBlock === undefined)
      return publishTerminalNegative(context, input.result, evidence.reason, 'invalid')
    return { published: false, reason: evidence.reason }
  }
  const { native, structured, admission } = evidence
  const finalContext = await resolvePublication(input)
  if ('reason' in finalContext) return { published: false, reason: finalContext.reason }
  const recordId = randomUUID()
  const published = await publishRecord(
    context.loaded,
    context.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'result',
        action: 'integrate',
        actionId: opened.payload.actionId,
        mandate: opened.payload.mandate,
        start: { scope: context.receiptScope, recordId: opened.recordId, kind: 'action-receipt' },
        inputs: opened.payload.inputs,
        exactInputs: opened.payload.exactInputs,
        native,
        structured,
        admission,
        diagnostics:
          admission !== null && !admission.admitted ? [{ code: admission.reason, message: admission.reason }] : [],
      },
    },
    context.gh,
    input.cwd,
    context.publicationParents,
    input.result.canPublishContext,
  )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}
