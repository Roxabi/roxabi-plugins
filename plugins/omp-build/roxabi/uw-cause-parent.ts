import { createHash } from 'node:crypto'
import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { assessParentInsertionEngagement, nativeObservationDigest } from '../dist/contracts.js'
import type { CreationContext } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { rootObservation } from './uw-installed-observation.ts'
import type { ParentEngagementReadPort } from './uw-parent-engagement.ts'

type ParentObservation = NonNullable<Extract<CreationContext, { kind: 'sister' }>['parentObservation']>

/** Complete native and authenticated mandate observations; refusal is never inferred inactivity. */
export async function observeCauseParent(
  parent: Scope,
  reader: ParentEngagementReadPort,
  knownCreated: IssueRef | null = null,
): Promise<ParentObservation> {
  const read = await reader.readParentEngagement(parent)
  if (!read.ok)
    throw new Error(`cause-parent-history-incomplete: ${read.diagnostics.map((item) => item.code).join(',')}`)
  const observed = rootObservation(parent, { graph: read.value.graph })
  const own = read.value.histories.find(
    (entry) => entry.source.scope.repository === parent.repository && entry.source.scope.target === parent.target,
  )
  if (own === undefined) throw new Error('cause-parent-history-missing')
  const selected = assessParentInsertionEngagement(read.value)
  const normalized =
    knownCreated === null
      ? observed
      : {
          ...observed,
          children: observed.children.filter(
            (child) => child.repository !== knownCreated.repository || child.number !== knownCreated.number,
          ),
        }
  return {
    parent,
    nativeDigest: nativeObservationDigest({
      ...normalized,
      labels: [...normalized.labels],
      children: [...normalized.children],
      blockers: [...normalized.blockers],
    }),
    historyDigest: createHash('sha256').update(JSON.stringify(own)).digest('hex'),
    state: selected.state,
    diagnostics: [...selected.diagnostics],
  }
}

/** Recheck immediately before every native effect, allowing only this invocation's known child. */
export async function assertCauseParentUnchanged(
  expected: ParentObservation,
  reader: ParentEngagementReadPort,
  knownCreated: IssueRef | null,
): Promise<void> {
  if (expected.state !== 'inactive') throw new Error(`cause-parent-${expected.state}`)
  const fresh = await observeCauseParent(expected.parent, reader, knownCreated)
  if (fresh.state !== 'inactive') throw new Error(`cause-parent-${fresh.state}`)
  if (fresh.nativeDigest !== expected.nativeDigest || fresh.historyDigest !== expected.historyDigest)
    throw new Error('cause-parent-stale')
}
