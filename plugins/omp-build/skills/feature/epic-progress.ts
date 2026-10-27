import { ticketOfBranch } from './epic-claims'
import { STICKY_STOPS } from './epic-stops'
import type { ChildFacts, Facts, PrFacts, Report } from './epic-types'

// ── Classification ───────────────────────────────────────────────────────────

/** The PR that landed this child on the base: MERGED, into `base`, from a branch claiming it. */
export function mergedPr(child: ChildFacts, base: string): PrFacts | null {
  return (
    child.prs.find(
      (pr) => pr.state === 'MERGED' && pr.base === base && ticketOfBranch(pr.head) === child.number && pr.mergeSha,
    ) ?? null
  )
}

/**
 * CLOSED/NOT_PLANNED is terminal for scheduling. CLOSED/COMPLETED waits for an
 * observed ticket PR to settle unless its stop is permanent; a qualifying merged
 * PR completes its own child.
 */
export function isDone(child: ChildFacts, base: string): boolean {
  return (
    (child.state === 'CLOSED' &&
      (child.stateReason !== 'COMPLETED' ||
        !child.prs.some((pr) => pr.state === 'OPEN') ||
        stickyStopReason(child) !== null)) ||
    mergedPr(child, base) !== null
  )
}

function stickyStopReason(child: ChildFacts): string | null {
  const sticky = child.stops.find((stop) => STICKY_STOPS.includes(stop.reason))
  if (sticky) return sticky.reason
  return child.prs.some((pr) => pr.state === 'OPEN' && pr.exhausted) ? 'review-bound' : null
}

export function stopOf(child: ChildFacts, run: string): { reason: string; sticky: boolean } | null {
  const sticky = stickyStopReason(child)
  if (sticky !== null) return { reason: sticky, sticky: true }
  const current = child.stops.filter((stop) => stop.run === run).at(-1)
  return current ? { reason: current.reason, sticky: false } : null
}

/** Open, armed PRs of children `stopOf` reports stopped, sticky or this run. */
export function armedStoppedPrs(facts: Facts): { ticket: number; pr: number }[] {
  const found: { ticket: number; pr: number }[] = []
  for (const child of [...facts.children].sort((a, b) => a.number - b.number)) {
    if (!stopOf(child, facts.run)) continue
    const openArmed = child.prs
      .filter((item) => item.state === 'OPEN' && item.armed)
      .sort((a, b) => a.number - b.number)
    for (const pr of openArmed) {
      found.push({ ticket: child.number, pr: pr.number })
    }
  }
  return found
}

/**
 * Stopped children's PRs already shown MERGED onto this base from a ticket branch,
 * except the confirmed delivery returned by `mergedPr`. Other candidates still
 * refuse, including a MERGED PR whose merge commit cannot be identified.
 */
export function mergedStoppedPrs(facts: Facts): { ticket: number; pr: number }[] {
  const found: { ticket: number; pr: number }[] = []
  for (const child of [...facts.children].sort((a, b) => a.number - b.number)) {
    if (!stopOf(child, facts.run)) continue
    const delivery = mergedPr(child, facts.base)
    const merged = child.prs
      .filter(
        (item) =>
          item !== delivery &&
          item.state === 'MERGED' &&
          item.base === facts.base &&
          ticketOfBranch(item.head) === child.number,
      )
      .sort((a, b) => a.number - b.number)
    for (const pr of merged) found.push({ ticket: child.number, pr: pr.number })
  }
  return found
}

export function blockerCompleted(blocker: { state: 'OPEN' | 'CLOSED'; stateReason?: string | null }): boolean {
  return blocker.state === 'CLOSED' && blocker.stateReason === 'COMPLETED'
}

export function openBlockers(child: ChildFacts, byNumber: Map<number, ChildFacts>, _base: string): number[] {
  return child.blockedBy
    .filter((blocker) => {
      const sibling = blocker.repo ? undefined : byNumber.get(blocker.number)
      return sibling ? !blockerCompleted(sibling) : !blockerCompleted(blocker)
    })
    .map((blocker) => blocker.number)
}

/** Kahn over in-epic edges between `pending` children, ties by number. */
export function topological(pending: ChildFacts[]): { order: number[]; rest: number[] } {
  const inSet = new Set(pending.map((child) => child.number))
  const edges = new Map(
    pending.map((child) => [
      child.number,
      child.blockedBy.filter((b) => !b.repo && inSet.has(b.number)).map((b) => b.number),
    ]),
  )
  const order: number[] = []
  const placed = new Set<number>()
  for (;;) {
    const ready = pending
      .map((child) => child.number)
      .filter((n) => !placed.has(n) && (edges.get(n) ?? []).every((b) => placed.has(b)))
      .sort((a, b) => a - b)
    const next = ready[0]
    if (next === undefined) break
    order.push(next)
    placed.add(next)
  }
  return { order, rest: pending.map((child) => child.number).filter((n) => !placed.has(n)) }
}

export function summarize(facts: Facts): Report {
  const byNumber = new Map(facts.children.map((child) => [child.number, child]))
  const report: Report = { merged: [], closed: [], stopped: [], skipped: [], baseCi: facts.baseCi }
  for (const child of [...facts.children].sort((a, b) => a.number - b.number)) {
    if (mergedPr(child, facts.base)) report.merged.push(child.number)
    else if (child.state === 'CLOSED') report.closed.push(child.number)
    else {
      const stop = stopOf(child, facts.run)
      if (stop) report.stopped.push({ ticket: child.number, ...stop })
      else {
        const blockers = openBlockers(child, byNumber, facts.base)
        if (blockers.length) report.skipped.push({ ticket: child.number, blockers })
      }
    }
  }
  return report
}

/** Local branches of merged children whose tip is exactly what merged: safe to delete. */
export function mergedLocalBranches(facts: Facts): { ticket: number; branch: string }[] {
  const out: { ticket: number; branch: string }[] = []
  for (const child of facts.children) {
    const pr = mergedPr(child, facts.base)
    if (!pr) continue
    for (const branch of child.branches) {
      if (branch.local && !branch.elsewhere && branch.tip === pr.headSha) {
        out.push({ ticket: child.number, branch: branch.name })
      }
    }
  }
  return out
}
