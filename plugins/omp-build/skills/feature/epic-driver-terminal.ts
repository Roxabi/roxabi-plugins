import { type DecodedHistory, validateFreshDecision } from '../../dist/contracts.js'
import type { UwAdmission } from '../../engine/uw-admission.ts'
import { loadReviewClassCatalogues } from '../../roxabi/review-class-catalogues.ts'
import { assertChildGrant, type EpicAuthority, evidenceText, readEpicAuthority } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { disarmEpicControlTarget } from './epic-driver-control'
import { gather } from './epic-driver-gather'
import { adapterOptions, citedReviewHistories, diagnosticsText } from './epic-driver-github'
import { epicEvents, reviewDispositionIds } from './epic-driver-history'
import { type Disarm, publishEpicEvent, ticketStop } from './epic-driver-publication'
import { reportPayload, reportText } from './epic-driver-report'
import { reviewDecisionGraph } from './epic-driver-review-graph'
import { git, Refused } from './epic-driver-runtime'
import { hookStatus } from './epic-finalization'
import { currentEpicReviewInputs, nextStep } from './epic-next-step'
import { summarize } from './epic-progress'
import { STICKY_STOPS, stopClass, TICKET_STOPS } from './epic-stops'
import type { Facts } from './epic-types'
import { isPrincipal } from './feature-init-stack'
import { type HookResult, runPostMergeHook } from './post-merge-hook'

function refusePrincipal(repo: string): void {
  if (isPrincipal(repo)) throw new Refused('epic driver refuses the principal worktree')
}

function requireDeliveryAdmission(epic: number, admission: UwAdmission): void {
  if (!admission.deliverable.ok)
    throw new Refused(
      `epic #${epic} native delivery admission refused: ${evidenceText(admission.deliverable.diagnostics)}`,
    )
}

export async function stop(
  repo: string,
  epic: number,
  ticket: number,
  reason: string,
  detail: string,
): Promise<Record<string, unknown>> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (stopClass(reason) !== 'ticket') throw new Refused(`${reason} is not a ticket stop: ${TICKET_STOPS.join(', ')}`)
  refusePrincipal(repo)
  if (git(repo, ['status', '--porcelain']) !== '') {
    throw new Error(`the tree is dirty: commit #${ticket}'s work on its branch, subject ending (#${ticket}), first`)
  }
  const { facts } = await gather(repo, epic, run, base)
  assertChildGrant(authority, facts, ticket)
  const child = facts.children.find((c) => c.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  const outcome = await ticketStop(repo, authority, child, reason, detail)
  if (outcome.merged !== null) return { ticket, merged: outcome.merged, disarmed: outcome.disarmed }
  return { ticket, stop: reason, sticky: STICKY_STOPS.includes(reason), disarmed: outcome.disarmed }
}

export async function review(
  repo: string,
  epic: number,
  decisionRecord: string,
  range: string,
  canPublish?: () => boolean,
) {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!decisionRecord) throw new Refused('--decision-record <ID> is required')
  refusePrincipal(repo)
  const { facts, epicHistory, parentAdmission } = await gather(repo, epic, run, base)
  requireDeliveryAdmission(epic, parentAdmission)
  for (const child of facts.children) child.prs = await readChildPrInventory(repo, authority, child)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || step.range !== range) {
    throw new Refused(`the driver expects no final review of ${range} (next: ${step.action})`)
  }
  const { authorityHistory, decision, inputSnapshot, inventoryIds } = reviewDecisionGraph(
    epicHistory,
    decisionRecord,
    range,
    facts,
  )
  const externalHistories = await citedReviewHistories(repo, epicHistory)
  const options = adapterOptions(repo)
  const catalogues = await loadReviewClassCatalogues({
    histories: [epicHistory, ...externalHistories],
    cwd: options.cwd,
    gh: options.gh,
  })
  const dispositionIds = reviewDispositionIds(epicHistory, decision)
  const refs = dispositionIds.map((recordId) => ({
    scope: epicHistory.source.scope,
    kind: 'cause-disposition' as const,
    recordId,
  }))
  const result = validateFreshDecision(
    decision,
    authorityHistory,
    catalogues,
    null,
    externalHistories,
    epicHistory,
    refs,
  )
  if (!result.ok) {
    throw new Refused(`--decision-record ${decisionRecord} is not admissible: ${diagnosticsText(result.diagnostics)}`)
  }
  const assessment = result.value
  if (!assessment.admissible) {
    throw new Refused(
      `--decision-record ${decisionRecord} is not admissible: ${diagnosticsText(assessment.diagnostics)}`,
    )
  }
  const fresh = await gather(repo, epic, run, base)
  requireDeliveryAdmission(epic, fresh.parentAdmission)
  for (const child of fresh.facts.children) child.prs = await readChildPrInventory(repo, authority, child)
  const freshStep = nextStep(fresh.facts)
  if (
    freshStep.action !== 'final-review' ||
    freshStep.stage !== 'review' ||
    freshStep.range !== range ||
    !currentEpicReviewInputs(fresh.facts, inputSnapshot)
  )
    throw new Refused('Parent integration or accepted context changed before final review publication')
  await publishEpicEvent(
    repo,
    epic,
    run,
    'epic-review',
    `${range}:${decisionRecord}`,
    { decisionId: decisionRecord, inventoryIds, dispositionIds, range },
    [decisionRecord, ...inventoryIds],
    canPublish,
  )
  return { decisionRecord, range }
}

export async function hook(repo: string, epic: number): Promise<HookResult> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  refusePrincipal(repo)
  const { facts, parentAdmission } = await gather(repo, epic, run, base)
  requireDeliveryAdmission(epic, parentAdmission)
  for (const child of facts.children) child.prs = await readChildPrInventory(repo, authority, child)
  const step = nextStep(facts)
  if (step.action !== 'post-merge') throw new Refused(`the driver expects no post-merge hook (next: ${step.action})`)
  const mark = async (
    result: 'started' | HookResult['result'],
    sha: string,
    exitCode: number | null,
  ): Promise<void> => {
    await publishEpicEvent(repo, epic, run, 'post-merge', `${result}:${sha}`, { result, sha, exitCode })
  }
  let outcome: HookResult
  try {
    outcome = await runPostMergeHook(repo, base, {
      onStart: async (sha) => mark('started', sha, null),
    })
  } catch (error) {
    outcome = { result: 'failed', sha: null, detail: error instanceof Error ? error.message : String(error) }
  }
  const sha = outcome.sha ?? facts.baseSha
  await mark(outcome.result, sha, outcome.code ?? null)
  return outcome
}

type ReportData = {
  facts: Facts
  epicHistory: DecodedHistory
  disarmed: Record<string, Disarm>
  stillArmed: number[]
}

async function reportData(repo: string, epic: number, authority: EpicAuthority, outcome: string): Promise<ReportData> {
  const { run, base } = authority
  if (outcome === 'complete') {
    const { facts, epicHistory, parentAdmission } = await gather(repo, epic, run, base)
    requireDeliveryAdmission(epic, parentAdmission)
    for (const child of facts.children) child.prs = await readChildPrInventory(repo, authority, child)
    const step = nextStep(facts)
    if (step.action !== 'complete') throw new Refused(`the epic is not complete (next: ${step.action})`)
    return { facts, epicHistory, disarmed: {}, stillArmed: [] }
  }
  const containment = await disarmEpicControlTarget(repo, epic)
  const { disarmed } = containment
  const stillArmed = containment.failed.map(({ pr }) => pr)
  const light = await gather(repo, epic, run, base, { git: false, dashboard: false, reviews: false })
  try {
    const full = await gather(repo, epic, run, base)
    const facts: Facts = full.facts.landingError
      ? { ...full.facts, baseCi: { state: 'unread', failed: [], pending: [] } }
      : full.facts
    return { facts, epicHistory: full.epicHistory, disarmed, stillArmed }
  } catch {
    const facts: Facts = { ...light.facts, baseCi: { state: 'unread', failed: [], pending: [] } }
    return {
      facts,
      epicHistory: light.epicHistory,
      disarmed,
      stillArmed,
    }
  }
}

export async function report(
  repo: string,
  epic: number,
  outcome: string,
  reason: string,
): Promise<{ posted: boolean; text: string; stillArmed: number[] }> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (outcome !== 'complete' && outcome !== 'drop') throw new Refused(`--outcome must be complete or drop: ${outcome}`)
  refusePrincipal(repo)
  const data = await reportData(repo, epic, authority, outcome)
  const summary = summarize(data.facts)
  const hook = hookStatus(data.facts).record
  const text = reportText(run, base, outcome, reason, summary, hook, data.disarmed, data.stillArmed)
  const posted = !epicEvents(data.epicHistory).some(
    ({ payload }) => payload.event === 'goal-report' && payload.run === run,
  )
  const named = data.stillArmed.length ? `still armed: ${data.stillArmed.map((pr) => `#${pr}`).join(', ')}` : ''
  if (named) {
    console.log(text)
    console.error(named)
  }
  if (posted)
    await publishEpicEvent(
      repo,
      epic,
      run,
      'goal-report',
      run,
      reportPayload(outcome, reason, summary, hook, data.disarmed, data.stillArmed),
    )
  if (named) throw new Error(named)
  return { posted, text, stillArmed: data.stillArmed }
}
