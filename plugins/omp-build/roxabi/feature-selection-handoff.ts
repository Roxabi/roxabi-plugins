import { mandateParentHistories } from './feature-context.ts'
import { observeContextHandoff } from './feature-context-handoff-observation.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ConfirmedContextAppend } from './feature-succession-refresh.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwReadPort } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

/** Reobserve the same negative and causal cut before publication and selection. */
export function createHandoffObserver(
  authority: FeatureAuthority,
  reader: UwReadPort,
  history: FeatureAuthority['history'],
  negativeRecordId: string,
) {
  return async (prospective?: ConfirmedContextAppend) => {
    const options = {
      ...withRoxabiGitHubPolicy({ cwd: authority.context.cwd, gh: authority.context.gh }),
      gh: authority.context.gh,
    }
    const refreshed = await authority.context.engine.readComposedWorkflowHistory([authority.scope], options)
    if (!refreshed.ok || refreshed.histories[0] === undefined)
      return { ok: false as const, reason: 'context-handoff-history-unconfirmed' }
    const next = refreshed.histories[0]
    const parents = await mandateParentHistories(authority.context.engine, next, options)
    if (!parents.ok) return { ok: false as const, reason: parents.reason }
    const currentReader =
      prospective === undefined
        ? reader
        : createInstalledUwReadPort({
            cwd: authority.context.cwd,
            gh: authority.context.gh,
            readAuthor: history.source.expectedAuthor,
            prospectiveContextAppend: prospective,
          })
    return observeContextHandoff({
      authority,
      uwRead: await currentReader.readUw(authority.scope),
      history: next,
      parentHistories: parents.parents,
      negativeRecordId,
      ...(prospective === undefined ? {} : { prospective }),
    })
  }
}
