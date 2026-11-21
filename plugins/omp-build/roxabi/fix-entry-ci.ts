import type { Destination } from '../contracts.ts'
import type { GitHubOptions, Scope } from '../dist/contracts.js'
import { canonicalValueDigest, decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import { trackPreparationGhOperation } from '../host/preparation-cohort.ts'
import { runAdmittedCiCorrection } from './fix-ci-execution.ts'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixTarget,
  NativePort,
  PublishBinding,
  RecordPublisher,
  ReviewAuthority,
  TargetResolver,
} from './fix-contract.ts'
import { createFixDispositionStore } from './fix-disposition-store.ts'
import { createIssueAliasReadPort } from './fix-entry-issue-alias.ts'
import { type FixRun, startFixRun } from './fix-entry-lifecycle.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { defaultGh, fail, type Gh, gitResult, object } from './fix-entry-target-core.ts'
import { createResolver } from './fix-entry-target-resolver.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import type { CiCorrectionAdmission } from './fix-mandate-types.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { observeFixOwnerAdmission } from './fix-owner-admission-observation.ts'
import { acquireFixOwnerLease } from './fix-owner-lease.ts'
import { openFreshFixOwner } from './fix-owner-opening.ts'
import { reserveFixOwner } from './fix-records.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'
import type { UwOperations, UwReadPort } from './uw-contract.ts'

export type AdmittedCiCorrectionEntry = {
  cwd: string
  reference: string
  attributionRecordId: string
  native: NativePort
  workflow: ReviewAuthority
  operations: UwOperations
  uw: UwReadPort
  expectedUw: CiCorrectionAdmission['uw']
  github?: GitHubOptions
  gh?: Gh
}
async function admitCiOwner(
  input: AdmittedCiCorrectionEntry,
  identity: FixIdentity,
  runtime: FixWorkflowRuntime,
  fence: FixExecutionFence,
  target: FixTarget,
  binding: PublishBinding & { destination: Destination },
  scope: Scope,
  github: GitHubOptions,
  gh: Gh,
  resolver: TargetResolver,
): Promise<FixActionResult<void>> {
  const uw = input.expectedUw.ownSpec.ref.uw
  const initial = await observeFixOwnerAdmission({
    uw,
    pullRequest: scope,
    destination: binding.destination,
    intent: 'fresh',
    github,
    reader: input.uw,
  })
  if (!initial.ok) return initial
  if (initial.value.admission.status !== 'fresh') return fail('fix-owner-admission-refused')
  const acquired = await acquireFixOwnerLease({
    destination: binding.destination,
    owner: reserveFixOwner(identity, uw),
    priorNamespace: initial.value.admission.priorNamespace,
    fence,
  })
  if (!acquired.ok) return acquired
  const refreshedTarget = await resolver.resolveExplicit(target.target)
  if (!refreshedTarget.ok) return refreshedTarget
  if (refreshedTarget.value === null || canonicalValueDigest(refreshedTarget.value) !== canonicalValueDigest(target))
    return fail('fix-target-changed')
  const refreshedBinding = await resolvePublishBinding(input.cwd, gh, target.repository, refreshedTarget.value)
  if (!refreshedBinding.ok) return refreshedBinding
  if (canonicalValueDigest(refreshedBinding.value) !== canonicalValueDigest(binding))
    return fail('fix-publish-binding-changed')
  runtime.openOwner = ({ target: preparedTarget, manifest, reservation }) =>
    openFreshFixOwner({
      identity,
      fence,
      uw,
      target: preparedTarget,
      cwd: input.cwd,
      publishBinding: refreshedBinding.value,
      reader: input.uw,
      github,
      manifest,
      reservation,
      afterClose: initial.value.admission.status === 'fresh' ? initial.value.admission.afterClose : null,
    })
  return { ok: true, value: undefined }
}

function createCiPublisher(
  input: AdmittedCiCorrectionEntry,
  scope: Scope,
  github: GitHubOptions,
  runtime: FixWorkflowRuntime,
): RecordPublisher {
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  return {
    publish: (record, canPublish) => {
      const publishRecord = async (): Promise<FixActionResult<void>> => {
        const mayPublish = () => (canPublish?.() ?? true) && (runtime.executionFence?.rootCurrent() ?? true)
        if (!mayPublish()) return fail('publication-ownership-revoked')
        const original = input.expectedUw.ownSpec.ref.uw
        const external =
          original.repository !== scope.repository || original.target !== scope.target
            ? [decodeHistory(await readGitHubHistory(original, github))]
            : []
        const saved = await rawPublisher.publish(record, external, mayPublish)
        return saved.ok ? { ok: true, value: undefined } : saved
      }
      return runtime.executionFence === undefined
        ? publishRecord()
        : runtime.executionFence.trackPublication(record, publishRecord)
    },
  }
}

async function readCiRepository(input: AdmittedCiCorrectionEntry, gh: Gh): Promise<FixActionResult<string>> {
  const repository = await gitResult(input.cwd, ['remote', 'get-url', 'origin'])
  if (repository.code !== 0) return fail(`fix-repository-unreadable:${repository.stderr.trim()}`)
  try {
    const repo = object(JSON.parse(await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
    if (repo === null || typeof repo.nameWithOwner !== 'string' || repo.nameWithOwner.length === 0)
      return fail('fix-repository-unreadable')
    return { ok: true, value: repo.nameWithOwner }
  } catch (error) {
    return fail(`fix-repository-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runAdmittedCiCorrectionEntry(
  input: AdmittedCiCorrectionEntry,
  identity: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  if (input.reference.trim().length === 0) return fail('fix-target-required')
  if (input.attributionRecordId.trim().length === 0) return fail('ci-correction-evidence-missing')
  const suppliedGh = input.gh
  const gh: Gh =
    suppliedGh === undefined ? defaultGh : (cwd, args) => trackPreparationGhOperation(args, () => suppliedGh(cwd, args))
  const repository = await readCiRepository(input, gh)
  if (!repository.ok) return repository
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const resolver = createResolver(input.cwd, gh, repository.value, createIssueAliasReadPort(github))
  const resolved = await resolver.resolveExplicit(input.reference)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (target === null) return fail('fix-target-required')
  const requested = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?([1-9][0-9]*)$/.exec(input.reference.trim())
  if (target.kind !== 'pull-request' || requested === null || target.number !== Number(requested[1]))
    return fail('ci-correction-target-mismatch')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, target.repository, target)
  if (!publishBinding.ok) return publishBinding
  const scope = githubScope(target.repository, target.number)
  const publisher = createCiPublisher(input, scope, github, runtime)
  const readHistory = () => readGitHubHistory(scope, github).then(decodeHistory)
  if (runtime.executionFence !== undefined) {
    const admitted = await admitCiOwner(
      input,
      identity,
      runtime,
      runtime.executionFence,
      target,
      publishBinding.value,
      scope,
      github,
      gh,
      resolver,
    )
    if (!admitted.ok) return admitted
  }
  return runAdmittedCiCorrection(
    {
      cwd: input.cwd,
      target,
      uw: input.uw,
      expectedUw: input.expectedUw,
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
      dispositionStore: createFixDispositionStore(input.expectedUw.ownSpec.ref.uw, github),
      readHistory,
      github,
      workflow: input.workflow,
      native: input.native,
      runtime,
      identity,
      publishBinding: publishBinding.value,
    },
  )
}
export function startAdmittedCiCorrection(input: AdmittedCiCorrectionEntry): FixRun {
  return startFixRun({
    native: input.native,
    operations: input.operations,
    drive: (identity, runtime) => runAdmittedCiCorrectionEntry(input, identity, runtime),
  })
}
