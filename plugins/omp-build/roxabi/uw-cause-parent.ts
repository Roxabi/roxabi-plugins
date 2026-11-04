import { createHash } from 'node:crypto'
import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { type GitHubOptions, readComposedWorkflowHistory, selectApplicableMandate } from '../dist/contracts.js'
import type { CreationContext } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

type ParentObservation = NonNullable<Extract<CreationContext, { kind: 'sister' }>['parentObservation']>

/** Complete native and authenticated mandate observations; refusal is never inferred inactivity. */
export async function observeCauseParent(
  parent: Scope,
  reader: UwReadPort,
  github: GitHubOptions,
  knownCreated: IssueRef | null = null,
): Promise<ParentObservation> {
  const read = await reader.readUw(parent)
  if (read.graph.status !== 'complete') throw new Error('cause-parent-graph-incomplete')
  const observed = rootObservation(parent, read)
  const scopes = read.graph.nodes.map((node) => node.uw)
  const history = await readComposedWorkflowHistory(scopes, github)
  if (!history.ok)
    throw new Error(`cause-parent-history-incomplete: ${history.diagnostics.map((item) => item.code).join(',')}`)
  const own = history.histories.find(
    (entry) => entry.source.scope.repository === parent.repository && entry.source.scope.target === parent.target,
  )
  if (own === undefined) throw new Error('cause-parent-history-missing')
  const selected = selectApplicableMandate(
    own,
    history.histories.filter((entry) => entry !== own),
  )
  const hasMandateClaim = own.operations.some(
    (operation) =>
      operation.authority !== 'foreign' && (operation.kind === 'mandate' || operation.claimedKinds.includes('mandate')),
  )
  const state =
    selected.status === 'applicable'
      ? 'active'
      : selected.reason === 'missing' && !hasMandateClaim
        ? 'inactive'
        : 'indeterminate'
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
    nativeDigest: nativeIssueObservationDigest(normalized),
    historyDigest: createHash('sha256').update(JSON.stringify(own)).digest('hex'),
    state,
    diagnostics: selected.status === 'refused' ? selected.evidence : [],
  }
}

/** Recheck immediately before every native effect, allowing only this invocation's known child. */
export async function assertCauseParentUnchanged(
  expected: ParentObservation,
  reader: UwReadPort,
  github: GitHubOptions,
  knownCreated: IssueRef | null,
): Promise<void> {
  if (expected.state !== 'inactive') throw new Error(`cause-parent-${expected.state}`)
  const fresh = await observeCauseParent(expected.parent, reader, github, knownCreated)
  if (fresh.state !== 'inactive') throw new Error(`cause-parent-${fresh.state}`)
  if (fresh.nativeDigest !== expected.nativeDigest || fresh.historyDigest !== expected.historyDigest)
    throw new Error('cause-parent-stale')
}
