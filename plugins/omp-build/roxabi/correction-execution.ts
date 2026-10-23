import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'

import { type ActionResult, actionResultSchema, type Json } from '../dist/contracts.js'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchController,
  NativeBatchResult,
  NativeChildResult,
  NativeProofDirective,
  NativeTask,
} from '../omp/review-runtime'
import type { PreparedFix, PublishBinding } from './fix'
import type { CorrectionCause } from './fix-domain'
import { nativeFixProfileByAction } from './native-review-profiles'

const execFileAsync = promisify(execFile)

type EffectFailureKind = 'retryable' | 'terminal'
export type CorrectionEffectResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      kind: EffectFailureKind
      diagnostics: string[]
      /** Authority denied before an action inventory, native dispatch, or repository effect. */
      preEffectRefusal?: readonly string[]
    }

export type FalsificationFact = {
  guardId: string
  guard: string
  intendedScenario: string
  removedProductionGuard: boolean
  proofFailedIntendedScenario: boolean
  proofToolCallId: string | null
  proofUnavailableReason: string | null
  inconclusive?: boolean
  detail?: string
}

export type CorrectionExecution = {
  apply(
    cause: CorrectionCause,
    attempt: 1 | 2 | 3,
  ): Promise<CorrectionEffectResult<{ commitSHAs: string[]; raw: Json; contributionIds: string[] }>>
  revert(
    commitSHAs: readonly string[],
  ): Promise<CorrectionEffectResult<{ reverted: string[]; revertSHA: string; contributionIds: string[] }>>
  revalidateRequiredPaths(
    causes: readonly CorrectionCause[],
  ): Promise<CorrectionEffectResult<{ checked: Json[]; contributionIds: string[] }>>
  falsify(
    cause: CorrectionCause,
    commitSHAs: readonly string[],
  ): Promise<
    CorrectionEffectResult<{ facts: FalsificationFact[]; raw: Json; contributionIds: string[]; skippedReason?: string }>
  >
  head(): Promise<CorrectionEffectResult<string>>
  push(): Promise<CorrectionEffectResult<{ head: string; raw: Json; contributionIds: string[] }>>
}

export type NativeCorrectionPort = Pick<NativeBatchController, 'activate' | 'active' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
}

export type BoundCorrectionAction = {
  /** The action inventory is already published and bound when this batch is returned. */
  batch: NativeBatch
  /** Persists every known and unknown child before any executor interpretation. */
  conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
}

export type CorrectionActionBinding = {
  phase: 'apply' | 'falsify' | 'restore-proof' | 'revalidate'
  causeId: string
  task: NativeTask
  /** Exact persisted record references; later actions append confirmed native contribution IDs. */
  contextRefs: readonly string[]
  /** Transient immutable semantic view included in the native task; durable links are contextRefs. */
  context: Json
}

export type NativeCorrectionExecutionOptions = {
  native: NativeCorrectionPort
  prepared: Pick<PreparedFix, 'cwd' | 'target' | 'publishBinding'>
  operationId: string
  /** Re-check the already bound authority before any correction action or push. */
  authorizeContinuation?(): Promise<{ ok: true; value: undefined } | { ok: false; diagnostics: string[] }>
  decisionId: string
  signal: AbortSignal
  /** Creates and confirms one action-specific inventory before dispatch. */
  bindAction(input: CorrectionActionBinding): Promise<CorrectionEffectResult<BoundCorrectionAction>>
  /** FixRun records the first review-bound action only after its exact batch is armed. */
  onStarted(batch: NativeBatch, binding: CorrectionActionBinding): Promise<CorrectionEffectResult<void>>
}

type Guard = Extract<ActionResult, { outcome: 'applied' }>['guardInventory'][number]
type ObservedProof = { toolCallId: string; input: Json; result: Json; exitCode: number }

type AppliedCauseContext = {
  causeJSON: string
  guards: readonly Guard[]
  proofPaths: readonly string[]
  proof: ObservedProof | null
  proofUnavailableReason: string | null
  contributionIds: readonly string[]
}

type ConservedNativeResult = {
  native: NativeBatchResult
  contributionIds: string[]
}

function failed<T>(kind: EffectFailureKind, ...diagnostics: string[]): CorrectionEffectResult<T> {
  return { ok: false, kind, diagnostics }
}

function jsonBashCall(call: {
  toolCallId: string
  input: Json
  effectiveCwd: string | null
  result: Json | null
  exitCode: number | null
}): Json {
  return {
    toolCallId: call.toolCallId,
    input: call.input,
    effectiveCwd: call.effectiveCwd,
    result: call.result,
    exitCode: call.exitCode,
  }
}

function jsonEvidence(evidence: NativeChildResult['proofEvidence']): Json {
  if (evidence === null) return null
  return {
    purpose: evidence.purpose,
    causeId: evidence.causeId,
    occurrence: evidence.occurrence,
    guardId: evidence.guardId,
    call: evidence.call === null ? null : jsonBashCall(evidence.call),
  }
}

function jsonSubmission(item: NativeChildResult['submissions'][number]): Json {
  return {
    attemptIndex: item.attemptIndex,
    data: item.data,
    raw: item.raw,
    partialText: item.partialText,
  }
}

function jsonChild(child: NativeChildResult): Json {
  const record: { [key: string]: Json } = {
    id: child.id,
    expectedId: child.expectedId,
    submissions: child.submissions.map(jsonSubmission),
    proofEvidence: jsonEvidence(child.proofEvidence),
    raw: child.raw,
    partialText: child.partialText,
    structured: child.structured,
    usable: child.usable,
    reason: child.reason,
  }
  if (child.bashCalls !== undefined) record.bashCalls = child.bashCalls.map(jsonBashCall)
  return record
}

function actionTask(
  name: string,
  agent: string,
  task: string,
  solutionSpace: string,
  proofEvidence: NativeProofDirective,
): NativeTask {
  return { name, agent, task, solutionSpace, proofEvidence }
}

function causePaths(cause: CorrectionCause): string[] | null {
  const paths = cause.paths.map((path) => path.replace(/:\d+$/, ''))
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        path.trim().length === 0 || path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..'),
    )
  )
    return null
  return paths
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}

function sameOrDescendant(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`)
}

function repoRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path === path.trim() &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  )
}

function correctionActionContext(
  causeJSON: string,
  proofPaths: readonly string[],
  priorApplyProof: ObservedProof | null,
): Json {
  return {
    causeJSON,
    proofPaths: [...proofPaths],
    priorApplyProof:
      priorApplyProof === null
        ? null
        : {
            toolCallId: priorApplyProof.toolCallId,
            input: priorApplyProof.input,
            result: priorApplyProof.result,
            exitCode: priorApplyProof.exitCode,
          },
  }
}

function headRef(ref: string): boolean {
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..') && !ref.endsWith('/')
}

function remoteRefSHA(stdout: string, ref: string): string | null | undefined {
  const lines = stdout.trim() === '' ? [] : stdout.trim().split('\n')
  if (lines.length === 0) return null
  if (lines.length !== 1) return undefined
  const [sha, actualRef] = lines[0]?.split('\t') ?? []
  return sha !== undefined && actualRef === ref && isSha(sha) ? sha : undefined
}

/**
 * Executes only fixed Git observations/effects. Native tasks perform repository
 * proofs and surgical perturbation; the host never turns declarative proof prose
 * into a shell command.
 */
export function createNativeCorrectionExecution(options: NativeCorrectionExecutionOptions): CorrectionExecution {
  let expectedHead = options.prepared.target.candidateGitSHA
  const ownedCommits: string[] = []
  const appliedByCause = new Map<string, AppliedCauseContext>()
  let repositoryChecked: Promise<CorrectionEffectResult<void>> | null = null

  const abortFence = <T>(): CorrectionEffectResult<T> | null =>
    options.signal.aborted ? failed('terminal', 'fix-run-aborted') : null

  const runGit = async (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    const output = await execFileAsync('git', [...args], {
      cwd: options.prepared.cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return { stdout: String(output.stdout), stderr: String(output.stderr) }
  }

  const assertRepository = (): Promise<CorrectionEffectResult<void>> => {
    if (repositoryChecked !== null) return repositoryChecked
    repositoryChecked = (async () => {
      try {
        const configured = realpathSync(options.prepared.cwd)
        const root = await runGit(['rev-parse', '--show-toplevel'])
        return realpathSync(root.stdout.trim()) === configured
          ? { ok: true, value: undefined }
          : failed('terminal', 'correction-cwd-is-not-repository-root')
      } catch (error) {
        return failed('terminal', `correction-repository-unreadable:${message(error)}`)
      }
    })()
    return repositoryChecked
  }

  const cleanHead = async (): Promise<CorrectionEffectResult<{ head: string }>> => {
    const repository = await assertRepository()
    if (!repository.ok) return repository
    try {
      const [head, status] = await Promise.all([runGit(['rev-parse', 'HEAD']), runGit(['status', '--porcelain'])])
      const current = head.stdout.trim()
      return status.stdout.trim() === '' && isSha(current)
        ? { ok: true, value: { head: current } }
        : failed('terminal', 'fix-worktree-not-clean')
    } catch (error) {
      return failed('terminal', `fix-git-state-unreadable:${message(error)}`)
    }
  }

  const expectedCleanHead = async (): Promise<CorrectionEffectResult<{ head: string }>> => {
    const state = await cleanHead()
    if (!state.ok) return state
    return state.value.head === expectedHead ? state : failed('terminal', 'fix-head-mismatch')
  }

  const validatePublishBinding = async (head: string): Promise<CorrectionEffectResult<PublishBinding>> => {
    const publish = options.prepared.publishBinding
    const target = options.prepared.target
    const localRef = `refs/heads/${publish.localBranch}`
    const defaultRef = `refs/heads/${publish.defaultBranch}`
    if (
      !isSha(head) ||
      target.candidateGitSHA === null ||
      !isSha(target.candidateGitSHA) ||
      !headRef(localRef) ||
      !headRef(publish.destinationRef) ||
      !headRef(defaultRef) ||
      publish.destinationRef !== localRef ||
      localRef === defaultRef ||
      !isSha(publish.localHead) ||
      publish.localHead !== target.candidateGitSHA ||
      (publish.expectedRemoteSHA !== null && !isSha(publish.expectedRemoteSHA))
    )
      return failed('terminal', 'publish-binding-invalid')
    const repository = await assertRepository()
    if (!repository.ok) return repository
    try {
      const [symbolicHead, branchHead, effectivePushURL, remote] = await Promise.all([
        runGit(['symbolic-ref', '--quiet', 'HEAD']),
        runGit(['rev-parse', localRef]),
        runGit(['remote', 'get-url', '--push', 'origin']),
        runGit(['ls-remote', '--refs', publish.pushUrl, publish.destinationRef]),
      ])
      const observedRemoteSHA = remoteRefSHA(remote.stdout, publish.destinationRef)
      if (
        symbolicHead.stdout.trim() !== localRef ||
        branchHead.stdout.trim() !== head ||
        effectivePushURL.stdout.trim() !== publish.pushUrl ||
        observedRemoteSHA === undefined ||
        observedRemoteSHA !== publish.expectedRemoteSHA
      )
        return failed('terminal', 'publish-binding-stale')
      return { ok: true, value: publish }
    } catch (error) {
      return failed('terminal', `publish-binding-unverified:${message(error)}`)
    }
  }

  const verifyOwnedCommit = async (
    commit: string,
    parent: string,
    causeScopePaths: readonly string[],
    proofPaths: readonly string[],
  ): Promise<CorrectionEffectResult<Json>> => {
    try {
      if (proofPaths.some((path) => !repoRelativePath(path)))
        return failed('terminal', 'native-apply-proof-paths-invalid')
      const [head, resolved, parents, changed, status] = await Promise.all([
        runGit(['rev-parse', 'HEAD']),
        runGit(['rev-parse', '--verify', `${commit}^{commit}`]),
        runGit(['rev-list', '--parents', '-n1', commit]),
        runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]),
        runGit(['status', '--porcelain']),
      ])
      const parentTokens = parents.stdout.trim().split(/\s+/)
      const hasOnlyExpectedParent =
        parentTokens.length === 2 && parentTokens[0] === commit && parentTokens[1] === parent
      const allowedPaths = [...causeScopePaths, ...proofPaths]
      const changedPaths = changed.stdout.split('\n').filter(Boolean)
      const bounded =
        changedPaths.length > 0 &&
        changedPaths.every((path) => allowedPaths.some((scope) => sameOrDescendant(path, scope)))
      if (
        head.stdout.trim() !== commit ||
        resolved.stdout.trim() !== commit ||
        !hasOnlyExpectedParent ||
        status.stdout.trim() !== '' ||
        !bounded
      ) {
        return failed('terminal', 'native-apply-git-state-unverified')
      }
      return {
        ok: true,
        value: {
          head: head.stdout,
          commit: resolved.stdout,
          parent: parents.stdout,
          changed: changed.stdout,
          proofPaths: [...proofPaths],
        },
      }
    } catch (error) {
      return failed('terminal', `native-apply-proof-unverified:${message(error)}`)
    }
  }

  const outputFor = (
    result: NativeBatchResult,
  ): CorrectionEffectResult<{ child: NativeChildResult; output: ActionResult }> => {
    if (!result.complete || result.children.length !== 1) return failed('terminal', 'native-action-result-incomplete')
    const child = result.children[0]
    if (!child?.usable || child.structured === null) return failed('terminal', 'native-action-output-unusable')
    const parsed = actionResultSchema.safeParse(child.structured)
    return parsed.success
      ? { ok: true, value: { child, output: parsed.data } }
      : failed('terminal', 'native-action-output-invalid')
  }

  const observedProof = (
    child: NativeChildResult,
    purpose: NativeProofDirective['purpose'],
    causeId: string,
    occurrence: NativeProofDirective['occurrence'],
    guardId: string | null,
    selectedId: string | null,
    unavailableReason: string | null,
  ): CorrectionEffectResult<ObservedProof | null> => {
    if (selectedId === null) {
      return unavailableReason === null ? failed('terminal', 'native-proof-xor-invalid') : { ok: true, value: null }
    }
    const evidence = child.proofEvidence
    if (
      unavailableReason !== null ||
      evidence === null ||
      evidence.purpose !== purpose ||
      evidence.causeId !== causeId ||
      evidence.occurrence !== occurrence ||
      evidence.guardId !== guardId ||
      evidence.call === null
    ) {
      return failed('terminal', 'native-proof-evidence-missing')
    }
    const call = evidence.call
    try {
      if (
        call.toolCallId !== selectedId ||
        call.result === null ||
        call.exitCode === null ||
        call.effectiveCwd === null ||
        realpathSync(call.effectiveCwd) !== realpathSync(options.prepared.cwd)
      ) {
        return failed('terminal', 'native-proof-evidence-incomplete')
      }
    } catch {
      return failed('terminal', 'native-proof-cwd-unreadable')
    }
    return {
      ok: true,
      value: { toolCallId: call.toolCallId, input: call.input, result: call.result, exitCode: call.exitCode },
    }
  }

  const dispatch = async (binding: CorrectionActionBinding): Promise<CorrectionEffectResult<ConservedNativeResult>> => {
    const fence = abortFence<ConservedNativeResult>()
    if (fence) return fence
    const authorized = await options.authorizeContinuation?.()
    if (authorized !== undefined && !authorized.ok)
      return {
        ok: false,
        kind: 'terminal',
        diagnostics: authorized.diagnostics,
        preEffectRefusal: authorized.diagnostics,
      }
    const stillFenced = abortFence<ConservedNativeResult>()
    if (stillFenced) return stillFenced
    const bound = await options.bindAction(binding)
    if (!bound.ok) return failed(bound.kind, ...bound.diagnostics)
    const { batch } = bound.value
    if (
      batch.operationId !== options.operationId ||
      batch.tasks.tasks.length !== 1 ||
      batch.tasks.tasks[0]?.name !== binding.task.name ||
      options.native.active() !== null
    ) {
      return failed('terminal', 'native-action-binding-invalid')
    }
    const deferred = Promise.withResolvers<CorrectionEffectResult<ConservedNativeResult>>()
    const announcementAborted = Promise.withResolvers<void>()
    let deferredSettled = false
    let resultConserved = false
    const settle = (value: CorrectionEffectResult<ConservedNativeResult>): void => {
      if (deferredSettled) return
      deferredSettled = true
      deferred.resolve(value)
    }
    const finish = async (
      result: NativeBatchResult,
      terminal: CorrectionEffectResult<ConservedNativeResult>,
    ): Promise<void> => {
      if (resultConserved) return
      resultConserved = true
      try {
        const conserved = await bound.value.conserve(result)
        if (conserved.ok) {
          if (
            conserved.value.contributionIds.length === 0 ||
            conserved.value.contributionIds.some((id) => id.trim().length === 0)
          ) {
            settle(failed('terminal', 'native-action-contribution-ids-missing'))
            throw new Error('native-action-contribution-ids-missing')
          }
          settle(
            terminal.ok
              ? { ok: true, value: { native: result, contributionIds: conserved.value.contributionIds } }
              : terminal,
          )
          return
        }
        settle(failed('terminal', ...conserved.diagnostics))
        throw new Error(`native-action-conservation-failed:${conserved.diagnostics.join(';')}`)
      } catch (error) {
        settle(failed('terminal', `native-action-conservation-failed:${message(error)}`))
        throw error
      }
    }
    const callbacks: NativeBatchCallbacks = {
      onComplete: async (result) => finish(result, { ok: true, value: { native: result, contributionIds: [] } }),
      onStop: async (reason, result) => {
        if (result === null) settle(failed('terminal', `native-action-stopped:${reason}`))
        else await finish(result, failed('terminal', `native-action-incomplete:${reason}`))
      },
    }

    const stopAndConserve = async (
      reason: string,
      fallback: CorrectionEffectResult<ConservedNativeResult>,
    ): Promise<CorrectionEffectResult<ConservedNativeResult>> => {
      try {
        await options.native.stopOwned(batch, reason)
      } catch (error) {
        settle(
          failed(
            'terminal',
            ...(fallback.ok ? [] : fallback.diagnostics),
            `native-action-stop-failed:${message(error)}`,
          ),
        )
      }
      if (!deferredSettled) settle(fallback)
      return await deferred.promise
    }
    const stopOnAbort = (): void => {
      announcementAborted.resolve()
      settle(failed('terminal', 'fix-run-aborted'))
      void options.native.stopOwned(batch, 'fix-run-aborted').catch(() => undefined)
    }
    options.signal.addEventListener('abort', stopOnAbort, { once: true })
    try {
      const beforeActivation = abortFence<ConservedNativeResult>()
      if (beforeActivation) return beforeActivation
      options.native.activate(batch, callbacks)
      const beforeAnnouncement = abortFence<ConservedNativeResult>()
      if (beforeAnnouncement) return await stopAndConserve('fix-run-aborted', beforeAnnouncement)
      const announced = await Promise.race([
        options.native.announce(batch).then(() => true),
        announcementAborted.promise.then(() => false),
      ])
      if (!announced) return await deferred.promise
      const started = await options.onStarted(batch, binding)
      if (!started.ok)
        return await stopAndConserve('correction-action-start-unrecorded', failed('terminal', ...started.diagnostics))
      return await deferred.promise
    } catch (error) {
      return await stopAndConserve(
        'native-action-dispatch-failed',
        failed('terminal', `native-action-dispatch-failed:${message(error)}`),
      )
    } finally {
      options.signal.removeEventListener('abort', stopOnAbort)
    }
  }

  const taskName = (phase: string, causeId: string, suffix = ''): string => {
    const base = `fix-${phase}-${causeId}${suffix}`.replace(/[^A-Za-z0-9._:-]/g, '-')
    return base.length <= 128
      ? base
      : `${base.slice(0, 115)}-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`
  }

  return {
    async apply(cause, attempt) {
      if (expectedHead === null) return failed('terminal', 'publish-head-unavailable')
      const publish = await validatePublishBinding(expectedHead)
      if (!publish.ok) return publish
      const state = await expectedCleanHead()
      if (!state.ok) return state
      const paths = causePaths(cause)
      if (paths === null) return failed('terminal', 'correction-paths-invalid')
      const causeJSON = JSON.stringify(cause)
      const task = actionTask(
        taskName('apply', cause.id, `-${attempt}`),
        nativeFixProfileByAction.apply,
        `Apply only confirmed correction cause ${cause.id} in ${options.prepared.cwd}. Cause: ${causeJSON}. Edit only declared correction paths plus explicit repository-local proof implementation paths. Retain the existing same-class sweep boundary, create exactly one owned correction commit, and do not push. Run only repository-native checks required by the cause; return factual command outputs, every production guard, explicit proofPaths for any proof implementation files changed (empty for existing/no-test), and the selected actual top-level proof tool-call reference.`,
        `one bounded correction cause ${cause.id}`,
        { purpose: 'fix-apply', causeId: cause.id, occurrence: 'apply' },
      )
      const result = await dispatch({
        phase: 'apply',
        causeId: cause.id,
        task,
        contextRefs: [options.decisionId],
        context: correctionActionContext(causeJSON, [], null),
      })
      if (!result.ok) return result
      const interpreted = outputFor(result.value.native)
      if (!interpreted.ok) return interpreted
      const { output, child } = interpreted.value
      if (!('outcome' in output) || output.outcome === 'failed') {
        const unchanged = await expectedCleanHead()
        if (!unchanged.ok || !('outcome' in output) || output.commitSHAs.length !== 0)
          return failed('terminal', 'native-failed-action-state-unsafe')
        return failed('retryable', 'native-apply-reported-failed')
      }
      if (output.commitSHAs.length !== 1 || !isSha(output.commitSHAs[0] ?? ''))
        return failed('terminal', 'native-apply-commit-invalid')
      const commit = output.commitSHAs[0] as string
      const verified = await verifyOwnedCommit(commit, state.value.head, paths, output.proofPaths)
      if (!verified.ok) return verified
      ownedCommits.push(commit)
      expectedHead = commit
      const proof = observedProof(
        child,
        'fix-apply',
        cause.id,
        'apply',
        null,
        output.proofToolCallId,
        output.proofUnavailableReason,
      )
      if (!proof.ok) {
        const fence = abortFence<{ commitSHAs: string[]; raw: Json; contributionIds: string[] }>()
        if (fence) return fence
        try {
          await runGit(['revert', '--no-edit', commit])
          const reverted = await cleanHead()
          if (!reverted.ok || reverted.value.head === commit)
            return failed('terminal', 'native-apply-proof-unavailable-and-revert-unverified')
          ownedCommits.pop()
          expectedHead = reverted.value.head
          return failed('terminal', ...proof.diagnostics)
        } catch (error) {
          return failed('terminal', `native-apply-proof-unavailable-and-revert-failed:${message(error)}`)
        }
      }
      if (proof.value !== null && proof.value.exitCode !== 0) {
        const fence = abortFence<{ commitSHAs: string[]; raw: Json; contributionIds: string[] }>()
        if (fence) return fence
        try {
          await runGit(['revert', '--no-edit', commit])
          const reverted = await cleanHead()
          if (!reverted.ok || reverted.value.head === commit)
            return failed('terminal', 'native-apply-proof-failed-and-revert-unverified')
          ownedCommits.pop()
          expectedHead = reverted.value.head
          return failed('terminal', 'native-apply-proof-failed')
        } catch (error) {
          return failed('terminal', `native-apply-proof-failed-and-revert-failed:${message(error)}`)
        }
      }
      appliedByCause.set(cause.id, {
        causeJSON,
        guards: output.guardInventory,
        proofPaths: [...output.proofPaths],
        proof: proof.value,
        proofUnavailableReason: output.proofUnavailableReason,
        contributionIds: [...result.value.contributionIds],
      })
      const raw: Json = {
        causeId: cause.id,
        batch: result.value.native.raw,
        children: result.value.native.children.map(jsonChild),
        output: child.structured,
        observed: verified.value,
        proofEvidence: jsonEvidence(child.proofEvidence),
        proof:
          proof.value === null
            ? null
            : {
                toolCallId: proof.value.toolCallId,
                input: proof.value.input,
                result: proof.value.result,
                exitCode: proof.value.exitCode,
              },
      }
      return {
        ok: true,
        value: {
          commitSHAs: [commit],
          contributionIds: [...result.value.contributionIds],
          raw,
        },
      }
    },

    async revert(commitSHAs) {
      const fence = abortFence<{ reverted: string[]; revertSHA: string; contributionIds: string[] }>()
      if (fence) return fence
      if (commitSHAs.length !== 1 || commitSHAs[0] !== expectedHead || ownedCommits.at(-1) !== commitSHAs[0])
        return failed('terminal', 'git-revert-unowned-commit')
      const before = await expectedCleanHead()
      if (!before.ok) return before
      try {
        await runGit(['revert', '--no-edit', commitSHAs[0] as string])
        const after = await cleanHead()
        if (!after.ok || after.value.head === before.value.head || !isSha(after.value.head))
          return failed('terminal', 'git-revert-state-unverified')
        ownedCommits.pop()
        expectedHead = after.value.head
        return { ok: true, value: { reverted: [...commitSHAs], revertSHA: after.value.head, contributionIds: [] } }
      } catch (error) {
        return failed('terminal', `git-revert-failed:${message(error)}`)
      }
    },

    async revalidateRequiredPaths(causes) {
      const checked: Json[] = []
      const contributionIds: string[] = []
      for (const cause of causes) {
        const state = await expectedCleanHead()
        if (!state.ok) return state
        const applied = appliedByCause.get(cause.id)
        if (applied === undefined) return failed('terminal', `required-cause-not-applied:${cause.id}`)
        if (applied.proof === null) {
          checked.push({ causeId: cause.id, skippedReason: applied.proofUnavailableReason, selectedApplyProof: null })
          continue
        }
        const context = correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof)
        const task = actionTask(
          taskName('revalidate', cause.id),
          nativeFixProfileByAction.apply,
          `Revalidate the confirmed required correction cause ${cause.id} in ${options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. Reuse this semantic proof identity only; the actual selected apply proof evidence was ${JSON.stringify(applied.proof)} and its declared proofPaths were ${JSON.stringify(applied.proofPaths)}. Do not edit, commit, push, or alter files. Return actual command results with no commits, empty proofPaths, and an empty guard inventory.`,
          `required correction proof revalidation for ${cause.id}`,
          { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'apply' },
        )
        const result = await dispatch({
          phase: 'revalidate',
          causeId: cause.id,
          task,
          contextRefs: [options.decisionId, ...applied.contributionIds],
          context,
        })
        if (!result.ok) return result
        const interpreted = outputFor(result.value.native)
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
          'fix-revalidate',
          cause.id,
          'apply',
          null,
          output.proofToolCallId,
          output.proofUnavailableReason,
        )
        if (!proof.ok || proof.value === null || proof.value.exitCode !== 0)
          return failed('terminal', 'required-path-revalidation-proof-invalid')
        const after = await expectedCleanHead()
        if (!after.ok || after.value.head !== state.value.head)
          return failed('terminal', 'required-path-revalidation-state-changed')
        contributionIds.push(...result.value.contributionIds)
        checked.push({
          causeId: cause.id,
          contributionIds: result.value.contributionIds,
          batch: result.value.native.raw,
          output,
          proofEvidence: child.proofEvidence,
          proof: proof.value,
        })
      }
      return { ok: true, value: { checked, contributionIds } }
    },

    async falsify(cause, commitSHAs) {
      const paths = causePaths(cause)
      if (paths === null) return failed('terminal', 'falsification-paths-invalid')
      const state = await expectedCleanHead()
      if (!state.ok) return state
      if (commitSHAs.length !== 1 || commitSHAs[0] !== state.value.head || !ownedCommits.includes(state.value.head))
        return failed('terminal', 'falsification-commit-binding-invalid')
      const applied = appliedByCause.get(cause.id)
      if (applied === undefined) return failed('terminal', 'falsification-guard-inventory-missing')
      if (applied.proof === null) {
        const raw: Json = {
          causeId: cause.id,
          selectedApplyProof: null,
          proofUnavailableReason: applied.proofUnavailableReason,
        }
        return {
          ok: true,
          value: {
            facts: [],
            contributionIds: [],
            skippedReason: applied.proofUnavailableReason ?? 'apply-proof-unavailable',
            raw,
          },
        }
      }
      const guards = applied.guards
      if (guards.length === 0) {
        const raw: Json = { guards: [] }
        return {
          ok: true,
          value: { facts: [], contributionIds: [], skippedReason: 'no production guard identified', raw },
        }
      }
      const facts: FalsificationFact[] = []
      const raw: Json[] = []
      const contributionIds: string[] = []
      let skippedReason: string | undefined
      for (const guard of guards) {
        const perturbedTask = actionTask(
          taskName('falsify', cause.id, `-${guard.guardId}`),
          nativeFixProfileByAction.falsify,
          `For correction cause ${cause.id}, falsify only confirmed production guard ${JSON.stringify(guard)} in ${options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. Use the same semantic proof identity as actual selected apply proof ${JSON.stringify(applied.proof)}; declared apply proofPaths: ${JSON.stringify(applied.proofPaths)}. Make one surgical declared-path perturbation, assess the actual observed failure scenario, surgically restore before yielding, and do not commit or push. Return exactly one fact for guard ${guard.guardId}.`,
          `one production-guard falsification for ${cause.id}:${guard.guardId}`,
          { purpose: 'fix-falsify', causeId: cause.id, occurrence: 'perturbed' },
        )
        const perturbed = await dispatch({
          phase: 'falsify',
          causeId: cause.id,
          task: perturbedTask,
          contextRefs: [options.decisionId, ...applied.contributionIds],
          context: correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof),
        })
        if (!perturbed.ok) return perturbed
        const interpreted = outputFor(perturbed.value.native)
        if (!interpreted.ok) return interpreted
        const { output, child } = interpreted.value
        if (
          !('facts' in output) ||
          output.facts.length !== 1 ||
          output.facts[0]?.guardId !== guard.guardId ||
          output.facts[0]?.intendedScenario !== guard.intendedScenario
        )
          return failed('terminal', 'falsification-guard-fact-invalid')
        const fact = output.facts[0]
        const clean = await expectedCleanHead()
        if (!clean.ok || clean.value.head !== state.value.head)
          return failed('terminal', 'native-falsifier-restoration-unproven')
        contributionIds.push(...perturbed.value.contributionIds)
        raw.push({
          causeId: cause.id,
          guardId: guard.guardId,
          guard,
          contributionIds: perturbed.value.contributionIds,
          batch: perturbed.value.native.raw,
          output,
          proofEvidence: child.proofEvidence,
        })
        if (output.skippedReason !== null || !fact.removed) {
          skippedReason ??= output.skippedReason ?? 'no production guard identified'
          continue
        }
        const proof = observedProof(
          child,
          'fix-falsify',
          cause.id,
          'perturbed',
          guard.guardId,
          fact.proofToolCallId,
          fact.proofUnavailableReason,
        )
        if (!proof.ok) return proof
        if (proof.value === null) {
          skippedReason ??= fact.proofUnavailableReason ?? 'falsification-proof-unavailable'
          continue
        }
        const restoredTask = actionTask(
          taskName('restore-proof', cause.id, `-${guard.guardId}`),
          nativeFixProfileByAction.apply,
          `After native surgical restoration of production guard ${guard.guardId} for correction cause ${cause.id}, run only the same semantic repository-native proof in ${options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. The selected apply proof was ${JSON.stringify(applied.proof)} with declared proofPaths ${JSON.stringify(applied.proofPaths)}. Do not edit, commit, push, or alter files. Return outcome applied with no commits, empty proofPaths, and an empty guard inventory.`,
          `restored proof for ${cause.id}:${guard.guardId}`,
          { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'restored' },
        )
        const restored = await dispatch({
          phase: 'restore-proof',
          causeId: cause.id,
          task: restoredTask,
          contextRefs: [options.decisionId, ...applied.contributionIds, ...perturbed.value.contributionIds],
          context: correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof),
        })
        if (!restored.ok) return restored
        const restoredOutput = outputFor(restored.value.native)
        if (!restoredOutput.ok) return restoredOutput
        const restoredAction = restoredOutput.value.output
        if (
          !('outcome' in restoredAction) ||
          restoredAction.outcome !== 'applied' ||
          restoredAction.commitSHAs.length !== 0 ||
          restoredAction.guardInventory.length !== 0
        )
          return failed('terminal', 'falsification-restored-proof-invalid')
        const restoredProof = observedProof(
          restoredOutput.value.child,
          'fix-revalidate',
          cause.id,
          'restored',
          null,
          restoredAction.proofToolCallId,
          restoredAction.proofUnavailableReason,
        )
        if (!restoredProof.ok) return restoredProof
        const restoredClean = await expectedCleanHead()
        if (!restoredClean.ok || restoredClean.value.head !== state.value.head)
          return failed('terminal', 'falsification-restored-proof-state-changed')
        contributionIds.push(...restored.value.contributionIds)
        raw.push({
          causeId: cause.id,
          guardId: guard.guardId,
          restoredContributionIds: restored.value.contributionIds,
          restored: restored.value.native.raw,
          restoredOutput: restoredAction,
          proofEvidence: restoredOutput.value.child.proofEvidence,
          restoredProof: restoredProof.ok ? restoredProof.value : null,
        })
        if (restoredProof.value === null || restoredProof.value.exitCode !== 0) {
          skippedReason ??= 'falsification-restored-proof-inconclusive'
          continue
        }
        if (fact.proofFailed && proof.value.exitCode !== 0) {
          facts.push({
            guardId: guard.guardId,
            guard: guard.productionGuard,
            intendedScenario: guard.intendedScenario,
            removedProductionGuard: true,
            proofFailedIntendedScenario: true,
            proofToolCallId: proof.value.toolCallId,
            proofUnavailableReason: null,
            detail: `perturbedExit=${proof.value.exitCode}; restoredExit=${restoredProof.value.exitCode}`,
          })
        } else if (!fact.proofFailed && proof.value.exitCode === 0) {
          facts.push({
            guardId: guard.guardId,
            guard: guard.productionGuard,
            intendedScenario: guard.intendedScenario,
            removedProductionGuard: true,
            proofFailedIntendedScenario: false,
            proofToolCallId: proof.value.toolCallId,
            proofUnavailableReason: null,
            detail: `perturbedExit=0; restoredExit=${restoredProof.value.exitCode}`,
          })
        } else {
          skippedReason ??= 'falsification-semantic-evidence-conflict'
        }
      }
      return {
        ok: true,
        value: { facts, raw, contributionIds, ...(skippedReason === undefined ? {} : { skippedReason }) },
      }
    },

    async head() {
      const state = await expectedCleanHead()
      return state.ok ? { ok: true, value: state.value.head } : state
    },

    async push() {
      if (expectedHead === null) return failed('terminal', 'publish-head-unavailable')
      const binding = await validatePublishBinding(expectedHead)
      if (!binding.ok) return binding
      const before = await expectedCleanHead()
      if (!before.ok) return before
      const attempts: Json[] = []
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const fence = abortFence<{ head: string; raw: Json; contributionIds: string[] }>()
        if (fence) return fence
        const authorized = await options.authorizeContinuation?.()
        if (authorized !== undefined && !authorized.ok) return failed('terminal', ...authorized.diagnostics)
        const stillFenced = abortFence<{ head: string; raw: Json; contributionIds: string[] }>()
        if (stillFenced) return stillFenced
        try {
          const output = await runGit([
            'push',
            '--no-follow-tags',
            binding.value.pushUrl,
            `${before.value.head}:${binding.value.destinationRef}`,
          ])
          const [after, remote] = await Promise.all([
            expectedCleanHead(),
            runGit(['ls-remote', '--refs', binding.value.pushUrl, binding.value.destinationRef]),
          ])
          const remoteSHA = remoteRefSHA(remote.stdout, binding.value.destinationRef)
          const observedRemoteSHA = remoteSHA ?? null
          attempts.push({ attempt, output, remoteSHA: observedRemoteSHA })
          if (!after.ok || after.value.head !== before.value.head || remoteSHA !== before.value.head)
            return failed('terminal', 'git-push-destination-unverified')
          return {
            ok: true,
            value: {
              head: after.value.head,
              contributionIds: [],
              raw: { attempts, destinationRef: binding.value.destinationRef },
            },
          }
        } catch (error) {
          attempts.push({ attempt, error: message(error) })
        }
      }
      return failed('terminal', `git-push-failed:${JSON.stringify(attempts)}`)
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
