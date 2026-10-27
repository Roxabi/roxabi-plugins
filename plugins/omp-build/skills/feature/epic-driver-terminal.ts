import {
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  validateDecision,
  validateRecordGraph,
} from '../../dist/contracts.js'
import type { UwAdmission } from '../../engine/uw-admission.ts'
import { loadReviewConfig } from '../../roxabi/review-assets.ts'
import { assertChildGrant, evidenceText, readEpicAuthority } from './epic-driver-authority'
import { gather } from './epic-driver-gather'
import { diagnosticsText } from './epic-driver-github'
import { epicEvents } from './epic-driver-history'
import { type Disarm, disarm, publishEpicEvent, ticketStop } from './epic-driver-publication'
import { reportPayload, reportText } from './epic-driver-report'
import { git, Refused } from './epic-driver-runtime'
import { hookStatus } from './epic-finalization'
import { nextStep } from './epic-next-step'
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
  const outcome = await ticketStop(repo, run, base, child, reason, detail)
  if (outcome.merged !== null) return { ticket, merged: outcome.merged, disarmed: outcome.disarmed }
  return { ticket, stop: reason, sticky: STICKY_STOPS.includes(reason), disarmed: outcome.disarmed }
}

export async function review(repo: string, epic: number, decisionRecord: string, range: string) {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!decisionRecord) throw new Refused('--decision-record <ID> is required')
  refusePrincipal(repo)
  const { facts, epicHistory, parentAdmission } = await gather(repo, epic, run, base)
  requireDeliveryAdmission(epic, parentAdmission)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || step.range !== range) {
    throw new Refused(`the driver expects no final review of ${range} (next: ${step.action})`)
  }
  const authorityHistory = classifyHistory(epicHistory).authorityHistory
  const graph = validateRecordGraph(authorityHistory)
  if (!graph.ok) throw new Refused(`Epic review history is not admissible: ${diagnosticsText(graph.diagnostics)}`)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const decision = records.get(decisionRecord)
  if (decision?.kind !== 'decision')
    throw new Refused(`--decision-record ${decisionRecord} is not a canonical decision`)
  const synthesis = records.get(decision.payload.originalContributionId)
  const synthesisInventory =
    synthesis?.kind === 'contribution' && synthesis.payload.inventoryId !== null
      ? records.get(synthesis.payload.inventoryId)
      : null
  const root =
    synthesisInventory?.kind === 'review-attempt' ? records.get(synthesisInventory.payload.rootAttemptId) : null
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.subject.kind !== 'epic-range' ||
    root.payload.subject.range !== range
  ) {
    throw new Refused(`--decision-record ${decisionRecord} is not bound to the exact Epic range ${range}`)
  }
  const inventoryIds = [...records.values()]
    .filter(
      (record): record is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
        record.kind === 'review-attempt' && record.payload.rootAttemptId === root.recordId,
    )
    .map((record) => record.recordId)
  const assessment = validateDecision(decision, authorityHistory, loadReviewConfig().canonicalClasses, null)
  if (!assessment.admissible) {
    throw new Refused(
      `--decision-record ${decisionRecord} is not admissible: ${diagnosticsText(assessment.diagnostics)}`,
    )
  }
  await publishEpicEvent(
    repo,
    epic,
    run,
    'epic-review',
    `${range}:${decisionRecord}`,
    { decisionId: decisionRecord, inventoryIds, range },
    [decisionRecord, ...inventoryIds],
  )
  return { decisionRecord, range }
}

/**
 * After the existing trusted filing workflow creates a normal fix ticket, bind
 * that child to the one blocking Epic decision which authorizes the fix round.
 */
export async function markFix(repo: string, epic: number, ticket: number): Promise<{ ticket: number; range: string }> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!Number.isInteger(ticket) || ticket <= 0) throw new Refused('--ticket <N> is required')
  refusePrincipal(repo)
  const { facts } = await gather(repo, epic, run, base)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'fix-ticket') {
    throw new Refused(`the driver expects no final-review fix ticket (next: ${step.action})`)
  }
  const source = [...facts.reviews].reverse().find((review) => review.range === step.range)
  if (source?.verdict !== 'blocking') {
    throw new Refused(`the current final review for ${step.range} is not a blocking canonical decision`)
  }
  const child = facts.children.find((entry) => entry.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  assertChildGrant(authority, facts, ticket)
  await publishEpicEvent(repo, ticket, run, 'epic-fix', String(ticket), {})
  return { ticket, range: step.range }
}

export async function hook(repo: string, epic: number): Promise<HookResult> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  refusePrincipal(repo)
  const { facts, parentAdmission } = await gather(repo, epic, run, base)
  requireDeliveryAdmission(epic, parentAdmission)
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

async function reportData(repo: string, epic: number, run: string, base: string, outcome: string): Promise<ReportData> {
  if (outcome === 'complete') {
    const { facts, epicHistory, parentAdmission } = await gather(repo, epic, run, base)
    requireDeliveryAdmission(epic, parentAdmission)
    const step = nextStep(facts)
    if (step.action !== 'complete') throw new Refused(`the epic is not complete (next: ${step.action})`)
    return { facts, epicHistory, disarmed: {}, stillArmed: [] }
  }
  const light = await gather(repo, epic, run, base, { git: false, dashboard: false, reviews: false })
  const { disarmed, stillArmed } = await disarmOpenPrs(repo, light.facts)
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

async function disarmOpenPrs(repo: string, facts: Facts): Promise<Pick<ReportData, 'disarmed' | 'stillArmed'>> {
  const disarmed: Record<string, Disarm> = {}
  const stillArmed: number[] = []
  const armed = facts.children
    .flatMap((child) => child.prs)
    .filter((pr) => pr.state === 'OPEN' && pr.armed)
    .sort((left, right) => left.number - right.number)
  for (const pr of armed) {
    try {
      disarmed[pr.number] = await disarm(repo, pr.number)
    } catch {
      stillArmed.push(pr.number)
    }
  }
  return { disarmed, stillArmed }
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
  const data = await reportData(repo, epic, run, base, outcome)
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
