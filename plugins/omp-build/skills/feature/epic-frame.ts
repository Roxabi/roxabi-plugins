import { hasFramedOwnUw, ownUwRefusal } from './epic-own-uw'
import { isDone, topological } from './epic-progress'
import type { ChildFacts } from './epic-types'

// ── Framing, not authority ────────────────────────────────────────────────────

/**
 * Closed or merged children leave the order and satisfy dependents. An open
 * blocker outside the epic reports the child (and its in-epic dependents) as
 * blocked. Open children require a fresh, framed own UW. This does not
 * authorize a run or a base.
 */
export function frameEpic(input: {
  base: string
  children: ChildFacts[]
}): { order: number[]; blocked: { ticket: number; blockers: number[] }[] } | { error: string; missing?: number[] } {
  const { base, children } = input
  const open = children.filter((child) => !isDone(child, base))
  const missing = open.filter((child) => !hasFramedOwnUw(child))
  if (missing.length)
    return {
      error: `unsettled own UW: ${missing.map((child) => `#${child.number} (${ownUwRefusal(child)})`).join(', ')}`,
      missing: missing.map((child) => child.number),
    }

  const byNumber = new Map(children.map((child) => [child.number, child]))
  const blocked = new Map<number, number[]>()
  for (const child of open) {
    const outside = child.blockedBy
      .filter((blocker) => (blocker.repo || !byNumber.has(blocker.number)) && blocker.state === 'OPEN')
      .map((blocker) => blocker.number)
    if (outside.length) blocked.set(child.number, outside)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const child of open) {
      if (blocked.has(child.number)) continue
      const via = child.blockedBy.filter((b) => !b.repo && blocked.has(b.number)).map((b) => b.number)
      if (via.length) {
        blocked.set(child.number, via)
        grew = true
      }
    }
  }
  const { order, rest } = topological(open.filter((child) => !blocked.has(child.number)))
  if (rest.length) return { error: `cycle: ${rest.join(', ')}` }
  return {
    order,
    blocked: [...blocked].map(([ticket, blockers]) => ({ ticket, blockers })).sort((a, b) => a.ticket - b.ticket),
  }
}
