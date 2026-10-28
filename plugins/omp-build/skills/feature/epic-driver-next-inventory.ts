import type { EpicAuthority } from './epic-driver-authority'
import { readChildPrInventory } from './epic-driver-containment'
import { Refused } from './epic-driver-runtime'
import type { ChildFacts, Facts } from './epic-types'

export type KnownMerge = { repository: string; mandateId: string; ticket: number; pr: number }

function checkKnownMerge(child: ChildFacts, pr: number): void {
  const observed = child.prs.find((entry) => entry.number === pr)
  if (observed?.state === 'OPEN') throw new Error(`PR #${pr} merged, yet the facts still show it open`)
  if (observed?.state !== 'MERGED') throw new Refused(`containment known PR #${pr} merged state is inconsistent`)
}

export async function inventoryChildren(
  repo: string,
  authority: EpicAuthority,
  facts: Facts,
  known?: KnownMerge,
): Promise<Facts> {
  if (known && (known.repository !== authority.repository || known.mandateId !== authority.mandateId))
    throw new Refused(`containment known PR #${known.pr} parent ownership changed`)
  let found = false
  for (const child of facts.children) {
    const pr = known?.ticket === child.number ? known.pr : undefined
    child.prs = await readChildPrInventory(repo, authority, child, pr)
    if (pr !== undefined) {
      found = true
      checkKnownMerge(child, pr)
    }
  }
  if (known && !found) throw new Refused(`containment known PR #${known.pr} child is missing`)
  return facts
}
