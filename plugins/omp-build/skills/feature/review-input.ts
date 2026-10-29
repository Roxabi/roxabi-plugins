import { actionInputDigest, decodeHistory, readGitHubHistory, validateActionInputs } from '../../dist/contracts.js'
import type { ActionInputManifest, ActionInputs } from '../../engine/action-input-schema.ts'
import { type ConfirmedReviewSemanticContext, confirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context'
import type { TrustedHostPluginPin, UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { currentActionFingerprint, storedReviewExpansion } from '../../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../../roxabi/uw-input-readers.ts'
import { type Gh, isMap, jsonField, type Refusal, refuse, repositoryOf } from './review-base.ts'

const PR_BODY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { body lastEditedAt }
  }
}`

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
  preparedSnapshot?: ActionInputs
}
export type ReviewInputCapture = { ok: true; input: string | null; body: ReviewPrBody | null } | Refusal

/** Action-input digest. PR prose and the semantic canon are not part of the fingerprint. */
export function hashReviewInput(manifest: ActionInputManifest): string {
  return actionInputDigest(manifest)
}

/** Current body and native edit metadata from one response, without tightening the existing date policy. */
export async function readPrBody(cwd: string, pr: number, gh: Gh, repository: string): Promise<ReviewPrBody> {
  const [owner, name] = repository.split('/')
  const raw = await gh(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${PR_BODY}`,
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
  { expandedContext: UwActionRequest['expandedContext']; stageSources: UwActionRequest['stageSources'] } | Refusal
> {
  if (deps.preparedSnapshot !== undefined) {
    const parsed = validateActionInputs(deps.preparedSnapshot)
    const snapshot = parsed.ok ? parsed.value : null
    const scope = snapshot?.manifest.subject.pullRequest
    if (
      deps.persistedFingerprint !== undefined ||
      snapshot === null ||
      snapshot.manifest.purpose !== 'review' ||
      snapshot.manifest.code.repository !== repository ||
      snapshot.manifest.code.head !== target.candidate ||
      snapshot.manifest.code.base !== target.base ||
      scope?.repository !== repository ||
      scope.target !== `${repository}#${target.pr}` ||
      actionInputDigest(snapshot.manifest) !== snapshot.fingerprint
    )
      return refuse('review-input-changed', 'prepared review snapshot does not match the selected PR and code')
    return { expandedContext: snapshot.manifest.expandedContext, stageSources: snapshot.stageSources }
  }
  if (deps.persistedFingerprint !== undefined) {
    const pullRequest = { repository, target: `${repository}#${target.pr}` }
    const history = decodeHistory(
      await readGitHubHistory(pullRequest, { cwd, gh: deps.gh, readAuthor: deps.automationLogin }),
    )
    const stored = storedReviewExpansion(history, deps.persistedFingerprint)
    if (!stored.ok)
      return refuse(
        'review-input-changed',
        stored.diagnostics.map((item) => item.message).join('; ') || 'reviewed action inputs are absent',
      )
    return stored.value
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
  )
  if (!fingerprint.ok) return refuse('unreadable', fingerprint.diagnostics.map((item) => item.message).join('; '))
  return { ok: true, input: fingerprint.value, body }
}
