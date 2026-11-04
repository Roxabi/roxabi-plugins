import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import type { CreationContext } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { same } from './uw-cause-creation-support.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import { assertCauseParentUnchanged } from './uw-cause-parent.ts'
import type { UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

type Parent = NonNullable<Extract<CreationContext, { kind: 'sister' }>['parentObservation']>
function withoutCreated(
  current: IssueWriteObservation,
  created: IssueRef,
  removeChild: boolean,
): IssueWriteObservation {
  const other = (entry: IssueRef) => entry.repository !== created.repository || entry.number !== created.number
  return {
    ...current,
    blockers: current.blockers.filter(other),
    children: removeChild ? current.children.filter(other) : current.children,
  }
}
export function causeEffectGuard(
  input: { reader: UwReadPort; github: GitHubOptions },
  parent: Parent | null,
  parentScope: Scope | null,
  uw: Scope,
  originalDigest: string,
): CauseEffectGuard {
  return async ({ created }) => {
    if (parent !== null) await assertCauseParentUnchanged(parent, input.reader, input.github, created)
    const current = rootObservation(uw, await input.reader.readUw(uw))
    const normalized =
      created === null ? current : withoutCreated(current, created, parentScope !== null && same(parentScope, uw))
    if (nativeIssueObservationDigest(normalized) !== originalDigest) throw new Error('cause-original-stale')
  }
}
