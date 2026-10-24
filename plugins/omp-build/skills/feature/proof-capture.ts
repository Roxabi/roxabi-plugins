import type { DecodedHistory } from '../../dist/contracts.js'
import { decodeHistory, githubScope, readGitHubHistory } from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context'
import { assertledgerApplies } from './proof-assertledger'
import { type Gh, isMap, isRecord, jsonField, type Producer, type Refusal, refuse, repositoryOf } from './proof-base'
import { candidateFacts } from './proof-candidate'
import type { CandidateFacts } from './proof-candidate-contract'
import {
  type Deps,
  type PrBody,
  type ProofSemanticContext,
  proofSemanticContext,
  type ReviewSnapshot,
} from './proof-context'
import { acquireCommand, hashReviewInput } from './proof-context-hash'
import { findProofRecord } from './proof-records'
import type { SelectedRecord, Target } from './proof-review-contract'

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

type ProofSelections = { semctx: SelectedRecord | null; assertledger: SelectedRecord | null }

function selectProofRecord(
  history: DecodedHistory,
  producer: Producer,
  candidate: string,
  pr: number,
): SelectedRecord | Refusal {
  const found = findProofRecord(history, producer, candidate)
  if ('missing' in found) {
    const extra = producer === 'assertledger' ? ' --assertledger-manifest <manifest.json>' : ''
    return refuse(producer, 'missing', `${found.missing}. Produce it outside admission: ${acquireCommand(pr, extra)}`)
  }
  if ('unreadable' in found) return refuse(producer, 'unreadable', found.unreadable)
  if (found.parts.some((part) => !Number.isSafeInteger(part.id) || Number(part.id) < 1)) {
    return refuse(producer, 'unreadable', 'the selected producer publication has no readable native comment identity')
  }
  return found
}

async function captureProofSelections(
  cwd: string,
  target: Pick<Target, 'pr' | 'candidate'>,
  deps: Deps,
  repository: string,
  facts: CandidateFacts,
  ledger: boolean,
): Promise<ProofSelections | Refusal> {
  if (facts.semctx !== 'configured' && !ledger) return { semctx: null, assertledger: null }
  const history = decodeHistory(
    await readGitHubHistory(
      githubScope(repository, target.pr),
      withRoxabiGitHubPolicy({ cwd, gh: deps.gh, automationLogin: deps.automationLogin }),
    ),
  )
  if (!history.source.complete) {
    return refuse('candidate', 'unreadable', `the complete common proof history for PR #${target.pr} could not be read`)
  }
  const semctx =
    facts.semctx === 'configured' ? selectProofRecord(history, 'semctx', target.candidate, target.pr) : null
  if (semctx && 'ok' in semctx) return semctx
  const assertledger = ledger ? selectProofRecord(history, 'assertledger', target.candidate, target.pr) : null
  if (assertledger && 'ok' in assertledger) return assertledger
  return { semctx, assertledger }
}

/**
 * The landing admission for the selected PR's current candidate. Reads only;
 * a refusal names what must be produced outside admission. Transport failures
 * (`gh`) throw: an unreadable source authorizes nothing. Semctx absence makes
 * only Semctx non-applicable; the assertledger requirement is decided apart.
 * Neither skip is a semantic binding: every review hashes the shared canon,
 * and proof parts may be empty.
 */
export async function captureReviewInput(
  cwd: string,
  target: Pick<Target, 'pr' | 'candidate' | 'base' | 'baseTip'>,
  deps: Deps,
): Promise<CaptureReviewInput> {
  const facts = await candidateFacts(cwd, target.candidate, target.base, target.baseTip, deps.git)
  if ('ok' in facts) return facts
  const repository = await repositoryOf(deps.gh, cwd)
  const ledger = await assertledgerApplies(cwd, facts, target, deps, repository)
  if (typeof ledger === 'object') return ledger
  const selections = await captureProofSelections(cwd, target, deps, repository, facts, ledger)
  if ('ok' in selections) return selections
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  const semantic = await loadSemantic(cwd, target, deps, repository, body.body)
  if ('ok' in semantic) return semantic
  return {
    ok: true,
    input: hashReviewInput(
      repository,
      target,
      body,
      selections.semctx?.parts ?? null,
      selections.assertledger?.parts ?? null,
      semantic,
    ),
    body,
    facts,
    read: { repository },
    ...selections,
  }
}
