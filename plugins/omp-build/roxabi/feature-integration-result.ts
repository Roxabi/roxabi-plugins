import { randomUUID } from 'node:crypto'
import { canonicalValueDigest, integrationOutputSchema, missingContextOutputSchema } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { IntegrationOutput } from '../engine/uw-integration-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { matchesContextNegative } from './feature-context-negative.ts'
import { publishRecord } from './feature-engine.ts'
import { bindClaimedCommands, conservedDeclarations } from './feature-implementation-admission.ts'
import { hostCompletedStructured } from './feature-implementation-receipt.ts'
import { integrationAuthority } from './feature-integration-authority.ts'
import { integrationLineage } from './feature-integration-lineage.ts'
import { IntegrationRefusal, observeIntegration, refuse } from './feature-integration-observation.ts'
import { implementNativeOutcome, nativeOutcome } from './feature-native-outcome.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { proveAuthorizedPublishedBase } from './feature-publication.ts'
import { type GitRunner, verifyParentCheckout } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

function integrationMandate(context: NonImplementPublication) {
  const mandateRef = context.opened.payload.mandate
  if (!('recordId' in mandateRef)) refuse('integration-mandate-unbound')
  const mandate = context.history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === mandateRef.recordId,
  )?.record
  if (mandate?.kind !== 'mandate' || mandate.payload.branch !== null) refuse('integration-parent-branch-bound')
  return { mandateRef, mandate }
}

function integrationCommands(structured: IntegrationOutput, child: NativeBatchResult['children'][number], cwd: string) {
  const commands = bindClaimedCommands(structured, child.bashCalls ?? [], cwd)
  if (!commands.ok || !conservedDeclarations(structured, child.commandRuns ?? []))
    refuse('integration-evidence-unconserved')
  return commands.commands
}

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

type IntegrationPublicationInput = {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh: Gh
  git: GitRunner
}

type IntegrationAdmission = {
  admitted: boolean
  commits: string[]
  paths: string[]
  commands: { toolCallId: string; command: string; exitCode: number; cwd: string }[]
  remoteBranch: string | null
  remoteTip: string | null
  published: boolean
  reason: string
}

async function admitIntegration(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  child: NativeBatchResult['children'][number],
  structured: IntegrationOutput,
) {
  const { manifest, uw, read, accepted, childCommits } = await observeIntegration(input, context.opened, structured)
  const { mandateRef, mandate } = integrationMandate(context)
  const anchor = await resolveParentWorktreeAnchor({ subject: uw, read })
  if (!anchor.ok) refuse(anchor.reason)
  const checkout = await verifyParentCheckout({ git: input.git, cwd: input.cwd, uw: anchor.anchor })
  if (!checkout.ok) refuse(checkout.reason)
  const lineage = await integrationLineage({
    git: input.git,
    cwd: input.cwd,
    base: mandate.payload.base,
    expectedBase: structured.code.base,
    initialHead: manifest.code.head,
    head: structured.code.head,
    target: uw.target,
    childCommits,
  })
  if (!lineage.ok) refuse(lineage.reason)
  const commands = integrationCommands(structured, child, input.cwd)
  const authorized = integrationAuthority(input, context, mandateRef, uw, read, accepted)
  const publication = await proveAuthorizedPublishedBase(
    input.git,
    input.cwd,
    input.gh,
    uw.repository,
    mandate.payload.base,
    structured.code.head,
    authorized,
  )
  if (!publication.ok) refuse(publication.reason)
  return {
    admitted: true,
    commits: lineage.commits,
    paths: lineage.paths,
    commands,
    remoteBranch: null,
    remoteTip: publication.remoteTip,
    published: true,
    reason: structured.reason,
  }
}

async function prepareIntegrationEvidence(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  child: NativeBatchResult['children'][number],
): Promise<
  | { reason: string }
  | {
      structured: ReturnType<typeof integrationOutputSchema.parse> | ReturnType<typeof missingContextOutputSchema.parse>
      native: ReturnType<typeof nativeOutcome>
      admission: IntegrationAdmission | null
    }
> {
  const opened = context.opened
  if (child.contextBlock !== undefined) {
    if (
      input.result.canPublishContext?.() !== true ||
      !matchesContextNegative(child, opened.payload.actionId, opened.payload.inputs)
    )
      return { reason: 'integration-context-binding-mismatch' }
    const negative = missingContextOutputSchema.safeParse(child.structured)
    if (!negative.success) return { reason: 'integration-output-invalid' }
    return { structured: negative.data, native: nativeOutcome(child, true), admission: null }
  }
  if (!input.result.complete || !child.usable) return { reason: 'action-uncertain' }
  const parsed = integrationOutputSchema.safeParse(hostCompletedStructured(child))
  if (!parsed.success) return { reason: 'integration-output-invalid' }
  const structured = parsed.data
  try {
    const admission = await admitIntegration(input, context, child, structured)
    const ids = new Set(structured.commands.map((command) => command.toolCallId))
    return { structured, native: implementNativeOutcome(child, true, ids), admission }
  } catch (error) {
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

/** Admit only actual, pinned child deliveries and host-observed integration effects. */
export async function publishIntegrationResult(
  input: IntegrationPublicationInput,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  const opened = context.opened
  if (opened.payload.action !== 'integrate' || opened.payload.inputs.manifest.purpose !== 'integrate')
    return { published: false, reason: 'integration-start-unconfirmed' }
  const selected = selectContribution(input.result, opened)
  if ('reason' in selected) return { published: false, reason: selected.reason }
  const evidence = await prepareIntegrationEvidence(input, context, selected.child)
  if ('reason' in evidence) return { published: false, reason: evidence.reason }
  const { native, structured, admission } = evidence
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
