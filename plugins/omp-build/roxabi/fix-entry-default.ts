import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixTarget,
  PublishBinding,
  RecordPublisher,
} from './fix-contract.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { runReviewBoundDefaultFix } from './fix-entry-review-bound.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { defaultGh, fail, type Gh, object } from './fix-entry-target-core.ts'
import { createResolver, parseInvocation } from './fix-entry-target-resolver.ts'
import type { DefaultFixRequest } from './fix-execution-policy.ts'
import { runDefaultFixWorkflow } from './fix-execution-runner.ts'
import { confirmFixContinuation, decideFixAuthority } from './fix-mandate-authority.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'

type BoundFixMandate = { recordId: string; sameScope: boolean; uw?: Scope }

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
  if (input.requiredFeatureMandate !== undefined && authority.value.status !== 'reuse')
    return fail('feature-mandate-required')
  if (authority.value.status === 'reuse') {
    const uw = authority.value.uw
    const distinct = uw.repository !== target.repository || uw.target !== target.target
    return {
      ok: true,
      value: {
        recordId: authority.value.mandate.recordId,
        sameScope: authority.value.sameScope,
        ...(distinct ? { uw } : {}),
      },
    }
  }
  return fail('fix-own-uw-required')
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
    debtEvidence: input.debtEvidence,
    publishBinding,
    authorityInputs: mandate.sameScope ? [mandate.recordId] : undefined,
    operations: input.operations,
    ...(mandate.uw === undefined ? {} : { uw: mandate.uw }),
  }
}

export async function runDefaultFix(
  input: DefaultFixEntry,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  const invocation = parseInvocation(input.args, input.reference)
  if (invocation.malformed) return fail('fix-reference-malformed')
  const correctionScope = input.scope ?? invocation.request
  if (correctionScope.length === 0 && input.rawOperatorRequest === undefined) return fail('fix-request-required')
  const gh = input.gh ?? defaultGh
  const repository = await readRepository(input.cwd, gh)
  if (!repository.ok) return repository
  const resolver = createResolver(input.cwd, gh, repository.value)
  const target =
    invocation.reference === undefined
      ? await resolver.resolveContext()
      : await resolver.resolveExplicit(invocation.reference)
  if (target === null) return fail('fix-target-required')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, repository.value, target)
  if (!publishBinding.ok) return publishBinding
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const scope = githubScope(repository.value, target.number)
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  const publisher: RecordPublisher = {
    publish: async (record, canPublish) => {
      const saved = await rawPublisher.publish(record, [], canPublish)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  const readHistory = async () => decodeHistory(await readGitHubHistory(scope, github))
  const mandate = await bindFixMandate(input, target, github, publishBinding.value, readHistory)
  if (!mandate.ok) return mandate
  const request = defaultFixRequest(input, id, invocation, correctionScope, target, publishBinding.value, mandate.value)
  if (input.reviewId === undefined) {
    runtime.bindContinuation?.(() =>
      confirmFixContinuation({
        target,
        options: github,
        readHistory,
        branch: publishBinding.value.localBranch,
        base: publishBinding.value.defaultBranch,
        uw: input.uw,
        boundRecordId: mandate.value.recordId,
      }),
    )
    return runDefaultFixWorkflow(
      { resolver, publisher, readHistory, workflow: input.workflow, native: input.native, runtime },
      request,
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
