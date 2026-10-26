import { createHash } from 'node:crypto'
import {
  type ConfirmedReviewSemanticContext,
  confirmedReviewSemanticContext,
  reviewSemanticCanon,
} from '../../roxabi/review-semantic-canon'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context'
import { type Gh, isMap, jsonField, type Refusal, refuse, repositoryOf } from './review-base'

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
}
export type ReviewInputCapture = { ok: true; input: string | null; body: ReviewPrBody | null } | Refusal

/** Exact observed review inputs and the shared semantic canon. */
export function hashReviewInput(
  repository: string,
  target: Pick<ReviewTarget, 'pr' | 'candidate'>,
  body: ReviewPrBody,
  semantic: ConfirmedReviewSemanticContext,
): string {
  const bytes = JSON.stringify([
    'omp-build:review-input/3',
    repository,
    target.pr,
    target.candidate,
    [body.body, body.lastEditedAt],
    reviewSemanticCanon(semantic),
  ])
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
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

/** Capture the current review input without reading producer configuration or history. */
export async function captureReviewInput(
  cwd: string,
  target: Pick<ReviewTarget, 'pr' | 'candidate' | 'base'>,
  deps: ReviewInputDeps,
): Promise<ReviewInputCapture> {
  const repository = await repositoryOf(deps.gh, cwd)
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  const semantic = await loadSemantic(cwd, target, deps, repository, body.body)
  if ('ok' in semantic) return semantic
  return { ok: true, input: hashReviewInput(repository, target, body, semantic), body }
}
