import { ticketOfBranch } from './epic-claims'
import { epicDiffRange } from './epic-close'
import { finalizationBlock, hookStatus } from './epic-finalization'
import { branchFor } from './epic-naming'
import { hasFramedOwnUw, ownUwRefusal } from './epic-own-uw'
import { isDone, mergedPr, openBlockers, stopOf, summarize, topological } from './epic-progress'
import type { ChildFacts, Facts, PrFacts, Report, Step } from './epic-types'

type Candidate = { pending: ChildFacts[]; target: ChildFacts | null }
type MergedChild = { child: ChildFacts; pr: PrFacts }

/** The one next action of an Epic run, from GitHub and git state alone. */
export function nextStep(facts: Facts): Step {
  const report = summarize(facts)
  if (facts.landingError) return { action: 'drop', stop: 'bad-landing', reason: facts.landingError, report }

  const { pending, target } = nextCandidate(facts)
  if (target) return childStep(facts, target, report)
  if (pending.length) return noProgressStep(pending, report)
  return finalStep(facts, report)
}

function nextCandidate(facts: Facts): Candidate {
  const byNumber = new Map(facts.children.map((child) => [child.number, child]))
  const pending = facts.children.filter((child) => !isDone(child, facts.base))
  return { pending, target: candidateTarget(actionableChildren(pending, facts, byNumber), facts, byNumber) }
}

function actionableChildren(pending: ChildFacts[], facts: Facts, byNumber: Map<number, ChildFacts>): ChildFacts[] {
  return pending.filter((child) => !stopOf(child, facts.run) && openBlockers(child, byNumber, facts.base).length === 0)
}

function candidateTarget(actionable: ChildFacts[], facts: Facts, byNumber: Map<number, ChildFacts>): ChildFacts | null {
  if (!actionable.length) return null

  const { order } = topological(actionable)
  const ranked = order.map((number) => byNumber.get(number)).filter((child): child is ChildFacts => child !== undefined)
  return (
    ranked.find((child) => ticketOfBranch(facts.tree.branch) === child.number) ??
    ranked.find((child) => child.prs.some((pr) => pr.state === 'OPEN')) ??
    ranked.find((child) => child.branches.length > 0) ??
    ranked[0] ??
    null
  )
}

function childStep(facts: Facts, target: ChildFacts, report: Report): Step {
  const early = earlyChildStep(facts, target, report)
  return early ?? branchStep(facts, target, report)
}

function earlyChildStep(facts: Facts, target: ChildFacts, report: Report): Step | null {
  const ticket = target.number
  if (!facts.tree.clean && ticketOfBranch(facts.tree.branch) !== ticket) {
    return {
      action: 'drop',
      stop: 'dirty-tree',
      reason: `the epic worktree is dirty on ${facts.tree.branch ?? 'a detached HEAD'} between tickets`,
      report,
    }
  }
  if (facts.baseCi.state === 'red') {
    return {
      action: 'drop',
      stop: 'base-ci-red',
      reason: `base ${facts.base} is red: ${facts.baseCi.failed.join(', ')}`,
      report,
    }
  }
  if (!hasFramedOwnUw(target)) {
    return {
      action: 'stop',
      ticket,
      stop: 'no-scope',
      reason: `#${ticket} has unsettled own UW: ${ownUwRefusal(target)}`,
      report,
    }
  }
  return null
}

function branchStep(facts: Facts, target: ChildFacts, report: Report): Step {
  const ticket = target.number
  const open = target.prs.filter((pr) => pr.state === 'OPEN')
  const multipleOpen = multipleOpenPrStep(open, ticket, report)
  if (multipleOpen) return multipleOpen

  const pr = open[0] ?? null
  const invalidPr = invalidOpenPrStep(pr, facts, ticket, report)
  if (invalidPr) return invalidPr

  const names = [...new Set(target.branches.map((branch) => branch.name))]
  const ambiguousBranches = ambiguousBranchStep(pr, names, ticket, report)
  if (ambiguousBranches) return ambiguousBranches

  const name = pr?.head ?? names[0] ?? null
  const head = name ?? branchFor(target)
  const closed = closedBranchStep(target, head, ticket, report)
  if (closed) return closed
  if (name === null) return { action: 'start', ticket, branch: head, reason: `#${ticket} is next in order`, report }

  return existingBranchStep(target, pr, name, ticket, report)
}

function multipleOpenPrStep(open: PrFacts[], ticket: number, report: Report): Step | null {
  if (open.length <= 1) return null
  return stopBranchMismatch(
    ticket,
    `#${ticket} has ${open.length} open PRs: ${open.map((pr) => `#${pr.number}`).join(', ')}`,
    report,
  )
}

function invalidOpenPrStep(pr: PrFacts | null, facts: Facts, ticket: number, report: Report): Step | null {
  if (!pr || (pr.base === facts.base && ticketOfBranch(pr.head) === ticket)) return null
  return stopBranchMismatch(
    ticket,
    `PR #${pr.number} is ${pr.head} → ${pr.base}, not a #${ticket} branch into ${facts.base}`,
    report,
  )
}

function ambiguousBranchStep(pr: PrFacts | null, names: string[], ticket: number, report: Report): Step | null {
  if (pr || names.length <= 1) return null
  return stopBranchMismatch(ticket, `several branches claim #${ticket}: ${names.join(', ')}`, report)
}

function closedBranchStep(target: ChildFacts, head: string, ticket: number, report: Report): Step | null {
  const closed = target.prs.find((candidate) => candidate.state === 'CLOSED' && candidate.head === head)
  if (!closed) return null
  return stopBranchMismatch(
    ticket,
    `PR #${closed.number} on ${head} was closed unmerged; a new PR needs a superseding branch`,
    report,
  )
}

function existingBranchStep(
  target: ChildFacts,
  pr: PrFacts | null,
  name: string,
  ticket: number,
  report: Report,
): Step {
  const branch = target.branches.find((candidate) => candidate.name === name)
  if (!branch) return stopBranchMismatch(ticket, `PR #${pr?.number} head ${name} is not on origin`, report)
  if (branch.elsewhere)
    return stopBranchMismatch(ticket, `${name} is checked out in another worktree, ${branch.elsewhere}`, report)
  if (pr && pr.headSha !== branch.remoteTip) {
    return stopBranchMismatch(
      ticket,
      `PR #${pr.number} head ${pr.headSha} is not origin/${name} (${branch.remoteTip ?? 'absent'})`,
      report,
    )
  }
  if (branch.foreign) {
    return {
      action: 'stop',
      ticket,
      stop: 'foreign-commit',
      reason: `${name} carries ${branch.foreign}, which does not claim #${ticket}`,
      report,
    }
  }
  return {
    action: 'resume',
    ticket,
    branch: name,
    pr,
    reason: pr ? `#${ticket} has open PR #${pr.number}` : `#${ticket} has branch ${name}`,
    report,
  }
}

function stopBranchMismatch(ticket: number, reason: string, report: Report): Step {
  return { action: 'stop', ticket, stop: 'branch-mismatch', reason, report }
}

function noProgressStep(pending: ChildFacts[], report: Report): Step {
  return {
    action: 'drop',
    stop: 'no-progress',
    reason: `no actionable child while ${pending.map((child) => `#${child.number}`).join(', ')} remain open`,
    report,
  }
}

function finalStep(facts: Facts, report: Report): Step {
  const merged = mergedChildren(facts)
  if (!merged.length) return completionStep(facts, report, null)

  const first = merged[0]?.pr
  if (!first?.baseSha)
    return { action: 'drop', stop: 'driver-error', reason: `PR #${first?.number} has no merge base`, report }

  const diff = epicDiffRange(
    merged.map(({ child, pr }) => ({ number: child.number, baseSha: pr.baseSha ?? '', mergeSha: pr.mergeSha })),
  )
  if ('error' in diff) return { action: 'drop', stop: 'driver-error', reason: diff.error, report }

  const end = diff.range.split('..')[1]
  const review = facts.reviews.filter((entry) => entry.range.split('..')[1] === end).at(-1)
  if (!review)
    return { action: 'final-review', stage: 'review', range: diff.range, reason: `no review of ${diff.range}`, report }
  if (review.verdict === 'blocking') return blockingReviewStep(facts, diff.range, report)
  return completionStep(facts, report, `final review clean at ${end}`)
}

function mergedChildren(facts: Facts): MergedChild[] {
  return facts.children
    .map((child) => ({ child, pr: mergedPr(child, facts.base) }))
    .filter((entry): entry is MergedChild => entry.pr !== null)
    .sort((a, b) => (a.pr.mergedAt ?? '').localeCompare(b.pr.mergedAt ?? ''))
}

function blockingReviewStep(facts: Facts, range: string, report: Report): Step {
  if (!facts.children.some((child) => child.epicFix)) {
    return {
      action: 'final-review',
      stage: 'fix-ticket',
      range,
      reason: 'the final review is blocking and its one fix round is unspent',
      report,
    }
  }
  return {
    action: 'drop',
    stop: 'final-review-blocking',
    reason: 'the final review is still blocking after its fix round',
    report,
  }
}

function completionStep(facts: Facts, report: Report, postMergeReason: string | null): Step {
  const blocked = finalizationBlock(facts, report)
  if (blocked) return blocked

  const hook = hookStatus(facts)
  if (hook.state === 'failed') return { action: 'drop', stop: 'hook-failed', reason: hook.detail, report }
  if (hook.state === 'stale') return { action: 'drop', stop: 'hook-stale', reason: hook.detail, report }
  if (postMergeReason === null) return { action: 'complete', reason: 'every child closed and none merged', report }
  if (hook.state === 'done') return { action: 'complete', reason: hook.detail, report }
  return { action: 'post-merge', reason: postMergeReason, report }
}
