import type { IssueRef, IssueWritePorts } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { githubScope } from '../dist/contracts.js'
import { observeCauseParent } from './uw-cause-parent.ts'
import type { ParentEngagementReadPort } from './uw-parent-engagement.ts'

/** A fresh authenticated inactive observation is required at every insertion boundary. */
export function parentInsertionGuard(reader: ParentEngagementReadPort) {
  return async (parent: IssueRef): Promise<void> => {
    const observed = await observeCauseParent(githubScope(parent.repository, parent.number), reader)
    if (observed.state !== 'inactive') throw new Error(`cause-parent-${observed.state}`)
  }
}

/** Preserve the native writer and its exact partial-effect accounting. */
export function guardParentInsertions(
  ports: IssueWritePorts,
  guard: (parent: IssueRef) => Promise<void>,
): IssueWritePorts {
  return {
    ...ports,
    async addChild(parent, child) {
      await guard(parent)
      await ports.addChild(parent, child)
    },
  }
}
