import { hasFramedOwnUw, ownUwRefusal } from './epic-own-uw'
import { childCompleted, childSchedulable, dependencySatisfied, topological } from './epic-progress'
import type { ChildFacts } from './epic-types'

// ── Framing, not authority ────────────────────────────────────────────────────

/**
 * Only children proven complete leave the order. Indeterminate, abandoned, and
 * unallocated children are held, and their dependants stay blocked. This frames
 * scheduling and does not authorize a run or a base.
 */
export function frameEpic(input: {
  base: string
  run?: string
  children: ChildFacts[]
}): { order: number[]; blocked: { ticket: number; blockers: number[] }[] } | { error: string; missing?: number[] } {
  const { base, children, run } = input
  const open = children.filter((child) => !childCompleted(child, base))
  const missing = open.filter((child) => !hasFramedOwnUw(child))
  if (missing.length)
    return {
      error: `unsettled own UW: ${missing.map((child) => `#${child.number} (${ownUwRefusal(child)})`).join(', ')}`,
      missing: missing.map((child) => child.number),
    }

  const byNumber = new Map(children.map((child) => [child.number, child]))
  const pending = new Set(open.map((child) => child.number))
  const blocked = new Map<number, number[]>()
  for (const child of open) {
    if (!childSchedulable(child, run)) blocked.set(child.number, [child.number])
  }
  for (const child of open) {
    if (blocked.has(child.number)) continue
    const unsatisfied = child.blockedBy
      .filter((blocker) => {
        const sibling = blocker.repo ? undefined : byNumber.get(blocker.number)
        return sibling === undefined
          ? !dependencySatisfied(blocker)
          : !pending.has(sibling.number) && !dependencySatisfied(blocker)
      })
      .map((blocker) => blocker.number)
    if (unsatisfied.length) blocked.set(child.number, unsatisfied)
  }
  propagateBlocked(open, blocked)
  const { order, rest } = topological(open.filter((child) => !blocked.has(child.number)))
  if (rest.length) return { error: `cycle: ${rest.join(', ')}` }
  return {
    order,
    blocked: [...blocked].map(([ticket, blockers]) => ({ ticket, blockers })).sort((a, b) => a.ticket - b.ticket),
  }
}

function propagateBlocked(open: ChildFacts[], blocked: Map<number, number[]>): void {
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
}
