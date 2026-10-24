import type { CanonicalRecord, DecodedHistory, GitHubOptions, Json, ScopedRecordRef } from '../dist/contracts.js'
import { decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixTarget,
  NativePort,
  PublishBinding,
  RecordPublisher,
  ReviewAuthority,
} from './fix-contract.ts'
import type { DebtEvidence } from './fix-domain'
import { runReviewBoundDefaultFix } from './fix-entry-review-bound.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { defaultGh, fail, type Gh, gitResult, object, targetEditedAt } from './fix-entry-target-core.ts'
import { createResolver, parseInvocation } from './fix-entry-target-resolver.ts'
import type { DefaultFixRequest } from './fix-execution-policy.ts'
import { runDefaultFixWorkflow } from './fix-execution-runner.ts'
import {
  confirmFixContinuation,
  confirmPublishedMandate,
  decideFixAuthority,
  loadFixOnlyDraft,
} from './fix-mandate-authority.ts'
import { buildConfirmedFixOnlyMandate } from './fix-mandate-resolution.ts'
import type { FixMandateView } from './fix-mandate-types.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'

export { boundDecision, confirmedRecord } from './fix-entry-review-bound.ts'
export type DefaultFixEntry = {
  cwd: string
  args?: string
  reference?: string
  scope?: string
  rawOperatorRequest?: Json
  reviewId?: string
  requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  contextWindow?: number
  debtEvidence?: DebtEvidence
  native: NativePort
  workflow: ReviewAuthority
  github?: GitHubOptions
  gh?: Gh
}

type BoundFixMandate = { recordId: string; sameScope: boolean }

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
  id: FixIdentity,
  target: FixTarget,
  github: GitHubOptions,
  publishBinding: PublishBinding,
  correctionScope: string,
  readHistory: () => Promise<DecodedHistory>,
  publishMandate: (record: CanonicalRecord) => Promise<FixActionResult<unknown>>,
): Promise<FixActionResult<BoundFixMandate>> {
  const authority = await decideFixAuthority({
    target,
    options: github,
    readHistory,
    branch: publishBinding.localBranch,
    base: publishBinding.defaultBranch,
    correctionScope,
    requiredFeatureMandate: input.requiredFeatureMandate,
  })
  if (!authority.ok) return authority
  if (input.requiredFeatureMandate !== undefined && authority.value.status !== 'reuse')
    return fail('feature-mandate-required')
  if (authority.value.status === 'reuse') {
    return { ok: true, value: { recordId: authority.value.mandate.recordId, sameScope: authority.value.sameScope } }
  }
  const editedAt = await targetEditedAt(input.cwd, input.gh ?? defaultGh, target)
  const commit = target.candidateGitSHA
  if (editedAt === null || commit === null || correctionScope.length === 0) return fail('fix-only-scope-unreadable')
  const antecedent =
    authority.value.status === 'successor'
      ? {
          scope: { repository: authority.value.antecedent.repository, target: authority.value.antecedent.target },
          recordId: authority.value.antecedent.recordId,
          kind: 'mandate',
        }
      : null
  const parent: FixMandateView['parent'] =
    authority.value.status === 'successor' ? authority.value.antecedent.parent : null
  const draft = await loadFixOnlyDraft({
    cwd: input.cwd,
    commit,
    git: gitResult,
    scope: { repository: target.repository, target: target.target },
    recordId: `${id.runId}-mandate-1`,
    runId: id.runId,
    operationId: `${id.operationId}-mandate`,
    branch: publishBinding.localBranch,
    base: publishBinding.defaultBranch,
    candidateGitSHA: commit,
    work: { reference: target.target, body: correctionScope, lastEditedAt: editedAt },
    parent,
    antecedent,
  })
  if (!draft.ok) return draft
  const built = await buildConfirmedFixOnlyMandate(draft.value)
  if (!built.ok) return built
  const saved = await publishMandate(built.value)
  if (!saved.ok) return saved
  const confirmed = confirmPublishedMandate(await readHistory(), built.value.recordId)
  return confirmed.ok ? { ok: true, value: { recordId: confirmed.value.recordId, sameScope: true } } : confirmed
}

/** Actual `/fix` ingress: fresh GH target/history binding, then standalone or review-bound correction. */
export async function runDefaultFix(
  input: DefaultFixEntry,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  const gh = input.gh ?? defaultGh
  const repository = await readRepository(input.cwd, gh)
  if (!repository.ok) return repository
  const invocation = parseInvocation(input.args, input.reference)
  if (invocation.malformed) return fail('fix-reference-malformed')
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
    publish: async (record) => {
      const saved = await rawPublisher.publish(record)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  if (input.reviewId === undefined && invocation.request.length === 0 && input.rawOperatorRequest === undefined)
    return fail('fix-request-required')
  const correctionScope = input.scope ?? invocation.request
  const readHistory = async () => decodeHistory(await readGitHubHistory(scope, github))
  const mandate = await bindFixMandate(
    input,
    id,
    target,
    github,
    publishBinding.value,
    correctionScope,
    readHistory,
    async (record) => {
      const saved = await rawPublisher.publish(record)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  )
  if (!mandate.ok) return mandate
  const request = {
    cwd: input.cwd,
    reference: invocation.reference,
    contextTarget: target,
    rawOperatorRequest:
      input.rawOperatorRequest ?? (input.reviewId === undefined ? { request: invocation.request } : null),
    scope: correctionScope,
    identity: id,
    debtEvidence: input.debtEvidence,
    publishBinding: publishBinding.value,
    authorityInputs: mandate.value.sameScope ? [mandate.value.recordId] : undefined,
  } satisfies DefaultFixRequest
  if (input.reviewId === undefined) {
    runtime.bindContinuation?.(() =>
      confirmFixContinuation({
        target,
        options: github,
        readHistory,
        branch: publishBinding.value.localBranch,
        base: publishBinding.value.defaultBranch,
        correctionScope,
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
