import { buildRecord, type CanonicalRecord, type Json, publishGitHubRecord } from '../../dist/contracts.js'
import { ticketOfBranch } from './epic-claims'
import type { EpicAuthority } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { adapterOptions, diagnosticsText, issueHistory, tree } from './epic-driver-github'
import { gh, git, repoName } from './epic-driver-runtime'
import type { ChildFacts } from './epic-types'
import { disarmReviewedBeforePush } from './landing-foundation.js'

// ── GitHub writes ─────────────────────────────────────────────────────────────

export function prState(repo: string, pr: number): { state: string; labels: string[]; autoMerge: boolean } {
  const view: unknown = JSON.parse(gh(repo, ['pr', 'view', String(pr), '--json', 'state,labels,autoMergeRequest']))
  if (!view || typeof view !== 'object' || !('state' in view) || !('labels' in view) || !Array.isArray(view.labels)) {
    throw new Error(`gh pr view ${pr}: unexpected ${JSON.stringify(view).slice(0, 200)}`)
  }
  return {
    state: String(view.state),
    labels: view.labels.map((label: { name?: unknown }) => String(label?.name ?? '')),
    autoMerge: 'autoMergeRequest' in view && view.autoMergeRequest !== null,
  }
}

export function newEpicEvent(
  repository: string,
  issue: number,
  run: string,
  event: string,
  key: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
): Extract<CanonicalRecord, { kind: 'epic-event' }> {
  const recordId = `epic-event:${issue}:${run}:${event}:${key}`
  const parsed = buildRecord(
    {
      version: 1,
      recordId,
      runId: run,
      operationId: `${recordId}:publish`,
      repository,
      target: `${repository}#${issue}`,
      kind: 'epic-event',
      payload: { event, run, ...payload },
    },
    inputs,
  )
  if (!parsed.ok || parsed.value.kind !== 'epic-event') {
    throw new Error(`Epic event ${event} is not canonical: ${diagnosticsText(parsed.ok ? [] : parsed.diagnostics)}`)
  }
  return parsed.value
}

export async function publishEpicEvent(
  repo: string,
  issue: number,
  run: string,
  event: string,
  key: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
  canPublish?: () => boolean,
): Promise<void> {
  const repository = repoName(repo).full
  const history = await issueHistory(repo, repository, issue)
  if (canPublish?.() === false) throw new Error('publication-ownership-revoked')
  const record = newEpicEvent(repository, issue, run, event, key, payload, inputs)
  const publication = await publishGitHubRecord(record, history, { ...adapterOptions(repo), canPublish }, null)
  if (publication.status !== 'confirmed') {
    throw new Error(`Epic event ${record.recordId} was not confirmed: ${diagnosticsText(publication.diagnostics)}`)
  }
}

export type Disarm = 'merged' | 'closed' | 'disarmed' | 'unarmed'

function confirmedMerged(repo: string, pr: number): boolean {
  try {
    return prState(repo, pr).state === 'MERGED'
  } catch {
    return false
  }
}

/**
 * No stopped ticket stays armed: remove `reviewed`, disable native auto-merge
 * (`disarmReviewedBeforePush`, no push), read back. `merged` when the PR landed first.
 */
export async function disarm(repo: string, pr: number): Promise<Disarm> {
  const before = prState(repo, pr)
  if (before.state === 'MERGED') return 'merged'
  if (before.state !== 'OPEN') return 'closed'
  const labelled = before.labels.includes('reviewed')
  if (before.autoMerge) {
    try {
      await disarmReviewedBeforePush(repo, pr, { gh: async (cwd: string, args: string[]) => gh(cwd, args) })
    } catch (error) {
      if (confirmedMerged(repo, pr)) return 'merged'
      throw error
    }
  } else if (labelled) gh(repo, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
  const after = prState(repo, pr)
  if (after.state === 'MERGED') return 'merged'
  if (after.labels.includes('reviewed') || after.autoMerge) throw new Error(`PR #${pr} is still armed after the disarm`)
  return labelled || before.autoMerge ? 'disarmed' : 'unarmed'
}

export async function recordStop(
  repo: string,
  run: string,
  ticket: number,
  reason: string,
  detail: string,
): Promise<void> {
  await publishEpicEvent(repo, ticket, run, 'goal-stop', String(ticket), { reason, detail })
}

/**
 * The one way a ticket stops, whoever proved it: disarm every open PR of the
 * child, detach HEAD from its branch (kept), then publishes the canonical
 * `goal-stop` event. A PR that merged before its disarm is no stop: `merged`
 * names it, no event.
 */
export async function ticketStop(
  repo: string,
  authority: EpicAuthority,
  child: ChildFacts,
  reason: string,
  detail: string,
): Promise<{ merged: number | null; disarmed: Record<number, Disarm> }> {
  const { run, base } = authority
  const prs = (await readChildPrInventory(repo, authority, child)).filter((pr) => pr.state === 'OPEN')
  const disarmed: Record<number, Disarm> = {}
  for (const pr of prs) {
    disarmed[pr.number] = await disarm(repo, pr.number)
    if (disarmed[pr.number] === 'merged') return { merged: pr.number, disarmed }
  }
  const here = tree(repo)
  if (here.clean && ticketOfBranch(here.branch) === child.number) {
    git(repo, ['switch', '--detach', `refs/remotes/origin/${base}`])
  }
  await recordStop(repo, run, child.number, reason, detail)
  return { merged: null, disarmed }
}
