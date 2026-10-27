import { type EpicAuthority, frameCurrentChildren, readEpicAuthority } from './epic-driver-authority'
import { type CanonicalEpic, issueNumber, readCanonicalEpic } from './epic-driver-canonical'
import { Refused } from './epic-driver-runtime'
import type { Facts } from './epic-types'

function exactAuthority(left: EpicAuthority, right: EpicAuthority): boolean {
  return (
    left.mandateId === right.mandateId &&
    left.run === right.run &&
    left.base === right.base &&
    left.children.length === right.children.length &&
    left.children.every((child) =>
      right.children.some(
        (other) =>
          other.scope.repository === child.scope.repository &&
          other.scope.target === child.scope.target &&
          other.specVersion === child.specVersion &&
          other.tier === child.tier &&
          other.snapshot.spec.version === child.snapshot.spec.version,
      ),
    )
  )
}

function freshCanonicalFacts(facts: Facts, canonical: CanonicalEpic): Facts {
  const previous = new Map(facts.children.map((child) => [child.number, child]))
  return {
    ...facts,
    children: canonical.nodes.map((node) => {
      const number = issueNumber(node.uw)
      const child = previous.get(number)
      if (child === undefined) throw new Refused(`native child #${number} appeared before branch activation`)
      const ownUw = canonical.ownUws.get(number)
      if (ownUw === undefined) throw new Refused(`native child #${number} has no current UW observation`)
      return {
        ...child,
        title: node.title,
        state: node.native.state,
        stateReason: node.native.stateReason,
        labels: [...node.labels],
        body: node.raw.body,
        ownUw,
        blockedBy: node.blockers.map((scope) => {
          const blocker = canonical.native.get(`${scope.repository}\0${scope.target}`)
          if (blocker === undefined) throw new Refused(`native blocker ${scope.target} was not observed`)
          return {
            number: issueNumber(scope),
            state: blocker.native.state,
            stateReason: blocker.native.stateReason,
            ...(scope.repository === canonical.full ? {} : { repo: scope.repository }),
          }
        }),
      }
    }),
  }
}

/** Rechecks canonical authority immediately before a branch mutation without re-reading PR enrichment. */
export async function revalidateEpicActivation(
  repo: string,
  expected: EpicAuthority,
  facts: Facts,
): Promise<{ authority: EpicAuthority; facts: Facts }> {
  const authority = await readEpicAuthority(repo, expected.epic)
  if (!exactAuthority(expected, authority)) throw new Refused('epic authority changed before branch activation')
  const canonical = await readCanonicalEpic(repo, authority.epic, authority.repository)
  const freshFacts = freshCanonicalFacts(facts, canonical)
  frameCurrentChildren(authority, freshFacts, canonical.parentAdmission)
  return { authority, facts: freshFacts }
}
