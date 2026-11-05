import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwProposal } from './uw-contract.ts'
import { issueRef } from './uw-operation-observation.ts'

type ParentAdmission = { guardParent(parent: IssueRef): Promise<void>; scopeOf(issue: IssueRef): Scope }

export async function insertionDiagnostics(
  proposal: UwProposal,
  ports: ParentAdmission,
): Promise<readonly UwDiagnostic[]> {
  const relations = proposal.writes.relations
  const parents: IssueRef[] = []
  if (relations.parent) parents.push(relations.parent)
  if (relations.addChildren.length > 0 && proposal.target.kind === 'existing') {
    const parent = issueRef(proposal.target.uw)
    if (
      parent !== null &&
      !parents.some((item) => item.repository === parent.repository && item.number === parent.number)
    )
      parents.push(parent)
  }
  for (const parent of parents) {
    try {
      await ports.guardParent(parent)
    } catch (error) {
      const uw = ports.scopeOf(parent)
      return [
        {
          code: 'cause-parent-guard',
          message: error instanceof Error ? error.message : String(error),
          location: { kind: 'native', uw, connection: 'state' },
          related: [],
        },
      ]
    }
  }
  return []
}
