import type { IssueRef, IssueWritePorts, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'

/** The observer may account only for this invocation's confirmed created issue. */
export type CauseEffectGuard = (effect: {
  primitive:
    | 'create'
    | 'patch'
    | 'labels'
    | 'add-child'
    | 'remove-child'
    | 'add-blocker'
    | 'remove-blocker'
    | 'native-state'
  created: IssueRef | null
}) => Promise<void>

type ComposedParentInsertion = Readonly<{
  parent: Readonly<IssueRef>
  addChild: IssueWritePorts['addChild']
}>

const sameIssue = (left: Readonly<IssueRef>, right: Readonly<IssueRef>) =>
  left.repository === right.repository && left.number === right.number

/** Reuses the issue-triage writer and its native primitives; no alternative writer or mutation route. */
export function guardedCauseWriter(
  ports: IssueWritePorts,
  createWriter: (ports: IssueWritePorts) => IssueWriter,
  beforeEffect: CauseEffectGuard,
  composedInsertion?: ComposedParentInsertion,
): IssueWriter {
  let created: IssueRef | null = null
  const permittedParent = composedInsertion === undefined ? null : { ...composedInsertion.parent }
  const guard = (primitive: Parameters<CauseEffectGuard>[0]['primitive']) =>
    beforeEffect({ primitive, created: created === null ? null : { ...created } })
  const guarded: IssueWritePorts = {
    read: ports.read,
    async create(input) {
      created = null
      await guard('create')
      const issue = await ports.create(input)
      created = { repository: issue.repository, number: issue.number }
      return issue
    },
    async patch(issue, input) {
      await guard('patch')
      return ports.patch(issue, input)
    },
    async updateLabels(issue, input) {
      await guard('labels')
      return ports.updateLabels(issue, input)
    },
    async addChild(parent, child) {
      const requestedParent = { repository: parent.repository, number: parent.number }
      const requestedChild = { repository: child.repository, number: child.number }
      await guard('add-child')
      if (
        composedInsertion !== undefined &&
        permittedParent !== null &&
        created !== null &&
        sameIssue(requestedParent, permittedParent) &&
        sameIssue(requestedChild, created)
      )
        return composedInsertion.addChild(requestedParent, requestedChild)
      return ports.addChild(requestedParent, requestedChild)
    },
    async removeChild(parent, child) {
      await guard('remove-child')
      return ports.removeChild(parent, child)
    },
    async addBlocker(issue, blocker) {
      await guard('add-blocker')
      return ports.addBlocker(issue, blocker)
    },
    async removeBlocker(issue, blocker) {
      await guard('remove-blocker')
      return ports.removeBlocker(issue, blocker)
    },
    async setNativeState(issue, effect) {
      await guard('native-state')
      return ports.setNativeState(issue, effect)
    },
  }
  const writer = createWriter(guarded)
  return {
    async create(plan) {
      try {
        await guard('create')
      } catch (error) {
        return {
          status: 'refused',
          diagnostics: [
            { code: 'cause-parent-guard', message: error instanceof Error ? error.message : String(error) },
          ],
        }
      }
      return writer.create(plan)
    },
    update: writer.update,
    setNativeState: writer.setNativeState,
  }
}
