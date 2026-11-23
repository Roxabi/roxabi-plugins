import { randomUUID } from 'node:crypto'
import { missingContextOutputSchema, specAssessmentSchema } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { publishInterruptedResult, publishTerminalNegative } from './feature-action-terminal-result.ts'
import { matchesContextNegative } from './feature-context-negative.ts'
import { publishRecord } from './feature-engine.ts'
import { nativeOutcome } from './feature-native-outcome.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
type AssessmentResultPayload = Extract<ActionReceiptPayload, { action: 'assess-spec'; phase: 'result' }>

async function publishClassificationPayload(
  context: NonImplementPublication,
  result: NativeBatchResult,
  payload: AssessmentResultPayload,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const recordId = randomUUID(),
    published = await publishRecord(
      context.loaded,
      context.history,
      {
        repository: context.receiptScope.repository,
        target: context.receiptScope.target,
        version: 1,
        recordId,
        runId: randomUUID(),
        operationId: `${result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload,
      },
      context.gh,
      context.cwd,
      context.publicationParents,
      result.canPublishContext,
    )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}

async function publishClassificationResult(
  context: NonImplementPublication,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const parsed = (child.contextBlock === undefined ? specAssessmentSchema : missingContextOutputSchema).safeParse(
    child.structured,
  )
  if (!parsed.success)
    return child.contextBlock === undefined
      ? publishTerminalNegative(context, result, 'assess-spec-output-invalid', 'invalid')
      : { published: false, reason: 'assess-spec-output-invalid' }
  return publishClassificationPayload(context, result, {
    format: 'omp-build-action-receipt/2',
    phase: 'result',
    inputs: context.opened.payload.inputs,
    action: 'assess-spec',
    actionId: result.batch.operationId,
    mandate: context.opened.payload.mandate,
    start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
    exactInputs: context.opened.payload.exactInputs,
    native: nativeOutcome(child, true),
    structured: parsed.data,
    admission: null,
    diagnostics: [],
  })
}

function invalidContextBinding(context: NonImplementPublication, result: NativeBatchResult): boolean {
  return result.children.some(
    (child) =>
      child.contextBlock !== undefined &&
      !matchesContextNegative(child, context.opened.payload.actionId, context.opened.payload.inputs),
  )
}

function unconfirmedAssessment(result: NativeBatchResult): boolean {
  const child = result.children[0]
  return (
    result.children.length !== 1 ||
    result.batch.tasks.tasks.length !== 1 ||
    child?.id === null ||
    child?.expectedId !== result.batch.tasks.tasks[0]?.name ||
    (!child?.usable && child?.contextBlock === undefined)
  )
}

function terminalFailure(result: NativeBatchResult, stop: NativeStop | undefined) {
  if (result.children.some((child) => child.contextBlock !== undefined)) return null
  if (stop?.kind === 'invalid-terminal') return { reason: 'assess-spec-output-invalid', strict: 'invalid' as const }
  if (stop?.kind === 'withheld')
    return {
      reason: 'action-uncertain',
      strict: result.children[0]?.usable ? ('valid' as const) : ('invalid' as const),
    }
  return null
}

export async function publishNonImplementResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  stop?: NativeStop
  gh?: Gh
}): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  if (
    input.result.children.some((child) => child.contextBlock !== undefined) &&
    input.result.canPublishContext?.() !== true
  )
    return { published: false, reason: 'publication-ownership-revoked' }
  if (input.stop?.kind === 'interrupted') return publishInterruptedResult(context, input.result, input.stop)
  const failure = terminalFailure(input.result, input.stop)
  if (failure !== null) return publishTerminalNegative(context, input.result, failure.reason, failure.strict)
  if (
    !input.result.complete &&
    input.stop?.kind !== 'completed-after-stop' &&
    !input.result.children.some((child) => child.contextBlock !== undefined)
  )
    return { published: false, reason: 'action-uncertain' }
  if (invalidContextBinding(context, input.result))
    return { published: false, reason: 'action-context-binding-mismatch' }
  const finalContext = await resolvePublication(input)
  if ('reason' in finalContext) return { published: false, reason: finalContext.reason }
  const child = input.result.children[0]
  if (child === undefined || unconfirmedAssessment(input.result))
    return { published: false, reason: 'assess-spec-native-child-unconfirmed' }
  return publishClassificationResult(finalContext, input.result, child)
}
