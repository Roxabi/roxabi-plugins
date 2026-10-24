import { realpathSync } from 'node:fs'

import type { ActionResult } from '../dist/contracts.js'
import {
  actionOutput,
  actionTask,
  causePaths,
  correctionActionContext,
  failed,
  jsonEvidence,
  nativeActionRaw,
  type ObservedProof,
  observedProof,
  taskName,
} from './correction-action'
import type {
  CorrectionApplyResult,
  CorrectionEffectResult,
  CorrectionRevalidationResult,
} from './correction-execution-contract'
import type { CorrectionNativeRuntime } from './correction-native-runtime'
import type { CorrectionCause } from './fix-domain'
import { nativeFixProfileByAction } from './native-review-profiles'

async function failedApplyResult(
  runtime: CorrectionNativeRuntime,
  output: ActionResult,
): Promise<CorrectionEffectResult<never>> {
  const unchanged = await runtime.git.expectedCleanHead()
  if (!unchanged.ok || !('outcome' in output) || output.commitSHAs.length !== 0)
    return failed('terminal', 'native-failed-action-state-unsafe')
  return failed('retryable', 'native-apply-reported-failed')
}

async function revertUnprovenCommit(
  runtime: CorrectionNativeRuntime,
  commit: string,
  proof: CorrectionEffectResult<ObservedProof | null>,
): Promise<CorrectionEffectResult<CorrectionApplyResult>> {
  const fence = runtime.abortFence<CorrectionApplyResult>()
  if (fence) return fence
  try {
    await runtime.git.run(['revert', '--no-edit', commit])
    const reverted = await runtime.git.cleanHead()
    if (!reverted.ok || reverted.value.head === commit)
      return failed(
        'terminal',
        proof.ok
          ? 'native-apply-proof-failed-and-revert-unverified'
          : 'native-apply-proof-unavailable-and-revert-unverified',
      )
    runtime.ownedCommits.pop()
    runtime.setExpectedHead(reverted.value.head)
    return proof.ok ? failed('terminal', 'native-apply-proof-failed') : failed('terminal', ...proof.diagnostics)
  } catch (error) {
    const reason = proof.ok
      ? 'native-apply-proof-failed-and-revert-failed'
      : 'native-apply-proof-unavailable-and-revert-failed'
    return failed('terminal', `${reason}:${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function applyCorrectionAction(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  attempt: 1 | 2 | 3,
): Promise<CorrectionEffectResult<CorrectionApplyResult>> {
  const expectedHead = runtime.expectedHead()
  if (expectedHead === null) return failed('terminal', 'publish-head-unavailable')
  const publish = await runtime.git.validatePublishBinding(expectedHead)
  if (!publish.ok) return publish
  const state = await runtime.git.expectedCleanHead()
  if (!state.ok) return state
  const paths = causePaths(cause.paths)
  if (paths === null) return failed('terminal', 'correction-paths-invalid')
  const causeJSON = JSON.stringify(cause)
  const task = actionTask(
    taskName('apply', cause.id, `-${attempt}`),
    nativeFixProfileByAction.apply,
    `Apply only confirmed correction cause ${cause.id} in ${runtime.options.prepared.cwd}. Cause: ${causeJSON}. Edit only declared correction paths plus explicit repository-local proof implementation paths. Retain the existing same-class sweep boundary, create exactly one owned correction commit, and do not push. Run only repository-native checks required by the cause; return factual command outputs, every production guard, explicit proofPaths for any proof implementation files changed (empty for existing/no-test), and the selected actual top-level proof tool-call reference.`,
    `one bounded correction cause ${cause.id}`,
    { purpose: 'fix-apply', causeId: cause.id, occurrence: 'apply' },
  )
  const result = await runtime.dispatch({
    phase: 'apply',
    causeId: cause.id,
    task,
    contextRefs: [runtime.options.decisionId],
    context: correctionActionContext(causeJSON, [], null),
  })
  if (!result.ok) return result
  const interpreted = actionOutput(result.value)
  if (!interpreted.ok) return interpreted
  const { output, child } = interpreted.value
  if (!('outcome' in output) || output.outcome === 'failed') return failedApplyResult(runtime, output)
  if (output.commitSHAs.length !== 1 || !/^[0-9a-f]{40}$/.test(output.commitSHAs[0] ?? ''))
    return failed('terminal', 'native-apply-commit-invalid')
  const commit = output.commitSHAs[0] as string
  const verified = await runtime.git.verifyOwnedCommit(commit, state.value.head, paths, output.proofPaths)
  if (!verified.ok) return verified
  runtime.ownedCommits.push(commit)
  runtime.setExpectedHead(commit)
  const proof = observedProof(
    child,
    { purpose: 'fix-apply', causeId: cause.id, occurrence: 'apply', guardId: null },
    output.proofToolCallId,
    output.proofUnavailableReason,
    runtime.options.prepared.cwd,
    realpathSync,
  )
  if (!proof.ok || (proof.value !== null && proof.value.exitCode !== 0))
    return revertUnprovenCommit(runtime, commit, proof)
  runtime.appliedByCause.set(cause.id, {
    causeJSON,
    guards: output.guardInventory,
    proofPaths: [...output.proofPaths],
    proof: proof.value,
    proofUnavailableReason: output.proofUnavailableReason,
    contributionIds: [...result.value.contributionIds],
  })
  return {
    ok: true,
    value: {
      commitSHAs: [commit],
      contributionIds: [...result.value.contributionIds],
      raw: nativeActionRaw(cause.id, result.value, child, verified.value, proof.value),
    },
  }
}

async function revalidateCause(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  checked: CorrectionRevalidationResult['checked'],
  contributionIds: string[],
): Promise<CorrectionEffectResult<void>> {
  const state = await runtime.git.expectedCleanHead()
  if (!state.ok) return state
  const applied = runtime.appliedByCause.get(cause.id)
  if (applied === undefined) return failed('terminal', `required-cause-not-applied:${cause.id}`)
  if (applied.proof === null) {
    checked.push({ causeId: cause.id, skippedReason: applied.proofUnavailableReason, selectedApplyProof: null })
    return { ok: true, value: undefined }
  }
  const task = actionTask(
    taskName('revalidate', cause.id),
    nativeFixProfileByAction.apply,
    `Revalidate the confirmed required correction cause ${cause.id} in ${runtime.options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. Reuse this semantic proof identity only; the actual selected apply proof evidence was ${JSON.stringify(applied.proof)} and its declared proofPaths were ${JSON.stringify(applied.proofPaths)}. Do not edit, commit, push, or alter files. Return actual command results with no commits, empty proofPaths, and an empty guard inventory.`,
    `required correction proof revalidation for ${cause.id}`,
    { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'apply' },
  )
  const result = await runtime.dispatch({
    phase: 'revalidate',
    causeId: cause.id,
    task,
    contextRefs: [runtime.options.decisionId, ...applied.contributionIds],
    context: correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof),
  })
  if (!result.ok) return result
  const interpreted = actionOutput(result.value)
  if (!interpreted.ok) return interpreted
  const { output, child } = interpreted.value
  if (
    !('outcome' in output) ||
    output.outcome !== 'applied' ||
    output.commitSHAs.length !== 0 ||
    output.guardInventory.length !== 0
  )
    return failed('terminal', 'required-path-revalidation-invalid')
  const proof = observedProof(
    child,
    { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'apply', guardId: null },
    output.proofToolCallId,
    output.proofUnavailableReason,
    runtime.options.prepared.cwd,
    realpathSync,
  )
  if (!proof.ok || proof.value === null || proof.value.exitCode !== 0)
    return failed('terminal', 'required-path-revalidation-proof-invalid')
  const after = await runtime.git.expectedCleanHead()
  if (!after.ok || after.value.head !== state.value.head)
    return failed('terminal', 'required-path-revalidation-state-changed')
  contributionIds.push(...result.value.contributionIds)
  checked.push({
    causeId: cause.id,
    contributionIds: result.value.contributionIds,
    batch: result.value.native.raw,
    output,
    proofEvidence: jsonEvidence(child.proofEvidence),
    proof: proof.value,
  })
  return { ok: true, value: undefined }
}

export async function revalidateRequiredCorrectionPaths(
  runtime: CorrectionNativeRuntime,
  causes: readonly CorrectionCause[],
): Promise<CorrectionEffectResult<CorrectionRevalidationResult>> {
  const checked = [] as CorrectionRevalidationResult['checked']
  const contributionIds: string[] = []
  for (const cause of causes) {
    const revalidated = await revalidateCause(runtime, cause, checked, contributionIds)
    if (!revalidated.ok) return revalidated
  }
  return { ok: true, value: { checked, contributionIds } }
}
