import type { GitHubOptions } from '../dist/contracts.js'
import { decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import { runAdmittedCiCorrection } from './fix-ci-execution.ts'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  NativePort,
  RecordPublisher,
  ReviewAuthority,
} from './fix-contract.ts'
import type { DebtEvidence } from './fix-domain'
import { createIdentity, type FixRun, type FixStart } from './fix-entry-lifecycle.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { defaultGh, fail, type Gh, gitResult, object } from './fix-entry-target-core.ts'
import { createResolver } from './fix-entry-target-resolver.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'

export type AdmittedCiCorrectionEntry = {
  cwd: string
  reference: string
  attributionRecordId: string
  scope: string
  native: NativePort
  workflow: ReviewAuthority
  github?: GitHubOptions
  gh?: Gh
  debtEvidence?: DebtEvidence
}
export async function runAdmittedCiCorrectionEntry(
  input: AdmittedCiCorrectionEntry,
  identity: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  if (input.reference.trim().length === 0) return fail('fix-target-required')
  if (input.attributionRecordId.trim().length === 0) return fail('ci-correction-evidence-missing')
  if (input.scope.trim().length === 0) return fail('fix-scope-invalid')
  const gh = input.gh ?? defaultGh
  const repository = await gitResult(input.cwd, ['remote', 'get-url', 'origin'])
  if (repository.code !== 0) return fail(`fix-repository-unreadable:${repository.stderr.trim()}`)
  let canonicalRepository: string
  try {
    const repo = object(JSON.parse(await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
    if (repo === null || typeof repo.nameWithOwner !== 'string' || repo.nameWithOwner.length === 0)
      return fail('fix-repository-unreadable')
    canonicalRepository = repo.nameWithOwner
  } catch (error) {
    return fail(`fix-repository-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  const resolver = createResolver(input.cwd, gh, canonicalRepository)
  const target = await resolver.resolveExplicit(input.reference)
  if (target === null) return fail('fix-target-required')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, target.repository, target)
  if (!publishBinding.ok) return publishBinding
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const scope = githubScope(target.repository, target.number)
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  const publisher: RecordPublisher = {
    publish: async (record) => {
      const saved = await rawPublisher.publish(record)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  const readHistory = () => readGitHubHistory(scope, github).then(decodeHistory)
  return runAdmittedCiCorrection(
    {
      cwd: input.cwd,
      target,
      scope: input.scope,
      branch: publishBinding.value.localBranch,
      base: publishBinding.value.defaultBranch,
      attributionRecordId: input.attributionRecordId,
      workflow: input.workflow,
      options: github,
      readHistory,
      signal: runtime.signal,
    },
    {
      resolver,
      publisher,
      readHistory,
      workflow: input.workflow,
      native: input.native,
      runtime,
      identity,
      publishBinding: publishBinding.value,
      debtEvidence: input.debtEvidence,
    },
  )
}
export function startAdmittedCiCorrection(input: AdmittedCiCorrectionEntry): FixRun {
  const identity = createIdentity()
  const started = Promise.withResolvers<FixStart>()
  const completed = Promise.withResolvers<FixActionResult<FixRecord>>()
  const controller = new AbortController()
  let inhibit: 'pause' | null = null
  let continueBound: (() => Promise<FixActionResult<void>>) | null = null
  let stopped = false
  let startSettled = false
  let completionSettled = false
  let activeBatch: Parameters<NativePort['announce']>[0] | null = null
  const settleStarted = (value: FixStart) => {
    if (!startSettled) {
      startSettled = true
      started.resolve(value)
    }
  }
  const settleCompletion = (value: FixActionResult<FixRecord>) => {
    if (!completionSettled) {
      completionSettled = true
      completed.resolve(value)
    }
  }
  const runtime: FixWorkflowRuntime = {
    signal: controller.signal,
    onBatch(batch) {
      activeBatch = batch
    },
    onStarted() {
      if (!stopped) settleStarted({ status: 'accepted', runId: identity.runId, operationId: identity.operationId })
    },
    async beforeContinuation() {
      if (inhibit !== null || controller.signal.aborted) return fail('fix-mandate-refused:unconfirmed')
      if (continueBound === null) return fail('fix-mandate-authority-unavailable')
      const allowed = await continueBound()
      return inhibit !== null || controller.signal.aborted ? fail('fix-mandate-refused:unconfirmed') : allowed
    },
    bindContinuation(check) {
      continueBound = check
    },
  }
  void runAdmittedCiCorrectionEntry(input, identity, runtime)
    .then((result) => {
      if (stopped) return
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
    .catch((error) => {
      if (stopped) return
      const result = fail<FixRecord>(`fix-run-failed:${error instanceof Error ? error.message : String(error)}`)
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
  return {
    runId: identity.runId,
    operationId: identity.operationId,
    started: started.promise,
    completion: completed.promise,
    terminal: completed.promise.then((result) =>
      result.ok && result.value.kind === 'fix-result'
        ? { status: 'complete', recordId: result.value.recordId, kind: 'fix-result' }
        : { status: 'stopped', diagnostics: result.ok ? ['fix-terminal-not-result'] : result.diagnostics },
    ),
    async stop(reason) {
      if (stopped) return
      inhibit = 'pause'
      stopped = true
      let archival: Promise<void> | null = null
      try {
        if (activeBatch !== null) archival = input.native.stopOwned(activeBatch, reason)
      } finally {
        controller.abort()
        const result = fail<FixRecord>(`fix-run-interrupted-cleanup-unproven:${reason}`)
        settleStarted({ status: 'terminal', result })
        settleCompletion(result)
      }
      if (archival !== null) await archival
    },
  }
}
