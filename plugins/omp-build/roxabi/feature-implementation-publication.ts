import { randomUUID } from 'node:crypto'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { FeatureNativePublication } from './feature-contract.ts'
import { publicationDidNotStart, publishRecord } from './feature-engine.ts'
import { implementationEffectAuthority } from './feature-implementation-authorization.ts'
import {
  checkResultFence,
  type ImplementationClaims,
  type PublishedImplementationAdmission,
  type RetainedCommit,
  retainedRefusal,
  retainImplementationResult,
} from './feature-implementation-retention.ts'
import { implementNativeOutcome } from './feature-native-outcome.ts'
import type { FeatureNativeResultInput } from './feature-result.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'

type ImplementationResultPayload = Extract<ActionReceiptPayload, { action: 'implement'; phase: 'result' }>

async function retainAfterRemote(
  binding: ImplementationResultBinding,
  input: FeatureNativeResultInput,
  claims: ImplementationClaims,
  reason: string,
  commits: readonly RetainedCommit[],
  commands: PublishedImplementationAdmission['commands'],
  confirmedRemote: { branch: string; tip: string },
): Promise<FeatureNativePublication> {
  const retained = await retainImplementationResult(binding, input, claims, reason, commits, commands, confirmedRemote)
  return retainedRefusal(retained, reason, confirmedRemote)
}

async function publishImplementedResult(
  binding: ImplementationResultBinding,
  input: FeatureNativeResultInput,
  claims: ImplementationClaims & { reason: string },
  admission: PublishedImplementationAdmission,
  commits: readonly RetainedCommit[],
  child: NonNullable<ImplementationResultBinding['child']>,
  confirmedRemote: { branch: string; tip: string },
): Promise<FeatureNativePublication> {
  const fence = await checkResultFence(binding, input.cwd)
  if (fence !== null)
    return {
      published: false,
      retained: false,
      reason: fence,
      confirmedRemote,
    }
  if (!input.current())
    return retainAfterRemote(
      binding,
      input,
      claims,
      'implementation-local-inhibition',
      commits,
      admission.commands,
      confirmedRemote,
    )
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
        native: implementNativeOutcome(child, true, claims.ids),
        admission: {
          admitted: true,
          commits: [...admission.commits],
          paths: [...admission.paths],
          commands: [...admission.commands],
          remoteBranch: binding.branch,
          remoteTip: confirmedRemote.tip,
          published: true,
          reason: admission.reason,
        },
        structured: {
          outcome: 'implemented',
          commitSHAs: [...admission.commits],
          commands: [...claims.commands],
          criteria: [...claims.criteria],
          reason: claims.reason,
        },
        diagnostics: [],
      } satisfies ImplementationResultPayload,
    },
    binding.gh,
    input.cwd,
    binding.publicationParents,
    input.current,
  )
  if (published.ok) return { published: true, retained: true }
  // Retain only on the writer's exact not-started ownership marker plus live revoke.
  // Do not infer no-write from ownership loss, fresh absence, or write-started revoke.
  // Fence recheck uses retention.ts decoded result-receipt presence / startResolution
  // (resolution-index + source.complete), not operation.status multipart inference.
  if (!(publicationDidNotStart(published) && !input.current()))
    return {
      published: false,
      retained: false,
      reason: published.reason,
      confirmedRemote,
    }
  const after = await checkResultFence(binding, input.cwd)
  if (after !== null)
    return {
      published: false,
      retained: false,
      reason: after,
      confirmedRemote,
    }
  return retainAfterRemote(
    binding,
    input,
    claims,
    'implementation-local-inhibition',
    commits,
    admission.commands,
    confirmedRemote,
  )
}

export async function publishAfterRemoteProof(
  binding: ImplementationResultBinding,
  input: FeatureNativeResultInput,
  claims: ImplementationClaims,
  commits: readonly RetainedCommit[],
  admission: PublishedImplementationAdmission,
  child: NonNullable<ImplementationResultBinding['child']>,
  confirmedRemote: { branch: string; tip: string },
): Promise<FeatureNativePublication> {
  try {
    const finalAuthority = await implementationEffectAuthority(binding, input.cwd, input.current)
    if (!finalAuthority.ok) {
      if (finalAuthority.reason === 'implementation-start-resolved')
        return { published: false, retained: false, reason: finalAuthority.reason, confirmedRemote }
      const retained = await retainImplementationResult(
        binding,
        input,
        claims,
        finalAuthority.reason,
        commits,
        admission.commands,
        confirmedRemote,
      )
      return retainedRefusal(retained, finalAuthority.reason, confirmedRemote)
    }
    const reason = claims.reason
    if (reason === null) {
      const retained = await retainImplementationResult(
        binding,
        input,
        claims,
        'implementation-claim-missing',
        commits,
        admission.commands,
        confirmedRemote,
      )
      return retainedRefusal(retained, 'implementation-claim-missing', confirmedRemote)
    }
    return await publishImplementedResult(
      binding,
      input,
      { ...claims, reason },
      admission,
      commits,
      child,
      confirmedRemote,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} (confirmed remote tip ${confirmedRemote.branch} ${confirmedRemote.tip})`, {
      cause: error,
    })
  }
}
