import { buildRecord, type CanonicalRecord, type Json, publishGitHubRecord } from '../../dist/contracts.js'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { ticketOfBranch } from './epic-claims'
import type { EpicAuthority } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { adapterOptions, diagnosticsText, tree } from './epic-driver-github'
import { gh, git, repoName } from './epic-driver-runtime'
import type { ChildFacts } from './epic-types'
import { type DisarmReviewedBeforePushResult, disarmReviewedBeforePush } from './landing-foundation.js'

// ── GitHub writes ─────────────────────────────────────────────────────────────

export function prState(repo: string, pr: number): { state: string; autoMerge: boolean } {
  const view: unknown = JSON.parse(gh(repo, ['pr', 'view', String(pr), '--json', 'state,autoMergeRequest']))
  if (!view || typeof view !== 'object' || !('state' in view)) {
    throw new Error(`gh pr view ${pr}: unexpected ${JSON.stringify(view).slice(0, 200)}`)
  }
  return {
    state: String(view.state),
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
  if (canPublish?.() === false) throw new Error('publication-ownership-revoked')
  const record = newEpicEvent(repository, issue, run, event, key, payload, inputs)
  const options = { ...adapterOptions(repo), canPublish }
  const publication = await publishGitHubRecord(record, options, createPublicationContextResolver(options, null))
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
 * No stopped ticket stays armed: withdraw head authorization and disable native
 * auto-merge before publishing a stop. `merged` when the PR landed first.
 */
export async function disarm(repo: string, pr: number): Promise<Disarm> {
  const before = prState(repo, pr)
  if (before.state === 'MERGED') return 'merged'
  let result: DisarmReviewedBeforePushResult
  try {
    result = await disarmReviewedBeforePush(repo, pr, { gh: async (cwd: string, args: string[]) => gh(cwd, args) })
  } catch (error) {
    if (confirmedMerged(repo, pr)) return 'merged'
    throw error
  }
  const after = prState(repo, pr)
  if (after.state === 'MERGED') return 'merged'
  if (after.state === 'OPEN' && after.autoMerge) throw new Error(`PR #${pr} is still armed after the disarm`)
  if ('merged' in result) return 'merged'
  if ('closed' in result) return 'closed'
  return 'unarmed' in result ? 'unarmed' : 'disarmed'
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
 * The one way a ticket stops, whoever proved it: disarm every unmerged PR of the
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
  const prs = (await readChildPrInventory(repo, authority, child)).filter((pr) => pr.state !== 'MERGED')
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
