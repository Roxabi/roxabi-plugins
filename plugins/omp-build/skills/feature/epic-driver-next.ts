import { assertChildGrant, frameEpicChildren } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { gather } from './epic-driver-gather'
import { tree } from './epic-driver-github'
import { activateNextStep } from './epic-driver-next-activation'
import { inventoryChildren, type KnownMerge } from './epic-driver-next-inventory'
import { type Disarm, disarm, ticketStop } from './epic-driver-publication'
import { git, Refused } from './epic-driver-runtime'
import { nextStep } from './epic-next-step'
import { armedStoppedPrs, mergedLocalBranches, mergedStoppedPrs, summarize } from './epic-progress'
import type { Facts, Step } from './epic-types'
import { isPrincipal } from './feature-init-stack'

export type NextOut = {
  run: string
  base: string
  step: Step
  recorded: { ticket: number; stop: string; disarmed?: Record<number, Disarm> }[]
  cleaned: string[]
  disarmed: Disarm | null
  reconciled: { ticket: number; pr: number; disarmed: Disarm | 'dry-run' }[]
}

type Authority = Parameters<typeof assertChildGrant>[0]
type RecordedStop = NextOut['recorded'][number]
type ReconciledPr = NextOut['reconciled'][number]

function refusePrincipal(repo: string): void {
  if (isPrincipal(repo)) throw new Refused('epic driver refuses the principal worktree')
}

async function cleanMergedBranches(
  repo: string,
  epic: number,
  authority: Authority,
  run: string,
  base: string,
  facts: Facts,
  dry: boolean,
  known?: KnownMerge,
): Promise<{ facts: Facts; cleaned: string[] }> {
  const merged = mergedLocalBranches(facts)
  if (dry) return { facts, cleaned: merged.map((entry) => `${entry.branch} (would delete)`) }
  if (!merged.length) return { facts, cleaned: [] }
  if (facts.tree.clean && merged.some((entry) => entry.branch === facts.tree.branch)) {
    git(repo, ['switch', '--detach', `refs/remotes/origin/${base}`])
  }
  const head = git(repo, ['branch', '--show-current'])
  const cleaned: string[] = []
  for (const { branch } of merged.filter((entry) => entry.branch !== head)) {
    git(repo, ['branch', '-D', branch])
    cleaned.push(branch)
  }
  return {
    facts: await inventoryChildren(repo, authority, (await gather(repo, epic, run, base)).facts, known),
    cleaned,
  }
}

async function reconcileStoppedPrs(
  repo: string,
  facts: Facts,
  dry: boolean,
): Promise<{ reconciled: ReconciledPr[]; problems: string[] }> {
  const reconciled: ReconciledPr[] = []
  const problems: string[] = []
  const entries = armedStoppedPrs(facts)
  // All child inventories were authenticated before reconciliation starts.
  for (const entry of entries) {
    if (dry) {
      reconciled.push({ ticket: entry.ticket, pr: entry.pr, disarmed: 'dry-run' })
      continue
    }
    try {
      const disarmed = await disarm(repo, entry.pr)
      reconciled.push({ ticket: entry.ticket, pr: entry.pr, disarmed })
      if (disarmed === 'merged') problems.push(`PR #${entry.pr} merged before it could be disarmed`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`PR #${entry.pr} stayed armed: ${message}`)
    }
  }
  problems.push(...mergedStoppedPrs(facts).map((entry) => `PR #${entry.pr} already merged`))
  return { reconciled, problems }
}

function childForStop(authority: Authority, facts: Facts, ticket: number, epic: number) {
  assertChildGrant(authority, facts, ticket)
  const child = facts.children.find((entry) => entry.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  return child
}

async function recordStop(
  repo: string,
  epic: number,
  authority: Authority,
  run: string,
  base: string,
  facts: Facts,
  step: Extract<Step, { action: 'stop' }>,
  dry: boolean,
  recorded: RecordedStop[],
): Promise<Facts> {
  const child = childForStop(authority, facts, step.ticket, epic)
  if (dry) child.prs = await readChildPrInventory(repo, authority, child)
  if (dry) {
    recorded.push({ ticket: step.ticket, stop: step.stop })
    child.stops.push({ run, reason: step.stop })
    return facts
  }
  const outcome = await ticketStop(repo, authority, child, step.stop, step.reason)
  if (outcome.merged !== null) {
    const known = {
      repository: authority.repository,
      mandateId: authority.mandateId,
      ticket: child.number,
      pr: outcome.merged,
    }
    return inventoryChildren(repo, authority, (await gather(repo, epic, run, base)).facts, known)
  }
  recorded.push({ ticket: step.ticket, stop: step.stop, disarmed: outcome.disarmed })
  child.stops.push({ run, reason: step.stop })
  facts.tree = tree(repo)
  return facts
}

async function stopNextTickets(
  repo: string,
  epic: number,
  authority: Authority,
  run: string,
  base: string,
  initialFacts: Facts,
  dry: boolean,
  recorded: RecordedStop[],
): Promise<{ facts: Facts; step: Step }> {
  const handled = new Set<number>()
  let facts = initialFacts
  let step = nextStep(facts)
  while (step.action === 'stop') {
    if (handled.has(step.ticket)) throw new Error(`#${step.ticket} came back as a stop twice in one call`)
    handled.add(step.ticket)
    facts = await recordStop(repo, epic, authority, run, base, facts, step, dry, recorded)
    step = nextStep(facts)
  }
  return { facts, step }
}

function driverError(
  run: string,
  base: string,
  facts: Facts,
  recorded: RecordedStop[],
  cleaned: string[],
  reconciled: ReconciledPr[],
  problems: string[],
): NextOut {
  return {
    run,
    base,
    step: { action: 'drop', stop: 'driver-error', reason: problems.join('; '), report: summarize(facts) },
    recorded,
    cleaned,
    disarmed: null,
    reconciled,
  }
}

export async function next(repo: string, epic: number, dry: boolean, reread = 0): Promise<NextOut> {
  return nextWithKnownMerge(repo, epic, dry, reread)
}

async function nextWithKnownMerge(
  repo: string,
  epic: number,
  dry: boolean,
  reread: number,
  known?: KnownMerge,
): Promise<NextOut> {
  if (!dry) {
    refusePrincipal(repo)
    git(repo, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
  }
  const { authority, facts } = await frameEpicChildren(repo, epic)
  const { run, base } = authority
  await inventoryChildren(repo, authority, facts, known)
  const cleaned = await cleanMergedBranches(repo, epic, authority, run, base, facts, dry, known)
  const reconciliation = await reconcileStoppedPrs(repo, cleaned.facts, dry)
  const recorded: RecordedStop[] = []
  if (reconciliation.problems.length) {
    return driverError(
      run,
      base,
      cleaned.facts,
      recorded,
      cleaned.cleaned,
      reconciliation.reconciled,
      reconciliation.problems,
    )
  }
  const stopped = await stopNextTickets(repo, epic, authority, run, base, cleaned.facts, dry, recorded)
  const activation = dry
    ? { disarmed: null, pr: null }
    : await activateNextStep(repo, base, authority, stopped.facts, stopped.step)
  if (activation.disarmed === 'merged') {
    if (reread > 0) throw new Error(`PR #${activation.pr} merged, yet the facts still show it open`)
    if (activation.pr === null || (stopped.step.action !== 'resume' && stopped.step.action !== 'start'))
      throw new Refused('merged PR has no authenticated child coordinate')
    return nextWithKnownMerge(repo, epic, dry, reread + 1, {
      repository: authority.repository,
      mandateId: authority.mandateId,
      ticket: stopped.step.ticket,
      pr: activation.pr,
    })
  }
  return {
    run,
    base,
    step: stopped.step,
    recorded,
    cleaned: cleaned.cleaned,
    disarmed: activation.disarmed,
    reconciled: reconciliation.reconciled,
  }
}
