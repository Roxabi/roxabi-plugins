import { canonicalValueDigest } from '../../dist/contracts.js'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { ticketOfBranch } from './epic-claims'
import { branchFor } from './epic-naming'
import { completionStep } from './epic-next-completion'
import { hasFramedOwnUw, ownUwRefusal } from './epic-own-uw'
import { childCompleted, childSchedulable, openBlockers, stopOf, summarize, topological } from './epic-progress'
import type { ChildFacts, Facts, PrFacts, Report, Step } from './epic-types'

type Candidate = { pending: ChildFacts[]; target: ChildFacts | null }

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
  const pending = facts.children.filter((child) => !childCompleted(child, facts.base))
  return { pending, target: candidateTarget(actionableChildren(pending, facts, byNumber), facts, byNumber) }
}

function actionableChildren(pending: ChildFacts[], facts: Facts, byNumber: Map<number, ChildFacts>): ChildFacts[] {
  return pending.filter(
    (child) =>
      childSchedulable(child, facts.run) &&
      !stopOf(child, facts.run) &&
      openBlockers(child, byNumber, facts.base).length === 0,
  )
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
  if (early) return early
  if (target.ownUw.status !== 'refused' && target.ownUw.role === 'parent') {
    if (target.prs.length !== 0 || target.branches.length !== 0)
      return stopBranchMismatch(target.number, `Parent #${target.number} has a child branch or PR`, report)
    return { action: 'parent', ticket: target.number, reason: `#${target.number} is the next Parent`, report }
  }
  return branchStep(facts, target, report)
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
  const closed = terminalBranchStep(target, head, ticket, report)
  if (closed) return closed
  if (name === null)
    return {
      action: 'start',
      ticket,
      branch: head,
      reason:
        target.initialMandate?.status === 'ready'
          ? `#${ticket} is Parent-committed and framed; establishing its first mandate while dependency completion remains held`
          : `#${ticket} is next in order`,
      report,
    }

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

function terminalBranchStep(target: ChildFacts, head: string, ticket: number, report: Report): Step | null {
  const terminal = target.prs.find((candidate) => candidate.state !== 'OPEN' && candidate.head === head)
  if (!terminal) return null
  const state = terminal.state === 'MERGED' ? 'merged without calculated child completion' : 'closed unmerged'
  return stopBranchMismatch(
    ticket,
    `PR #${terminal.number} on ${head} was ${state}; a new PR needs a superseding branch`,
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
    reason: `no actionable child while ${pending.map((child) => `#${child.number}${child.initialMandate?.status === 'held' ? ` (${child.initialMandate.reason})` : ''}`).join(', ')} remain open`,
    report,
  }
}

function finalStep(facts: Facts, report: Report): Step {
  const integration = facts.parentIntegration
  if (!integration.ok)
    return {
      action: 'drop',
      stop: 'driver-error',
      reason: integration.diagnostics.map((item) => item.message).join('; '),
      report,
    }
  if (integration.value === null) return { action: 'integrate', reason: 'Parent own integration is required', report }
  const { code } = integration.value
  return reviewedRangeStep(facts, report, `${code.base}..${code.head}`)
}

function reviewedRangeStep(facts: Facts, report: Report, range: string): Step {
  const end = range.split('..')[1]
  const review = facts.reviews
    .filter((entry) => entry.range === range && currentEpicReviewInputs(facts, entry.inputs))
    .at(-1)
  if (!review) return { action: 'final-review', stage: 'review', range, reason: `no review of ${range}`, report }
  if (review.verdict === 'blocking') return blockingReviewStep(facts, range, report)
  if (facts.parentCompletion?.state !== 'complete')
    return {
      action: 'drop',
      stop: 'driver-error',
      reason:
        facts.parentCompletion === null
          ? 'Canonical Parent completion is unavailable'
          : facts.parentCompletion.diagnostics.map((item) => item.message).join('; '),
      report,
    }
  if (
    !facts.parentCompletion.sources.some(
      (source) =>
        source.kind === review.decision.kind &&
        source.recordId === review.decision.recordId &&
        source.scope.repository === review.decision.scope.repository &&
        source.scope.target === review.decision.scope.target,
    )
  )
    return {
      action: 'drop',
      stop: 'driver-error',
      reason: 'Canonical Parent completion does not cite the current review decision',
      report,
    }
  return completionStep(facts, report, `final review clean at ${end}`)
}
export function currentEpicReviewInputs(facts: Facts, inputs: ActionInputs): boolean {
  const current = facts.parentIntegration
  if (!current.ok || current.value === null) return false
  const expected = current.value
  const manifest = inputs.manifest
  const pins = manifest.deliveryData.filter((item) => item.role === 'integration')
  const integration = pins[0]
  if (
    pins.length !== 1 ||
    integration === undefined ||
    manifest.code.base !== expected.code.base ||
    manifest.code.head !== expected.code.head ||
    manifest.code.repository !== expected.code.repository ||
    manifest.code.referenceCommit !== expected.code.head
  )
    return false
  const { role: _role, ...pin } = integration
  return (
    canonicalValueDigest(pin) === canonicalValueDigest(expected.source) &&
    canonicalValueDigest(manifest.spec) === canonicalValueDigest(expected.spec) &&
    canonicalValueDigest(manifest.acceptedSources) === canonicalValueDigest(expected.acceptedSources)
  )
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
