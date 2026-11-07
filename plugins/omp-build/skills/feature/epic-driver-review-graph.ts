import {
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  validateRecordGraph,
} from '../../dist/contracts.js'
import { diagnosticsText } from './epic-driver-github'
import { Refused } from './epic-driver-runtime'
import { currentEpicReviewInputs } from './epic-next-step'
import type { Facts } from './epic-types'

/** Bind a canonical review decision to the exact current Epic range and inputs. */
export function reviewDecisionGraph(epicHistory: DecodedHistory, decisionRecord: string, range: string, facts: Facts) {
  const authorityHistory = classifyHistory(epicHistory).authorityHistory
  const graph = validateRecordGraph(authorityHistory)
  if (!graph.ok) throw new Refused(`Epic review history is not admissible: ${diagnosticsText(graph.diagnostics)}`)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const decision = records.get(decisionRecord)
  if (decision?.kind !== 'decision')
    throw new Refused(`--decision-record ${decisionRecord} is not a canonical decision`)
  const synthesis = records.get(decision.payload.originalContributionId)
  const synthesisInventory =
    synthesis?.kind === 'contribution' && synthesis.payload.inventoryId !== null
      ? records.get(synthesis.payload.inventoryId)
      : null
  const root =
    synthesisInventory?.kind === 'review-attempt' ? records.get(synthesisInventory.payload.rootAttemptId) : null
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.subject.kind !== 'epic-range' ||
    root.payload.subject.range !== range
  ) {
    throw new Refused(`--decision-record ${decisionRecord} is not bound to the exact Epic range ${range}`)
  }
  if (root.payload.inputSnapshot === null || !currentEpicReviewInputs(facts, root.payload.inputSnapshot))
    throw new Refused(
      `--decision-record ${decisionRecord} does not bind the current Parent integration and accepted inputs`,
    )
  const inventoryIds = [...records.values()]
    .filter(
      (record): record is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
        record.kind === 'review-attempt' && record.payload.rootAttemptId === root.recordId,
    )
    .map((record) => record.recordId)
  return { authorityHistory, decision, inputSnapshot: root.payload.inputSnapshot, inventoryIds }
}
