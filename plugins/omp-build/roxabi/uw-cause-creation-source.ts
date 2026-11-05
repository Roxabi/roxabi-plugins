import { type GitHubOptions, githubScope } from '../dist/contracts.js'
import type { CauseSisterInput, ReportPromotionInput } from '../engine/cause-disposition-schema.ts'
import { checkDuplicate, home } from './uw-cause-creation-support.ts'
import { observeCauseParent } from './uw-cause-parent.ts'
import { readAuthenticatedCause, readAuthenticatedReport } from './uw-cause-read.ts'
import type { UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { createParentEngagementReadPort } from './uw-parent-engagement.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

export async function loadCauseCreationSource(
  input: { reader: UwReadPort; nativeReader: UwReadPort; github: GitHubOptions },
  request: CauseSisterInput | ReportPromotionInput,
  mode: 'sister' | 'report-promotion',
) {
  const ref = mode === 'sister' ? (request as CauseSisterInput).disposition : (request as ReportPromotionInput).report
  const sourceRead =
    mode === 'sister'
      ? await readAuthenticatedCause(ref, input.reader, input.github)
      : await readAuthenticatedReport(ref, input.github)
  const source = 'disposition' in sourceRead ? sourceRead.disposition : sourceRead.record
  checkDuplicate(home(sourceRead.histories, ref.scope), ref)
  const originalObserved = rootObservation(ref.scope, await input.nativeReader.readUw(ref.scope))
  const originalDigest = nativeIssueObservationDigest(originalObserved)
  const parentIssue =
    mode === 'sister' ? originalObserved.parent : (request as ReportPromotionInput).create.writes.relations.parent
  const parentScope = parentIssue == null ? null : githubScope(parentIssue.repository, parentIssue.number)
  const parent =
    parentScope === null ? null : await observeCauseParent(parentScope, createParentEngagementReadPort(input.github))
  if (parent !== null && parent.state !== 'inactive') throw new Error(`cause-parent-${parent.state}`)
  return { source, originalDigest, parentScope, parent }
}
