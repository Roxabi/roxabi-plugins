import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context'
import { type Gh, isMap, isRecord, jsonField, type Refusal, refuse, repositoryOf } from './proof-base'
import {
  type Deps,
  type PrBody,
  type ProofSemanticContext,
  proofSemanticContext,
  type ReviewSnapshot,
} from './proof-context'
import { hashReviewInput } from './proof-context-hash'
import type { Target } from './proof-review-contract'

const PR_BODY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { body lastEditedAt }
  }
}`

/** Current body and native edit metadata from one response, without tightening the existing date policy. */
export async function readPrBody(cwd: string, pr: number, gh: Gh, repository: string): Promise<PrBody> {
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

export async function pullRequestBranch(
  cwd: string,
  pr: number,
  gh: Gh,
  repository: string,
): Promise<string | Refusal> {
  const raw = await gh(cwd, ['pr', 'view', String(pr), '--repo', repository, '--json', 'headRefName'])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('candidate', 'unreadable', `PR #${pr} branch could not be read`)
  }
  if (!isRecord(parsed) || typeof parsed.headRefName !== 'string' || parsed.headRefName.length === 0) {
    return refuse('candidate', 'unreadable', `PR #${pr} has no head branch`)
  }
  return parsed.headRefName
}

export async function loadSemantic(
  cwd: string,
  target: Pick<Target, 'pr' | 'base'>,
  deps: Deps,
  repository: string,
  body: string,
): Promise<ProofSemanticContext | Refusal> {
  if (deps.semantic) return deps.semantic
  const branch = await pullRequestBranch(cwd, target.pr, deps.gh, repository)
  if (typeof branch !== 'string') return branch
  if (target.base === undefined || target.base.length === 0) {
    return refuse('candidate', 'unreadable', `PR #${target.pr} has no base branch`)
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
    return refuse(
      'candidate',
      code.endsWith('unreadable') ? 'unreadable' : 'unbound',
      message.length > 0 ? message : 'review semantic context refused',
    )
  }
  return proofSemanticContext(resolved.value)
}

export type CaptureReviewInput = ReviewSnapshot | Refusal

/** Capture the current review input without reading producer configuration or history. */
export async function captureReviewInput(
  cwd: string,
  target: Pick<Target, 'pr' | 'candidate' | 'base' | 'baseTip'>,
  deps: Deps,
): Promise<CaptureReviewInput> {
  const repository = await repositoryOf(deps.gh, cwd)
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  const semantic = await loadSemantic(cwd, target, deps, repository, body.body)
  if ('ok' in semantic) return semantic
  return {
    ok: true,
    input: hashReviewInput(repository, target, body, semantic),
    body,
  }
}
