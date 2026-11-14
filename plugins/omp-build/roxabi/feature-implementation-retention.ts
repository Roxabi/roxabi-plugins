import { randomUUID } from 'node:crypto'
import { hostInterruptionDiagnostic, implementationOutputSchema } from '../dist/contracts.js'
import type { CriterionDeclaration } from '../engine/criterion-evidence-schema.ts'
import type { ActionReceiptPayload, HostEffectAdmission } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import type { FeatureNativePublication } from './feature-contract.ts'
import { publishRecord } from './feature-engine.ts'
import { hostCompletedStructured, refusedImplementationPayload } from './feature-implementation-receipt.ts'
import { hasObservedNativeCapture, implementNativeOutcome } from './feature-native-outcome.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

export type ImplementationClaims = {
  ids: ReadonlySet<string>
  reason: string | null
  criteria: readonly CriterionDeclaration[]
  commands: readonly { toolCallId: string; command: string; exitCode: number }[]
}

export type RetainedCommit = { sha: string; paths?: readonly string[] }
export type PublishedImplementationAdmission = Pick<HostEffectAdmission, 'commits' | 'paths' | 'commands' | 'reason'>

export type RetainedCommand = { toolCallId: string; command: string; exitCode: number; cwd: string }

type ImplementationResultPayload = Extract<ActionReceiptPayload, { action: 'implement'; phase: 'result' }>

type RetainedResult = { retained: true } | { retained: false; reason: string }

export async function checkResultFence(binding: ImplementationResultBinding, cwd: string): Promise<string | null> {
  const scopes = [binding.receiptScope, ...binding.publicationParents.map((parent) => parent.source.scope)]
  const fresh = await binding.loaded.readComposedWorkflowHistory(
    scopes,
    withRoxabiGitHubPolicy({ cwd, gh: binding.gh }),
  )
  if (!fresh.ok || !fresh.histories[0]) return 'implementation-authority-unreadable'
  const start = { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' as const }
  const causal = await readFreshUwCausalContext(binding.mandate.scope, fresh.histories, { cwd, gh: binding.gh })
  if (!causal.ok) return 'implementation-authority-unreadable'
  const resolution = binding.loaded.startResolution(causal.value.histories, start)
  if (!resolution.ok) return 'interruption-resolution-invalid'
  if (resolution.value !== null) return 'action-start-resolved'
  if (
    fresh.histories[0].operations.some(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.phase === 'result' &&
        operation.record.payload.actionId === binding.start.payload.actionId,
    )
  )
    return 'action-result-present'
  return null
}

export function retainedRefusal(
  retained: RetainedResult,
  reason: string,
  confirmedRemote?: { branch: string; tip: string },
): Extract<FeatureNativePublication, { published: false }> {
  return retained.retained
    ? { published: false, retained: true, reason, ...(confirmedRemote === undefined ? {} : { confirmedRemote }) }
    : {
        published: false,
        retained: false,
        reason: retained.reason,
        ...(confirmedRemote === undefined ? {} : { confirmedRemote }),
      }
}

function retainedNativeOutcome(
  child: NonNullable<ImplementationResultBinding['child']>,
  stop: NativeStop | undefined,
  complete: boolean,
  ids: ReadonlySet<string>,
) {
  if (stop?.kind === 'interrupted')
    return {
      ...implementNativeOutcome(child, false, ids),
      completion: 'incomplete' as const,
      strict: 'absent' as const,
    }
  if (stop?.kind === 'invalid-terminal' && child.sdkTerminal === 'returned')
    return {
      ...implementNativeOutcome(child, false, ids),
      completion: 'completed' as const,
      strict: 'invalid' as const,
    }
  return implementNativeOutcome(child, complete, ids)
}

async function retainAbsentTerminal(
  binding: ImplementationResultBinding,
  input: { cwd: string; result: NativeBatchResult },
  stop: Extract<NativeStop, { kind: 'interrupted' | 'invalid-terminal' }>,
  reason: string,
): Promise<RetainedResult> {
  const published = await publishRecord(
    binding.loaded,
    binding.history,
    {
      repository: binding.receiptScope.repository,
      target: binding.receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'result',
        action: 'implement',
        actionId: input.result.batch.operationId,
        mandate: binding.mandate,
        start: { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' },
        inputs: binding.start.payload.inputs,
        exactInputs: binding.exactInputs,
        native: { completion: 'incomplete', strict: 'absent', raw: binding.child?.raw ?? null },
        structured: null,
        admission: {
          admitted: false,
          published: false,
          commits: [],
          paths: [],
          commands: [],
          remoteBranch: null,
          remoteTip: null,
          reason,
        },
        diagnostics:
          stop.kind === 'interrupted' ? [hostInterruptionDiagnostic(stop.origin)] : [{ code: reason, message: reason }],
      },
    },
    binding.gh,
    input.cwd,
    binding.publicationParents,
  )
  return published.ok ? { retained: true } : { retained: false, reason: published.reason }
}

export async function retainImplementationResult(
  binding: ImplementationResultBinding,
  input: { cwd: string; result: NativeBatchResult; stop?: NativeStop },
  claims: ImplementationClaims,
  reason: string,
  commits: readonly RetainedCommit[] = [],
  commands: readonly RetainedCommand[] = [],
  remote?: { branch: string; tip: string },
): Promise<RetainedResult> {
  const fence = await checkResultFence(binding, input.cwd)
  if (fence !== null) return { retained: false, reason: fence }
  if (
    (!binding.child || !hasObservedNativeCapture(binding.child)) &&
    (input.stop?.kind === 'interrupted' || input.stop?.kind === 'invalid-terminal')
  )
    return retainAbsentTerminal(binding, input, input.stop, reason)
  if (!binding.child || !hasObservedNativeCapture(binding.child))
    return { retained: false, reason: 'missing-contribution' }
  const refused = refusedImplementationPayload({
    child: binding.child,
    complete: input.result.complete,
    claimedIds: claims.ids,
    reason,
    commits,
    commands,
    structuredCommands: claims.commands,
    modelReason: claims.reason,
  })
  const completedClaim = input.result.complete
    ? implementationOutputSchema.safeParse(hostCompletedStructured(binding.child))
    : null
  const payload: ImplementationResultPayload = {
    format: 'omp-build-action-receipt/2',
    phase: 'result',
    action: 'implement',
    actionId: input.result.batch.operationId,
    mandate: binding.mandate,
    start: { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' },
    inputs: binding.start.payload.inputs,
    exactInputs: binding.exactInputs,
    native: retainedNativeOutcome(binding.child, input.stop, input.result.complete, claims.ids),
    admission: {
      ...refused.admission,
      commands: [...refused.admission.commands],
      ...(remote === undefined ? {} : { published: true, remoteBranch: remote.branch, remoteTip: remote.tip }),
    },
    structured:
      input.stop?.kind === 'invalid-terminal'
        ? null
        : completedClaim?.success
          ? completedClaim.data
          : { ...refused.structured, commands: [...refused.structured.commands], criteria: [...claims.criteria] },
    diagnostics:
      input.stop?.kind === 'interrupted' ? [hostInterruptionDiagnostic(input.stop.origin)] : [...refused.diagnostics],
  }
  const published = await publishRecord(
    binding.loaded,
    binding.history,
    {
      repository: binding.receiptScope.repository,
      target: binding.receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload,
    },
    binding.gh,
    input.cwd,
    binding.publicationParents,
  )
  return published.ok ? { retained: true } : { retained: false, reason: published.reason }
}
