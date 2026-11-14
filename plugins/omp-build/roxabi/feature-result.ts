import type { Gh } from '../adapters/github/types.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { HostEffectAdmission } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import { publishNonImplementResult } from './feature-action-result.ts'
import type { FeatureNativePublication } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { disarmBranchBeforePush } from './feature-disarm.ts'
import { defaultGh } from './feature-engine.ts'
import { admitImplementationEvidence } from './feature-implementation-admission.ts'
import { implementationEffectAuthority } from './feature-implementation-authorization.ts'
import { publishImplementationNegative } from './feature-implementation-negative.ts'
import { publishAfterRemoteProof } from './feature-implementation-publication.ts'
import { claimedToolCallIds } from './feature-implementation-receipt.ts'
import {
  checkResultFence,
  type ImplementationClaims,
  type RetainedCommit,
  retainedRefusal,
  retainImplementationResult,
} from './feature-implementation-retention.ts'
import { publishIntegrationResult } from './feature-integration-result.ts'
import { proveAuthorizedBranch } from './feature-publication.ts'
import { bindImplementationResult, type ImplementationResultBinding } from './feature-result-binding.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { defaultGit } from './workflow-checkout.ts'

function implementationPrerequisites(
  complete: boolean,
  startHead: string | undefined,
  child: ImplementationResultBinding['child'],
): { startHead: string; child: NonNullable<ImplementationResultBinding['child']> } | { reason: string } {
  if (!complete) return { reason: 'action-uncertain' }
  if (startHead === undefined) return { reason: 'implementation-start-unobserved' }
  return child === undefined ? { reason: 'missing-contribution' } : { startHead, child }
}

function admissionPublication(admission: HostEffectAdmission): { ok: true } | { ok: false; reason: string } {
  if (!admission.admitted) return { ok: false, reason: admission.reason || 'implementation-unconfirmed' }
  if (admission.commits.length === 0) return { ok: false, reason: 'implementation-not-remote' }
  return { ok: true }
}

export type FeatureNativeResultInput = {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  stop?: NativeStop
  startHead?: string
  git?: GitRunner
  gh?: Gh
}

async function publishOtherActionResult(
  input: FeatureNativeResultInput,
  gh: Gh,
): Promise<FeatureNativePublication | null> {
  const integrate = input.result.batch.tasks.tasks.some((task) => task.action?.inputs.manifest.purpose === 'integrate')
  if (!integrate && input.result.batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')) return null
  const published = integrate
    ? await publishIntegrationResult({ ...input, gh, git: input.git ?? defaultGit() })
    : await publishNonImplementResult({ ...input, gh })
  return published.published
    ? {
        published: true,
        retained: true,
        receipt: { scope: input.start.scope, recordId: published.recordId, kind: 'action-receipt' },
      }
    : { published: false, retained: false, reason: published.reason }
}

function stoppedImplementationReason(stop: NativeStop | undefined): string | null {
  return stop?.kind === 'interrupted'
    ? 'action-interrupted'
    : stop?.kind === 'invalid-terminal'
      ? 'implementation-output-invalid'
      : null
}

async function retainRemoteRefusal(
  binding: ImplementationResultBinding,
  input: FeatureNativeResultInput,
  claims: ImplementationClaims,
  commits: readonly RetainedCommit[],
  commands: HostEffectAdmission['commands'],
  remote: { reason: string; confirmedRemote?: { branch: string; tip: string } },
): Promise<FeatureNativePublication> {
  const confirmedRemote = remote.confirmedRemote
  if (remote.reason === 'implementation-start-resolved')
    return {
      published: false,
      retained: false,
      reason: remote.reason,
      ...(confirmedRemote === undefined ? {} : { confirmedRemote }),
    }
  if (confirmedRemote === undefined) {
    const retained = await retainImplementationResult(binding, input, claims, remote.reason, commits, commands)
    return retainedRefusal(retained, remote.reason)
  }
  try {
    const retained = await retainImplementationResult(
      binding,
      input,
      claims,
      remote.reason,
      commits,
      commands,
      confirmedRemote,
    )
    return retainedRefusal(retained, remote.reason, confirmedRemote)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw Object.assign(
      new Error(`${message} (confirmed remote tip ${confirmedRemote.branch} ${confirmedRemote.tip})`, { cause: error }),
      { confirmedRemote },
    )
  }
}

export async function publishFeatureNativeResult(input: FeatureNativeResultInput): Promise<FeatureNativePublication> {
  if (input.stop?.kind === 'completed-after-stop') input = { ...input, result: { ...input.result, complete: true } }
  const gh = input.gh ?? defaultGh()
  const other = await publishOtherActionResult(input, gh)
  if (other !== null) return other
  const git = input.git ?? defaultGit()
  const binding = await bindImplementationResult({ ...input, gh })
  if ('reason' in binding) return { published: false, retained: false, reason: binding.reason }
  const initialFence = await checkResultFence(binding, input.cwd)
  if (initialFence !== null) return { published: false, retained: false, reason: initialFence }
  if (binding.child?.contextBlock !== undefined) return publishImplementationNegative(binding, input)
  const claims = claimedToolCallIds(binding.child)
  const stopReason = stoppedImplementationReason(input.stop)
  if (stopReason !== null) {
    const retained = await retainImplementationResult(binding, input, claims, stopReason)
    return retainedRefusal(retained, stopReason)
  }
  const prerequisites = implementationPrerequisites(input.result.complete, input.startHead, binding.child)
  if ('reason' in prerequisites) {
    const retained = await retainImplementationResult(binding, input, claims, prerequisites.reason)
    return retainedRefusal(retained, prerequisites.reason)
  }
  const histories = [binding.history, ...binding.publicationParents]
  const mandate = histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.status === 'complete' &&
        operation.record?.kind === 'mandate' &&
        operation.record.recordId === binding.mandate.recordId &&
        operation.record.repository === binding.mandate.scope.repository &&
        operation.record.target === binding.mandate.scope.target,
    )?.record
  if (mandate?.kind !== 'mandate')
    return { published: false, retained: false, reason: 'implementation-authority-unreadable' }
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
  const commits = admission.commits.map((sha, index) => ({ sha, paths: index === 0 ? admission.paths : [] }))
  const publication = admissionPublication(admission)
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
  const effect = () => implementationEffectAuthority(binding, input.cwd)
  const remote = await proveAuthorizedBranch(git, input.cwd, binding.branch, tip, {
    effect,
    beforePush: async () => {
      const before = await effect()
      if (!before.ok) return before
      if (!(await disarmBranchBeforePush(gh, input.cwd, binding.mandate.scope.repository, binding.branch)))
        return { ok: false, reason: 'implementation-disarm-unconfirmed' }
      return effect()
    },
  })
  if (!remote.ok) return retainRemoteRefusal(binding, input, claims, commits, admission.commands, remote)
  return publishAfterRemoteProof(binding, input, claims, commits, admission, prerequisites.child, {
    branch: binding.branch,
    tip: remote.remoteTip,
  })
}
