import { mandateParentHistories } from './feature-context.ts'
import { readContextEffectIntent } from './feature-context-effects.ts'
import { observeContextHandoff } from './feature-context-handoff-observation.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContextHandoffRequest } from './feature-contract.ts'
import type { ConfirmedContextAppend } from './feature-succession-refresh.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwReadPort } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

/** Reobserve the same negative and causal cut before publication and selection. */
export function createHandoffObserver(
  authority: FeatureAuthority,
  reader: UwReadPort,
  history: FeatureAuthority['history'],
  request: ContextHandoffRequest,
) {
  const observer = authority.context.contextEffectObserverFactory?.()
  const intent = observer === undefined ? undefined : readContextEffectIntent(request.effectsFile)
  const observe = async (prospective?: ConfirmedContextAppend) => {
    if (observer === undefined || intent === undefined)
      return { ok: false as const, reason: 'context-effect-native-observer-unavailable' }
    const requested = await intent
    if (!requested.ok) return requested
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
      negativeRecordId: request.negativeRecordId,
      effects: { intent: requested.value, observer },
      ...(prospective === undefined ? {} : { prospective }),
    })
  }
  return Object.assign(observe, {
    canPublish: () => observer?.active() === true,
    dispose: async () => {
      await observer?.dispose()
    },
  })
}
