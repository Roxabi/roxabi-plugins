import type { Destination } from '../contracts.ts'
import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { canonicalValueDigest, decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import { trackPreparationGhOperation } from '../host/preparation-cohort.ts'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixTarget,
  PublishBinding,
  RecordPublisher,
  TargetResolver,
} from './fix-contract.ts'
import { createFixDispositionStore } from './fix-disposition-store.ts'
import { createDefaultPublisher } from './fix-entry-default-publisher.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { createIssueAliasReadPort } from './fix-entry-issue-alias.ts'
import { captureConfirmedFixRequest, runReviewBoundDefaultFix } from './fix-entry-review-bound.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { defaultGh, fail, type Gh, object } from './fix-entry-target-core.ts'
import { createResolver, parseInvocation } from './fix-entry-target-resolver.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import type { DefaultFixRequest } from './fix-execution-policy.ts'
import { runDefaultFixWorkflow } from './fix-execution-runner.ts'
import { confirmFixContinuation, decideFixAuthority } from './fix-mandate-authority.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { observeFixOwnerAdmission } from './fix-owner-admission-observation.ts'
import { acquireFixOwnerLease } from './fix-owner-lease.ts'
import { openFreshFixOwner } from './fix-owner-opening.ts'
import { reserveFixOwner } from './fix-records.ts'
import { withRoxabiGitHubPolicy } from './github-policy'

type BoundFixMandate = { recordId: string; sameScope: boolean; uw: Scope }

async function readRepository(cwd: string, gh: Gh): Promise<FixActionResult<string>> {
  try {
    const repository = object(JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])))?.nameWithOwner
    return typeof repository === 'string' ? { ok: true, value: repository } : fail('fix-repository-unreadable')
  } catch (error) {
    return fail(`fix-repository-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function bindFixMandate(
  input: DefaultFixEntry,
  target: FixTarget,
  github: GitHubOptions,
  publishBinding: PublishBinding,
  readHistory: () => Promise<DecodedHistory>,
): Promise<FixActionResult<BoundFixMandate>> {
  const authority = await decideFixAuthority({
    target,
    options: github,
    readHistory,
    branch: publishBinding.localBranch,
    base: publishBinding.defaultBranch,
    uw: input.uw,
    requiredFeatureMandate: input.requiredFeatureMandate,
  })
  if (!authority.ok) return authority
  return {
    ok: true,
    value: {
      recordId: authority.value.mandate.recordId,
      sameScope: authority.value.sameScope,
      // Preserve the bound UW even when it shares the correction target's scope.
      uw: authority.value.uw,
    },
  }
}

/** Actual `/fix` ingress: fresh GH target/history binding, then standalone or review-bound correction. */
function defaultFixRequest(
  input: DefaultFixEntry,
  id: FixIdentity,
  invocation: { reference?: string; request: string },
  correctionScope: string,
  target: FixTarget,
  publishBinding: PublishBinding,
  mandate: BoundFixMandate,
): DefaultFixRequest {
  return {
    cwd: input.cwd,
    reference: invocation.reference,
    contextTarget: target,
    rawOperatorRequest:
      input.rawOperatorRequest ?? (input.reviewId === undefined ? { request: invocation.request } : null),
    scope: correctionScope,
    identity: id,
    publishBinding,
    authorityInputs: mandate.sameScope ? [mandate.recordId] : undefined,
    operations: input.operations,
    uw: mandate.uw,
  }
}

async function admitDefaultOwner(
  input: DefaultFixEntry,
  id: FixIdentity,
  fence: FixExecutionFence,
  request: DefaultFixRequest,
  target: FixTarget,
  binding: PublishBinding & { destination: Destination },
  mandate: BoundFixMandate,
  scope: Scope,
  github: GitHubOptions,
  gh: Gh,
  resolver: TargetResolver,
  readHistory: () => Promise<DecodedHistory>,
): Promise<FixActionResult<void>> {
  const initial = await observeFixOwnerAdmission({
    uw: mandate.uw,
    pullRequest: scope,
    destination: binding.destination,
    intent: 'fresh',
    github,
    reader: input.uw,
  })
  if (!initial.ok) return initial
  if (initial.value.admission.status !== 'fresh') return fail('fix-owner-admission-refused')
  const owner = reserveFixOwner(id, mandate.uw)
  const acquired = await acquireFixOwnerLease({
    destination: binding.destination,
    owner,
    priorNamespace: initial.value.admission.priorNamespace,
    fence,
  })
  if (!acquired.ok) return acquired
  const refreshedTarget = await resolver.resolveExplicit(target.target)
  if (!refreshedTarget.ok) return refreshedTarget
  if (refreshedTarget.value === null || canonicalValueDigest(refreshedTarget.value) !== canonicalValueDigest(target))
    return fail('fix-target-changed')
  const refreshedBinding = await resolvePublishBinding(input.cwd, gh, scope.repository, refreshedTarget.value)
  if (!refreshedBinding.ok) return refreshedBinding
  if (canonicalValueDigest(refreshedBinding.value) !== canonicalValueDigest(binding))
    return fail('fix-publish-binding-changed')
  const refreshedMandate = await bindFixMandate(input, target, github, refreshedBinding.value, readHistory)
  if (!refreshedMandate.ok) return refreshedMandate
  if (canonicalValueDigest(refreshedMandate.value) !== canonicalValueDigest(mandate)) return fail('fix-mandate-changed')
  request.openOwner = ({ target: preparedTarget, manifest, reservation }) =>
    openFreshFixOwner({
      identity: id,
      fence,
      uw: mandate.uw,
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

function runStandaloneDefaultFix(
  input: DefaultFixEntry,
  runtime: FixWorkflowRuntime,
  target: FixTarget,
  resolver: TargetResolver,
  publisher: RecordPublisher,
  request: DefaultFixRequest,
  readHistory: () => Promise<DecodedHistory>,
  github: GitHubOptions,
  binding: PublishBinding,
  mandate: BoundFixMandate,
): Promise<FixActionResult<FixRecord>> {
  let trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }> | undefined
  const capturingPublisher = captureConfirmedFixRequest(publisher, (record) => {
    trustedLiveRequest = record
  })
  runtime.bindContinuation?.(() =>
    confirmFixContinuation({
      target,
      options: github,
      readHistory,
      branch: binding.localBranch,
      base: binding.defaultBranch,
      uw: input.uw,
      boundRecordId: mandate.recordId,
      trustedLiveRequest,
    }),
  )
  return runDefaultFixWorkflow(
    {
      resolver,
      publisher: capturingPublisher,
      dispositionStore: createFixDispositionStore(mandate.uw, github),
      readHistory,
      github,
      workflow: input.workflow,
      native: input.native,
      runtime,
    },
    request,
  )
}

function parseDefaultRequest(input: DefaultFixEntry): FixActionResult<{
  invocation: { reference?: string; request: string }
  correctionScope: string
}> {
  const invocation = parseInvocation(input.args, input.reference)
  if (invocation.malformed) return fail('fix-reference-malformed')
  const correctionScope = input.scope ?? invocation.request
  if (correctionScope.length === 0 && input.rawOperatorRequest === undefined) return fail('fix-request-required')
  return { ok: true, value: { invocation, correctionScope } }
}

export async function runDefaultFix(
  input: DefaultFixEntry,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  const parsed = parseDefaultRequest(input)
  if (!parsed.ok) return parsed
  const { invocation, correctionScope } = parsed.value
  const suppliedGh = input.gh
  const gh: Gh =
    suppliedGh === undefined ? defaultGh : (cwd, args) => trackPreparationGhOperation(args, () => suppliedGh(cwd, args))
  const repository = await readRepository(input.cwd, gh)
  if (!repository.ok) return repository
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const resolver = createResolver(input.cwd, gh, repository.value, createIssueAliasReadPort(github))
  const resolved =
    invocation.reference === undefined
      ? { ok: true as const, value: await resolver.resolveContext() }
      : await resolver.resolveExplicit(invocation.reference)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (target === null) return fail('fix-target-required')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, repository.value, target)
  if (!publishBinding.ok) return publishBinding
  const scope = githubScope(repository.value, target.number)
  let originalScope: Scope | null = null
  const publisher = createDefaultPublisher(scope, github, runtime, () => originalScope)
  const readHistory = async () => decodeHistory(await readGitHubHistory(scope, github))
  const mandate = await bindFixMandate(input, target, github, publishBinding.value, readHistory)
  if (!mandate.ok) return mandate
  originalScope = mandate.value.uw
  const request = defaultFixRequest(input, id, invocation, correctionScope, target, publishBinding.value, mandate.value)
  if (runtime.executionFence !== undefined) {
    const admitted = await admitDefaultOwner(
      input,
      id,
      runtime.executionFence,
      request,
      target,
      publishBinding.value,
      mandate.value,
      scope,
      github,
      gh,
      resolver,
      readHistory,
    )
    if (!admitted.ok) return admitted
  }
  if (input.reviewId === undefined) {
    return runStandaloneDefaultFix(
      input,
      runtime,
      target,
      resolver,
      publisher,
      request,
      readHistory,
      github,
      publishBinding.value,
      mandate.value,
    )
  }
  return runReviewBoundDefaultFix(
    input,
    id,
    runtime,
    target,
    resolver,
    publisher,
    request,
    readHistory,
    input.reviewId,
    github,
    mandate.value,
  )
}
