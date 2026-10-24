import type { Json } from '../dist/contracts.js'
import type { AppliedCauseContext } from './correction-action'
import { failed } from './correction-action'
import type {
  CorrectionEffectResult,
  CorrectionExecution,
  CorrectionPushResult,
  CorrectionRevertResult,
  NativeCorrectionExecutionOptions,
} from './correction-execution-contract'
import { createCorrectionGitState, remoteRefSHA } from './correction-git-state'
import { applyCorrectionAction, revalidateRequiredCorrectionPaths } from './correction-native-apply'
import { dispatchCorrectionAction } from './correction-native-dispatch'
import { falsifyCorrectionAction } from './correction-native-falsify'
import { type CorrectionNativeRuntime, correctionAbortFence } from './correction-native-runtime'

async function revertOwnedCorrection(
  runtime: CorrectionNativeRuntime,
  commitSHAs: readonly string[],
): Promise<CorrectionEffectResult<CorrectionRevertResult>> {
  const fence = runtime.abortFence<{ reverted: string[]; revertSHA: string; contributionIds: string[] }>()
  if (fence) return fence
  const expectedHead = runtime.expectedHead()
  if (commitSHAs.length !== 1 || commitSHAs[0] !== expectedHead || runtime.ownedCommits.at(-1) !== commitSHAs[0])
    return failed('terminal', 'git-revert-unowned-commit')
  const before = await runtime.git.expectedCleanHead()
  if (!before.ok) return before
  try {
    await runtime.git.run(['revert', '--no-edit', commitSHAs[0] as string])
    const after = await runtime.git.cleanHead()
    if (!after.ok || after.value.head === before.value.head || !/^[0-9a-f]{40}$/.test(after.value.head))
      return failed('terminal', 'git-revert-state-unverified')
    runtime.ownedCommits.pop()
    runtime.setExpectedHead(after.value.head)
    return { ok: true, value: { reverted: [...commitSHAs], revertSHA: after.value.head, contributionIds: [] } }
  } catch (error) {
    return failed('terminal', `git-revert-failed:${error instanceof Error ? error.message : String(error)}`)
  }
}

type PushAttempt =
  | { kind: 'retry'; raw: Json }
  | { kind: 'terminal'; result: CorrectionEffectResult<CorrectionPushResult> }
  | { kind: 'pushed'; head: string; raw: Json }

async function pushAttempt(
  runtime: CorrectionNativeRuntime,
  pushUrl: string,
  destinationRef: string,
  expectedHead: string,
  attempt: number,
): Promise<PushAttempt> {
  const fence = runtime.abortFence<{ head: string; raw: Json; contributionIds: string[] }>()
  if (fence) return { kind: 'terminal', result: fence }
  const authorized = await runtime.options.authorizeContinuation?.()
  if (authorized !== undefined && !authorized.ok)
    return { kind: 'terminal', result: failed('terminal', ...authorized.diagnostics) }
  const stillFenced = runtime.abortFence<{ head: string; raw: Json; contributionIds: string[] }>()
  if (stillFenced) return { kind: 'terminal', result: stillFenced }
  try {
    const output = await runtime.git.run(['push', '--no-follow-tags', pushUrl, `${expectedHead}:${destinationRef}`])
    const [after, remote] = await Promise.all([
      runtime.git.expectedCleanHead(),
      runtime.git.run(['ls-remote', '--refs', pushUrl, destinationRef]),
    ])
    const remoteSHA = remoteRefSHA(remote.stdout, destinationRef)
    const raw = { attempt, output, remoteSHA: remoteSHA ?? null }
    if (!after.ok || after.value.head !== expectedHead || remoteSHA !== expectedHead)
      return { kind: 'terminal', result: failed('terminal', 'git-push-destination-unverified') }
    return { kind: 'pushed', head: after.value.head, raw }
  } catch (error) {
    return { kind: 'retry', raw: { attempt, error: error instanceof Error ? error.message : String(error) } }
  }
}

async function pushCurrentHead(
  runtime: CorrectionNativeRuntime,
): Promise<CorrectionEffectResult<CorrectionPushResult>> {
  const expectedHead = runtime.expectedHead()
  if (expectedHead === null) return failed('terminal', 'publish-head-unavailable')
  const binding = await runtime.git.validatePublishBinding(expectedHead)
  if (!binding.ok) return binding
  const before = await runtime.git.expectedCleanHead()
  if (!before.ok) return before
  const attempts: Json[] = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await pushAttempt(
      runtime,
      binding.value.pushUrl,
      binding.value.destinationRef,
      before.value.head,
      attempt,
    )
    if (result.kind === 'terminal') return result.result
    attempts.push(result.raw)
    if (result.kind === 'pushed') {
      return {
        ok: true,
        value: {
          head: result.head,
          contributionIds: [],
          raw: { attempts, destinationRef: binding.value.destinationRef },
        },
      }
    }
  }
  return failed('terminal', `git-push-failed:${JSON.stringify(attempts)}`)
}

/** Executes fixed Git observations/effects; native tasks perform repository proofs and perturbation. */
export function createNativeCorrectionExecution(options: NativeCorrectionExecutionOptions): CorrectionExecution {
  let expectedHead = options.prepared.target.candidateGitSHA
  const appliedByCause = new Map<string, AppliedCauseContext>()
  const ownedCommits: string[] = []
  const git = createCorrectionGitState(options, () => expectedHead)
  const runtime: CorrectionNativeRuntime = {
    options,
    git,
    expectedHead: () => expectedHead,
    setExpectedHead: (head) => {
      expectedHead = head
    },
    ownedCommits,
    appliedByCause,
    abortFence: () => correctionAbortFence(options.signal),
    dispatch: (binding) => dispatchCorrectionAction(options, binding),
  }
  return {
    apply: (cause, attempt) => applyCorrectionAction(runtime, cause, attempt),
    revalidateRequiredPaths: (causes) => revalidateRequiredCorrectionPaths(runtime, causes),
    falsify: (cause, commits) => falsifyCorrectionAction(runtime, cause, commits),
    revert: (commitSHAs) => revertOwnedCorrection(runtime, commitSHAs),
    async head() {
      const state = await git.expectedCleanHead()
      return state.ok ? { ok: true, value: state.value.head } : state
    },
    push: () => pushCurrentHead(runtime),
  }
}
