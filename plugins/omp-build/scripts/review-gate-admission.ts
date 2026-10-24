import {
  decodeHistory,
  deriveReviewState,
  githubScope,
  type Json,
  type Result,
  readGitHubHistory,
  summarizeReviews,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { admitLanding } from '../skills/feature/proof-admission.ts'
import type { Gh, Git, Refusal } from '../skills/feature/proof-base.ts'
import { refreshSelectedBase } from '../skills/feature/proof-candidate.ts'
import type { Admission } from '../skills/feature/proof-context.ts'
import { currentLandingMandate, type LandingMandateRead } from '../skills/feature/workflow-mandate.js'
import {
  type Arguments,
  canonicalTaxonomy,
  ciState,
  jsonDetail,
  type MachineResult,
  scopedGh,
  scopedGit,
} from './review-gate-cli.ts'

const SHA = /^[0-9a-f]{40}$/

type Coordinates = { head: string; baseName: string; recordedBaseOid: string }
type ReviewSummary = ReturnType<typeof summarizeReviews>
type AcceptedSummary = Extract<ReviewSummary, { ok: true }>
type ReviewState = ReturnType<typeof deriveReviewState>
type AcceptedReviewState = Extract<ReviewState, { ok: true }>
type GateContext = {
  gh: Gh
  git: Git
  scope: ReturnType<typeof githubScope>
  taxonomy: string[]
  summary: AcceptedSummary
  coordinates: Coordinates
  baseTip: string
}
type InitialReview = GateContext | { refusal: MachineResult }

function proofResult(value: Admission): Result<Json> {
  if (value.ok) return { ok: true, value: value.proof as unknown as Json }
  return {
    ok: false,
    diagnostics: [
      { code: value.reason, message: value.error, detail: { producer: value.producer, reason: value.reason } },
    ],
  }
}

function currentHeadAndBase(raw: string): Coordinates {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('GitHub returned unreadable PR coordinates')
  }
  const fields = value as { headRefOid?: unknown; baseRefName?: unknown; baseRefOid?: unknown }
  if (
    !SHA.test(String(fields.headRefOid)) ||
    typeof fields.baseRefName !== 'string' ||
    fields.baseRefName.length === 0 ||
    !SHA.test(String(fields.baseRefOid))
  ) {
    throw new Error('GitHub returned incomplete PR coordinates')
  }
  return {
    head: fields.headRefOid as string,
    baseName: fields.baseRefName,
    recordedBaseOid: fields.baseRefOid as string,
  }
}

function baseRefusal(selectedBase: Refusal): MachineResult {
  return {
    ok: false,
    allowed: false,
    reason: 'base-unreadable',
    detail: { producer: selectedBase.producer, reason: selectedBase.reason, error: selectedBase.error },
  }
}

function reviewPolicy(args: Arguments, toolingRoot: string, gh: Gh) {
  return withRoxabiGitHubPolicy({ cwd: toolingRoot, automationLogin: args.automationLogin, gh })
}

async function landingMandate(
  toolingRoot: string,
  args: Arguments,
  gh: Gh,
  git: Git,
  coordinates: Coordinates,
  baseTip: string,
): Promise<{ mandate?: LandingMandateRead; error?: unknown }> {
  try {
    return {
      mandate: await currentLandingMandate(
        toolingRoot,
        args.pr,
        gh,
        { head: args.head, base: coordinates.baseName, baseTip },
        git,
        args.candidateCwd,
      ),
    }
  } catch (error) {
    return { error }
  }
}

async function readInitialReview(args: Arguments, toolingRoot: string): Promise<InitialReview> {
  const gh = scopedGh(toolingRoot, args.repository)
  const git = scopedGit(args.candidateCwd)
  const scope = githubScope(args.repository, args.pr)
  const taxonomy = canonicalTaxonomy(toolingRoot)
  const history = await readGitHubHistory(scope, reviewPolicy(args, toolingRoot, gh))
  const summary = summarizeReviews(decodeHistory(history), taxonomy, null)
  if (!summary.ok)
    return { refusal: { ok: false, allowed: false, reason: 'review-history-refused', detail: summary.diagnostics } }
  const coordinates = currentHeadAndBase(
    await gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
  )
  if (coordinates.head !== args.head) return { refusal: { ok: false, allowed: false, reason: 'current-head-mismatch' } }
  void coordinates.recordedBaseOid
  const selectedBase = await refreshSelectedBase(args.candidateCwd, coordinates.baseName, git, gh)
  if (!selectedBase.ok) return { refusal: baseRefusal(selectedBase) }
  return { gh, git, scope, taxonomy, summary, coordinates, baseTip: selectedBase.tip }
}

function nativeAutoMergePending(
  state: AcceptedReviewState,
  head: string,
  ci: 'green' | 'red' | 'pending' | 'unknown',
): boolean {
  return (
    state.next === 'wait' &&
    state.requiredStop === null &&
    state.summary.head === head &&
    state.summary.verdict?.startsWith('Approve') === true &&
    ci === 'pending'
  )
}

function reviewStateRefusal(
  state: ReviewState,
  refreshed: AcceptedSummary,
  args: Arguments,
  admission: Admission,
  ci: 'green' | 'red' | 'pending' | 'unknown',
  mandateRead: Awaited<ReturnType<typeof landingMandate>>,
): MachineResult | null {
  if (!state.ok) return { ok: false, allowed: false, reason: 'review-history-refused', detail: state.diagnostics }
  if (state.requiredStop !== null)
    return {
      ok: false,
      allowed: false,
      reason: state.requiredStop.reason,
      detail: { reviewId: state.requiredStop.reviewId, detail: state.requiredStop.detail },
    }
  if (refreshed.value.head !== args.head) return { ok: false, allowed: false, reason: 'reviewed-head-mismatch' }
  if (mandateRead.error !== undefined)
    return {
      ok: false,
      allowed: false,
      reason: 'unreadable',
      detail: mandateRead.error instanceof Error ? mandateRead.error.message : String(mandateRead.error),
    }
  if (!mandateRead.mandate?.admitted)
    return {
      ok: false,
      allowed: false,
      reason: mandateRead.mandate?.reason ?? 'unknown-binding',
      detail: jsonDetail(mandateRead.mandate?.evidence),
    }
  if (!admission.ok)
    return {
      ok: false,
      allowed: false,
      reason: 'proof-refused',
      detail: { producer: admission.producer, reason: admission.reason },
    }
  if (state.next !== 'admit' && !nativeAutoMergePending(state, args.head, ci))
    return { ok: false, allowed: false, reason: `review-state-${state.next}` }
  return null
}

async function postAdmissionRefusal(
  args: Arguments,
  toolingRoot: string,
  context: GateContext,
  admission: Admission,
  ci: 'green' | 'red' | 'pending' | 'unknown',
  mandateRead: Awaited<ReturnType<typeof landingMandate>>,
): Promise<MachineResult | null> {
  const refreshedHistory = await readGitHubHistory(context.scope, reviewPolicy(args, toolingRoot, context.gh))
  const refreshed = summarizeReviews(decodeHistory(refreshedHistory), context.taxonomy, null)
  if (!refreshed.ok)
    return { ok: false, allowed: false, reason: 'review-history-refused', detail: refreshed.diagnostics }
  if (JSON.stringify(refreshed.value) !== JSON.stringify(context.summary.value))
    return { ok: false, allowed: false, reason: 'review-inputs-moved' }
  const state = deriveReviewState(
    decodeHistory(refreshedHistory),
    {
      repository: args.repository,
      target: `${args.repository}#${args.pr}`,
      candidateGitSHA: args.head,
      input: refreshed.value.input,
      proofAdmission: proofResult(admission),
      ci,
      acceptedEvidencePolicyRef: null,
    },
    context.taxonomy,
  )
  const fresh = currentHeadAndBase(
    await context.gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
  )
  if (fresh.head !== args.head || fresh.baseName !== context.coordinates.baseName)
    return { ok: false, allowed: false, reason: 'pr-coordinates-moved' }
  void fresh.recordedBaseOid
  const freshBase = await refreshSelectedBase(args.candidateCwd, fresh.baseName, context.git, context.gh)
  if (!freshBase.ok) return baseRefusal(freshBase)
  if (freshBase.tip !== context.baseTip) return { ok: false, allowed: false, reason: 'pr-coordinates-moved' }
  const refusal = reviewStateRefusal(state, refreshed, args, admission, ci, mandateRead)
  if (refusal !== null) return refusal
  const lastMandate = await currentLandingMandate(
    toolingRoot,
    args.pr,
    context.gh,
    { head: fresh.head, base: fresh.baseName, baseTip: freshBase.tip },
    context.git,
    args.candidateCwd,
  )
  if (!lastMandate.admitted)
    return { ok: false, allowed: false, reason: lastMandate.reason, detail: jsonDetail(lastMandate.evidence) }
  return null
}

export async function admitReviewGate(args: Arguments, toolingRoot: string): Promise<MachineResult> {
  const initial = await readInitialReview(args, toolingRoot)
  if ('refusal' in initial) return initial.refusal
  const mandateRead = await landingMandate(
    toolingRoot,
    args,
    initial.gh,
    initial.git,
    initial.coordinates,
    initial.baseTip,
  )
  const admission = await admitLanding(
    args.candidateCwd,
    {
      pr: args.pr,
      candidate: args.head,
      base: initial.coordinates.baseName,
      baseTip: initial.baseTip,
      reviewedAt: initial.summary.value.at,
      reviewInput: initial.summary.value.input,
      ...(mandateRead.mandate?.admitted ? { proofPins: mandateRead.mandate.proofPins } : {}),
    },
    { gh: initial.gh, git: initial.git },
  )
  const ci = await ciState(toolingRoot, initial.gh, args.pr)
  const refusal = await postAdmissionRefusal(args, toolingRoot, initial, admission, ci, mandateRead)
  if (refusal !== null) return refusal
  return { ok: true, allowed: true, reviews: initial.summary.value.reviews, ci }
}
