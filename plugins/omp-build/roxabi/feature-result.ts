import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload, HostEffectAdmission } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { publishNonImplementResult } from './feature-action-result.ts'
import { explicitParentHistories } from './feature-context.ts'
import type { FeatureNativePublication } from './feature-contract.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { publishRecord } from './feature-engine.ts'
import { admitImplementationEvidence } from './feature-implementation-admission.ts'
import { claimedToolCallIds, refusedImplementationPayload } from './feature-implementation-receipt.ts'
import { hasObservedNativeCapture, implementNativeOutcome } from './feature-native-outcome.ts'
import { proveAuthorizedBranch } from './feature-publication.ts'
import { bindImplementationResult, type ImplementationResultBinding } from './feature-result-binding.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { defaultGit } from './workflow-checkout.ts'

const execFileAsync = promisify(execFile)

function defaultGh(): Gh {
  return async (cwd, args) => {
    const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return out.stdout
  }
}

type ImplementationClaims = {
  ids: ReadonlySet<string>
  reason: string | null
  proofToolCallId: string | null
  commands: readonly { toolCallId: string; command: string; exitCode: number }[]
}

type RetainedCommit = { sha: string; paths?: readonly string[] }
type PublishedImplementationAdmission = Pick<HostEffectAdmission, 'commits' | 'paths' | 'commands' | 'reason'>

type RetainedCommand = { toolCallId: string; command: string; exitCode: number; cwd: string }

type ImplementationResultPayload = Extract<ActionReceiptPayload, { action: 'implement'; phase: 'result' }>

type RetainedResult = { retained: true } | { retained: false; reason: string }

function retainedRefusal(
  retained: RetainedResult,
  reason: string,
): Extract<FeatureNativePublication, { published: false }> {
  return retained.retained
    ? { published: false, retained: true, reason }
    : { published: false, retained: false, reason }
}

function implementationPrerequisites(
  complete: boolean,
  startHead: string | undefined,
  child: ImplementationResultBinding['child'],
): { startHead: string; child: NonNullable<ImplementationResultBinding['child']> } | { reason: string } {
  if (!complete) return { reason: 'action-uncertain' }
  if (startHead === undefined) return { reason: 'implementation-start-unobserved' }
  return child === undefined ? { reason: 'missing-contribution' } : { startHead, child }
}

function admissionPublication(
  admission: HostEffectAdmission,
  proofToolCallId: string | null,
): { ok: true; proofToolCallId: string } | { ok: false; reason: string } {
  if (!admission.admitted) return { ok: false, reason: admission.reason || 'implementation-unconfirmed' }
  if (admission.commits.length === 0) return { ok: false, reason: 'implementation-not-remote' }
  return proofToolCallId === null
    ? { ok: false, reason: 'implementation-proof-unobserved' }
    : { ok: true, proofToolCallId }
}
async function retainImplementationResult(
  binding: ImplementationResultBinding,
  input: { cwd: string; result: NativeBatchResult },
  claims: ImplementationClaims,
  reason: string,
  commits: readonly RetainedCommit[] = [],
  commands: readonly RetainedCommand[] = [],
): Promise<RetainedResult> {
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
  const payload: ImplementationResultPayload = {
    phase: 'result',
    action: 'implement',
    actionId: input.result.batch.operationId,
    mandate: binding.mandate,
    start: { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' },
    exactInputs: binding.exactInputs,
    native: implementNativeOutcome(binding.child, input.result.complete, claims.ids),
    admission: { ...refused.admission, commands: [...refused.admission.commands] },
    structured: { ...refused.structured, commands: [...refused.structured.commands] },
    diagnostics: [...refused.diagnostics],
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

async function authorizedImplementationPush(binding: ImplementationResultBinding, cwd: string): Promise<boolean> {
  if (cwdInhibition(cwd) !== undefined || inhibition(binding.mandate.scope) !== undefined) return false
  const fresh = await binding.loaded.readComposedWorkflowHistory([binding.mandate.scope], { cwd, gh: binding.gh })
  if (!fresh.ok || !fresh.histories[0]) return false
  const freshMandate =
    fresh.histories[0].operations.find(
      (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === binding.mandate.recordId,
    )?.record ?? null
  if (freshMandate === null) return false
  const freshParents = await explicitParentHistories(binding.loaded, freshMandate, { cwd, gh: binding.gh })
  if (!freshParents.ok) return false
  const current = binding.loaded.selectApplicableMandate(fresh.histories[0], freshParents.parents)
  return (
    cwdInhibition(cwd) === undefined &&
    inhibition(binding.mandate.scope) === undefined &&
    current.status === 'applicable' &&
    current.mandate?.recordId === binding.mandate.recordId
  )
}

async function publishImplementedResult(
  binding: ImplementationResultBinding,
  input: { cwd: string; result: NativeBatchResult },
  claims: ImplementationClaims & { reason: string },
  admission: PublishedImplementationAdmission,
  proofToolCallId: string,
  remoteTip: string,
  child: NonNullable<ImplementationResultBinding['child']>,
): Promise<FeatureNativePublication> {
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
        phase: 'result',
        action: 'implement',
        actionId: input.result.batch.operationId,
        mandate: binding.mandate,
        start: { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' },
        exactInputs: binding.exactInputs,
        native: implementNativeOutcome(child, true, claims.ids),
        admission: {
          admitted: true,
          commits: [...admission.commits],
          paths: [...admission.paths],
          commands: [...admission.commands],
          remoteBranch: binding.branch,
          remoteTip,
          published: true,
          reason: admission.reason,
        },
        structured: {
          outcome: 'implemented',
          commitSHAs: [...admission.commits],
          commands: [...claims.commands],
          proofToolCallId,
          proofUnavailableReason: null,
          reason: claims.reason,
        },
        diagnostics: [],
      } satisfies ImplementationResultPayload,
    },
    binding.gh,
    input.cwd,
    binding.publicationParents,
  )
  return published.ok
    ? { published: true, retained: true }
    : { published: false, retained: false, reason: published.reason }
}

export async function publishFeatureNativeResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  startHead?: string
  git?: GitRunner
  gh?: Gh
}): Promise<FeatureNativePublication> {
  const gh = input.gh ?? defaultGh()
  const implement = input.result.batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')
  if (!implement) {
    const published = await publishNonImplementResult({ ...input, gh })
    return published.published
      ? { published: true, retained: true }
      : { published: false, retained: false, reason: published.reason }
  }
  const git = input.git ?? defaultGit()
  const binding = await bindImplementationResult({ ...input, gh })
  if ('reason' in binding) return { published: false, retained: false, reason: binding.reason }
  const claims = claimedToolCallIds(binding.child)
  const prerequisites = implementationPrerequisites(input.result.complete, input.startHead, binding.child)
  if ('reason' in prerequisites) {
    const retained = await retainImplementationResult(binding, input, claims, prerequisites.reason)
    return retainedRefusal(retained, prerequisites.reason)
  }
  const admission = await admitImplementationEvidence({
    cwd: input.cwd,
    startHead: prerequisites.startHead,
    ticket: scopeNumber(binding.mandate.scope),
    children: input.result.children,
    git: async (args, cwd) => {
      const shown = await git(cwd, [...args])
      return { stdout: shown.stdout, exitCode: shown.code }
    },
  })
  const commits = admission.commits.map((sha) => ({ sha }))
  const publication = admissionPublication(admission, claims.proofToolCallId)
  if (!publication.ok) {
    const retained = await retainImplementationResult(
      binding,
      input,
      claims,
      publication.reason,
      commits,
      admission.commands,
    )
    return retainedRefusal(retained, publication.reason)
  }
  const tip = admission.commits.at(-1)
  if (tip === undefined) {
    const retained = await retainImplementationResult(
      binding,
      input,
      claims,
      'implementation-not-remote',
      commits,
      admission.commands,
    )
    return retainedRefusal(retained, 'implementation-not-remote')
  }
  const remote = await proveAuthorizedBranch(git, input.cwd, binding.branch, tip, () =>
    authorizedImplementationPush(binding, input.cwd),
  )
  if (!remote.ok) {
    const retained = await retainImplementationResult(
      binding,
      input,
      claims,
      remote.reason,
      commits,
      admission.commands,
    )
    return retainedRefusal(retained, remote.reason)
  }
  const reason = claims.reason
  if (reason === null || claims.commands.length === 0) {
    const refusal = reason === null ? 'implementation-claim-missing' : 'implementation-command-unidentified'
    const retained = await retainImplementationResult(binding, input, claims, refusal, commits, admission.commands)
    return retainedRefusal(retained, refusal)
  }
  return publishImplementedResult(
    binding,
    input,
    { ...claims, reason },
    admission,
    publication.proofToolCallId,
    remote.remoteTip,
    prerequisites.child,
  )
}
