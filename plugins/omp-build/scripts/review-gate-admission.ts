import type { DecodedHistory } from '../dist/contracts.js'
import {
  decodeHistory,
  deriveReviewState,
  githubScope,
  readGitHubHistory,
  recordIntegrity,
  selectedReviewOperations,
  summarizeReviews,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { type Gh, type Git, type Refusal, refreshReviewBase } from '../skills/feature/review-base.ts'
import { currentLandingMandate, type LandingMandateRead } from '../skills/feature/workflow-mandate.js'
import { validateLandingReviewInput } from '../skills/feature/workflow-review-input.js'
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
    detail: { reason: selectedBase.reason, error: selectedBase.error },
  }
}

function selectedReviewIntegrity(history: DecodedHistory, summary: AcceptedSummary): MachineResult | null {
  const operations = selectedReviewOperations(history, summary.value)
  if (operations === null)
    return {
      ok: false,
      allowed: false,
      reason: 'record-unreadable',
      detail: 'selected review attempt has no readable native operation',
    }
  for (const operation of operations) {
    if (operation.record === null)
      return {
        ok: false,
        allowed: false,
        reason: 'record-unreadable',
        detail: 'selected review attempt has no readable native operation',
      }
    const refusal = recordIntegrity(operation.parts, operation.record)
    if (refusal !== null) return { ok: false, allowed: false, reason: refusal.reason, detail: refusal.detail }
  }
  return null
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
        { head: args.head, base: coordinates.baseName, baseTip, automationLogin: args.automationLogin },
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
  const history = decodeHistory(await readGitHubHistory(scope, reviewPolicy(args, toolingRoot, gh)))
  const summary = summarizeReviews(history, taxonomy, null)
  if (!summary.ok)
    return { refusal: { ok: false, allowed: false, reason: 'review-history-refused', detail: summary.diagnostics } }
  const integrity = selectedReviewIntegrity(history, summary)
  if (integrity !== null) return { refusal: integrity }
  const coordinates = currentHeadAndBase(
    await gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
  )
  if (coordinates.head !== args.head) return { refusal: { ok: false, allowed: false, reason: 'current-head-mismatch' } }
  void coordinates.recordedBaseOid
  const selectedBase = await refreshReviewBase(args.candidateCwd, coordinates.baseName, git, gh)
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
  if (state.next !== 'admit' && !nativeAutoMergePending(state, args.head, ci))
    return { ok: false, allowed: false, reason: `review-state-${state.next}` }
  return null
}

async function postAdmissionRefusal(
  args: Arguments,
  toolingRoot: string,
  context: GateContext,
  ci: 'green' | 'red' | 'pending' | 'unknown',
  mandateRead: Awaited<ReturnType<typeof landingMandate>>,
): Promise<MachineResult | null> {
  const refreshedHistory = await readGitHubHistory(context.scope, reviewPolicy(args, toolingRoot, context.gh))
  const refreshedDecoded = decodeHistory(refreshedHistory)
  const refreshed = summarizeReviews(refreshedDecoded, context.taxonomy, null)
  if (!refreshed.ok)
    return { ok: false, allowed: false, reason: 'review-history-refused', detail: refreshed.diagnostics }
  const integrity = selectedReviewIntegrity(refreshedDecoded, refreshed)
  if (integrity !== null) return integrity
  if (JSON.stringify(refreshed.value) !== JSON.stringify(context.summary.value))
    return { ok: false, allowed: false, reason: 'review-inputs-moved' }
  const state = deriveReviewState(
    refreshedDecoded,
    {
      repository: args.repository,
      target: `${args.repository}#${args.pr}`,
      candidateGitSHA: args.head,
      input: refreshed.value.input,
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
  const freshBase = await refreshReviewBase(args.candidateCwd, fresh.baseName, context.git, context.gh)
  if (!freshBase.ok) return baseRefusal(freshBase)
  if (freshBase.tip !== context.baseTip) return { ok: false, allowed: false, reason: 'pr-coordinates-moved' }
  const refusal = reviewStateRefusal(state, refreshed, args, ci, mandateRead)
  if (refusal !== null) return refusal
  const lastMandate = await currentLandingMandate(
    toolingRoot,
    args.pr,
    context.gh,
    { head: fresh.head, base: fresh.baseName, baseTip: freshBase.tip, automationLogin: args.automationLogin },
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
  if (mandateRead.mandate?.admitted) {
    const reviewInput = await validateLandingReviewInput(
      args.candidateCwd,
      args.pr,
      args.head,
      initial.summary.value.input,
      {
        gh: initial.gh,
        git: initial.git,
        automationLogin: args.automationLogin,
      },
    )
    if (!reviewInput.ok)
      return {
        ok: false,
        allowed: false,
        reason: reviewInput.reason,
        detail: { error: reviewInput.error },
      }
  }
  const ci = await ciState(toolingRoot, initial.gh, args.pr)
  const refusal = await postAdmissionRefusal(args, toolingRoot, initial, ci, mandateRead)
  if (refusal !== null) return refusal
  return { ok: true, allowed: true, reviews: initial.summary.value.reviews, ci }
}
