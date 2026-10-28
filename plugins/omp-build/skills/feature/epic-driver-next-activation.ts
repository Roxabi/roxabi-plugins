import { resolveTicketBranch } from './epic-claims'
import { revalidateEpicActivation } from './epic-driver-activation'
import { assertChildGrant, type EpicAuthority } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { type Disarm, disarm } from './epic-driver-publication'
import { git, Refused } from './epic-driver-runtime'
import { nextStep } from './epic-next-step'
import type { Facts, Step } from './epic-types'

function switchToChildBranch(
  repo: string,
  base: string,
  facts: Facts,
  step: Extract<Step, { action: 'start' | 'resume' }>,
): void {
  const { ticket, branch } = step
  if (step.action === 'start') git(repo, ['switch', '-c', branch, `refs/remotes/origin/${base}`])
  else if (git(repo, ['branch', '--show-current']) !== branch) {
    const local = facts.children
      .find((child) => child.number === ticket)
      ?.branches.find((item) => item.name === branch)?.local
    git(repo, local ? ['switch', branch] : ['switch', '-c', branch, '--track', `refs/remotes/origin/${branch}`])
  }
  const landed = git(repo, ['branch', '--show-current'])
  const claim = resolveTicketBranch(
    landed,
    facts.children.map((child) => child.number),
  )
  if (landed !== branch || 'error' in claim || claim.ticket !== ticket) {
    throw new Error(`after the switch HEAD is ${landed || 'detached'}, not ${branch}`)
  }
}

function authenticateResumePr(
  facts: Facts,
  step: Extract<Step, { action: 'start' | 'resume' }>,
  current: Extract<Step, { action: 'start' | 'resume' }>,
): number | null {
  if (
    step.action === 'resume' &&
    step.pr?.armed &&
    (current.action !== 'resume' || current.pr?.number !== step.pr.number)
  ) {
    throw new Refused(`PR #${step.pr.number} changed before branch activation`)
  }
  if (current.action !== 'resume' || !current.pr?.armed) return null
  const child = facts.children.find((entry) => entry.number === step.ticket)
  const pr = child?.prs.find((entry) => entry.number === current.pr?.number)
  if (!child || !pr) throw new Refused(`missing observation for PR #${current.pr.number}`)
  // The fresh child inventory was authenticated before selecting current.
  return pr.number
}

export async function activateNextStep(
  repo: string,
  base: string,
  authority: EpicAuthority,
  facts: Facts,
  step: Step,
): Promise<{ disarmed: Disarm | null; pr: number | null }> {
  if (step.action !== 'start' && step.action !== 'resume') return { disarmed: null, pr: null }
  const { ticket, branch } = step
  const fresh = await revalidateEpicActivation(repo, authority, facts)
  const child = fresh.facts.children.find((entry) => entry.number === ticket)
  if (!child) throw new Refused(`missing observation for child #${ticket}`)
  child.prs = await readChildPrInventory(repo, fresh.authority, child)
  const current = nextStep(fresh.facts)
  if (
    fresh.authority.base !== base ||
    current.action !== step.action ||
    (current.action !== 'start' && current.action !== 'resume') ||
    current.ticket !== ticket ||
    current.branch !== branch
  ) {
    throw new Refused('epic native state changed before branch activation')
  }
  authority = fresh.authority
  facts = fresh.facts
  assertChildGrant(authority, facts, ticket)
  const resumePr = authenticateResumePr(facts, step, current)
  switchToChildBranch(repo, base, facts, step)
  if (resumePr === null) return { disarmed: null, pr: null }
  return { disarmed: await disarm(repo, resumePr), pr: resumePr }
}
