import { decodeHistory, readGitHubHistory } from '../../dist/contracts.js'
import { PR_BODY_QUERY } from '../../host/preparation-graphql.cjs'
import { type ConfirmedReviewSemanticContext, confirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context'
import type { ReviewRootRef, TrustedHostPluginPin, UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { currentActionFingerprint, storedReviewExpansion } from '../../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../../roxabi/uw-input-readers.ts'
import { selectedReviewRoot } from '../../roxabi/uw-selected-review.ts'
import { type Gh, isMap, jsonField, type Refusal, refuse, repositoryOf } from './review-base.ts'

export type ReviewPrBody = { body: string; lastEditedAt: string | null }
export type ReviewTarget = {
  pr: number
  candidate: string
  base: string | undefined
}
export type ReviewInputDeps = {
  gh: Gh
  automationLogin?: string
  semantic?: ConfirmedReviewSemanticContext
  pluginPin?: TrustedHostPluginPin
  persistedFingerprint?: string
  selectedReviewId?: string | null
  reviewedRoot?: ReviewRootRef
}
type ReviewInputCapture = { ok: true; input: string | null } | Refusal

/** Current body and native edit metadata from one response, without tightening the existing date policy. */
export async function readPrBody(cwd: string, pr: number, gh: Gh, repository: string): Promise<ReviewPrBody> {
  const [owner, name] = repository.split('/')
  const raw = await gh(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${PR_BODY_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pr}`,
  ])
  const data = jsonField(raw, 'data')
  const repo = isMap(data) ? data.repository : undefined
  const pull = isMap(repo) ? repo.pullRequest : undefined
  const body = isMap(pull) ? pull.body : undefined
  const edited = isMap(pull) ? pull.lastEditedAt : undefined
  if (
    typeof body !== 'string' ||
    (edited !== null && (typeof edited !== 'string' || Number.isNaN(Date.parse(edited))))
  ) {
    throw new Error(`the body of PR #${pr} could not be read — ${raw.slice(0, 200)}`)
  }
  return { body, lastEditedAt: edited }
}

async function pullRequestBranch(cwd: string, pr: number, gh: Gh, repository: string): Promise<string | Refusal> {
  const raw = await gh(cwd, ['pr', 'view', String(pr), '--repo', repository, '--json', 'headRefName'])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('unreadable', `PR #${pr} branch could not be read`)
  }
  if (!isMap(parsed) || typeof parsed.headRefName !== 'string' || parsed.headRefName.length === 0) {
    return refuse('unreadable', `PR #${pr} has no head branch`)
  }
  return parsed.headRefName
}

async function loadSemantic(
  cwd: string,
  target: Pick<ReviewTarget, 'pr' | 'base'>,
  deps: ReviewInputDeps,
  repository: string,
  body: string,
): Promise<ConfirmedReviewSemanticContext | Refusal> {
  if (deps.semantic) return deps.semantic
  const branch = await pullRequestBranch(cwd, target.pr, deps.gh, repository)
  if (typeof branch !== 'string') return branch
  if (target.base === undefined || target.base.length === 0) {
    return refuse('unreadable', `PR #${target.pr} has no base branch`)
  }
  const resolved = await resolveReviewSemanticContext({
    cwd,
    repository,
    pr: target.pr,
    body,
    branch,
    base: target.base,
    automationLogin: deps.automationLogin,
    gh: deps.gh,
  })
  if (!resolved.ok) {
    const diagnostic = resolved.diagnostics[0]
    const code = typeof diagnostic?.code === 'string' ? diagnostic.code : ''
    const message = typeof diagnostic?.message === 'string' ? diagnostic.message : ''
    return refuse(code.endsWith('unreadable') ? 'unreadable' : 'unbound', message || 'review semantic context refused')
  }
  return confirmedReviewSemanticContext(resolved.value)
}
async function reviewExpansion(
  cwd: string,
  target: Pick<ReviewTarget, 'pr' | 'candidate' | 'base'>,
  repository: string,
  deps: ReviewInputDeps,
): Promise<
  | {
      expandedContext: UwActionRequest['expandedContext']
      stageSources: UwActionRequest['stageSources']
      reviewedRoot?: ReviewRootRef
    }
  | Refusal
> {
  if (deps.persistedFingerprint !== undefined) {
    const pullRequest = { repository, target: `${repository}#${target.pr}` }
    const history = decodeHistory(
      await readGitHubHistory(pullRequest, { cwd, gh: deps.gh, readAuthor: deps.automationLogin }),
    )
    const selected =
      deps.reviewedRoot === undefined
        ? deps.selectedReviewId == null
          ? null
          : selectedReviewRoot(history, deps.selectedReviewId)
        : { ok: true as const, value: deps.reviewedRoot }
    if (selected === null || !selected.ok) return refuse('review-input-changed', 'selected review root is unavailable')
    const stored = storedReviewExpansion(history, deps.persistedFingerprint, selected.value)
    if (!stored.ok)
      return refuse(
        'review-input-changed',
        stored.diagnostics.map((item) => item.message).join('; ') || 'reviewed action inputs are absent',
      )
    return { ...stored.value, reviewedRoot: selected.value }
  }
  return { expandedContext: [], stageSources: [] }
}

/** Capture the current action-input digest. The PR body is display-only and is not hashed. */
export async function captureReviewInput(
  cwd: string,
  target: Pick<ReviewTarget, 'pr' | 'candidate' | 'base'>,
  deps: ReviewInputDeps,
): Promise<ReviewInputCapture> {
  const repository = await repositoryOf(deps.gh, cwd)
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  const semantic = await loadSemantic(cwd, target, deps, repository, body.body)
  if ('ok' in semantic) return semantic
  let viewed: unknown
  try {
    viewed = JSON.parse(
      await deps.gh(cwd, ['pr', 'view', String(target.pr), '--repo', repository, '--json', 'headRefOid,baseRefName']),
    )
  } catch {
    return refuse('unreadable', `PR #${target.pr} head could not be read`)
  }
  if (
    !isMap(viewed) ||
    typeof viewed.headRefOid !== 'string' ||
    viewed.headRefOid !== target.candidate ||
    target.base === undefined
  )
    return refuse('unbound', 'the review head changed; start a fresh review')

  const pullRequest = { repository, target: `${repository}#${target.pr}` }
  const expansion = await reviewExpansion(cwd, target, repository, deps)
  if ('ok' in expansion) return expansion
  const { expandedContext, stageSources } = expansion
  const request: UwActionRequest = {
    actionId: `review-${target.pr}`,
    purpose: 'review',
    subject:
      semantic.mode === 'standalone'
        ? { kind: 'standalone-pr', pullRequest }
        : { kind: 'uw', uw: semantic.scope, pullRequest, binding: null },
    code: { repository, base: target.base, head: viewed.headRefOid, referenceCommit: viewed.headRefOid },
    stageSources,
    expandedContext,
  }
  const fingerprint = await currentActionFingerprint(
    request,
    createProductionActionPorts({ cwd, gh: deps.gh, readAuthor: deps.automationLogin, pluginPin: deps.pluginPin }),
    deps.persistedFingerprint,
    expansion.reviewedRoot,
  )
  if (!fingerprint.ok) {
    const reason = fingerprint.diagnostics.some((item) => item.code === 'review-input-changed')
      ? 'review-input-changed'
      : 'unreadable'
    return refuse(reason, fingerprint.diagnostics.map((item) => item.message).join('; '))
  }
  return { ok: true, input: fingerprint.value }
}
