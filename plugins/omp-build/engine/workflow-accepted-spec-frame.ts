import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { replayForMandate } from './uw-identity-replay.ts'
import {
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
} from './workflow-context-succession-inspection.ts'
import { historyFor, mandatesOf } from './workflow-control.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from './workflow-spec-authentication.ts'

export function frameInputsProblem(
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<never> | null {
  const historiesByScope = new Map<string, DecodedHistory>()
  for (const history of histories) {
    const scope = `${history.source.scope.repository}\0${history.source.scope.target}`
    const previous = historiesByScope.get(scope)
    if (previous !== undefined && canonicalValueDigest(previous) !== canonicalValueDigest(history))
      return { ok: false, diagnostics: [diagnostic('ambiguous', 'Conflicting histories claim the same scope')] }
    historiesByScope.set(scope, history)
  }
  if (replayContext !== undefined) {
    const matches = new Set(
      histories.flatMap((history) =>
        mandatesOf(history)
          .filter((candidate) => {
            if (historical === undefined)
              return replayForMandate(history, candidate, replayContext, inspection, histories)
            const frame = historicalAcceptedSpecFrame(historical, histories, candidate, inspection)
            const home = frame.ok
              ? historyFor({ repository: candidate.repository, target: candidate.target }, frame.value.histories)
              : null
            return (
              frame.ok &&
              home !== null &&
              replayForMandate(home, candidate, replayContext, frame.value.inspection, frame.value.histories)
            )
          })
          .map((candidate) => `${candidate.repository}\0${candidate.target}\0${candidate.recordId}`),
      ),
    )
    if (matches.size !== 1)
      return {
        ok: false,
        diagnostics: [diagnostic('action-uncertain', 'Assessment replay does not identify one scoped mandate start')],
      }
  }
  return null
}
