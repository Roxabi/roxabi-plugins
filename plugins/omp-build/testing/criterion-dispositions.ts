import { z } from 'zod'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { assessCauseDispositions } from '../engine/cause-assessment.ts'
import { decisionCauseCapture } from '../engine/cause-capture-authentication.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import { type UwGraphObservation, WAYFINDER_LABELS } from '../engine/uw-graph.ts'
import { bindExternalRef, historyFor } from '../engine/workflow-control.ts'

const simulatedIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable().optional(),
  labels: z.array(z.string()),
  subIssues: z.array(z.number().int().positive()),
  blockedBy: z.array(z.number().int().positive()),
})

/** Project the simulator's declared issue state, not accepted mandate metadata, into its graph. */
export function graphFromSimulatedIssues(
  root: Scope,
  value: unknown,
): Extract<UwGraphObservation, { status: 'complete' }> {
  const issues = z.array(simulatedIssue).parse(value)
  const numbers = new Set(issues.map((issue) => issue.number))
  if (numbers.size !== issues.length) throw new Error('Duplicate simulated issue')
  const number = Number(root.target.slice(root.target.lastIndexOf('#') + 1))
  const rootIssue = issues.find((issue) => issue.number === number)
  if (!rootIssue || root.target !== `${root.repository}#${number}`) throw new Error('Simulated graph root is absent')
  const scope = (n: number) => ({ repository: root.repository, target: `${root.repository}#${n}` })
  const reached = new Set<number>()
  const pending = [number]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (reached.has(current)) continue
    const issue = issues.find((candidate) => candidate.number === current)
    if (!issue) throw new Error(`Missing simulated issue #${current}`)
    reached.add(current)
    pending.push(
      ...issue.subIssues,
      ...issue.blockedBy,
      ...issues.filter((candidate) => candidate.subIssues.includes(current)).map((parent) => parent.number),
    )
  }
  const nodes = issues
    .filter((issue) => reached.has(issue.number))
    .map((issue) => {
      const parents = issues.filter((candidate) => candidate.subIssues.includes(issue.number))
      if (parents.length > 1 || [...issue.subIssues, ...issue.blockedBy].some((n) => !numbers.has(n)))
        throw new Error(`Incomplete or conflicting simulated graph at #${issue.number}`)
      return {
        uw: scope(issue.number),
        title: issue.title,
        raw: rawSource(scope(issue.number).target, issue.body, issue.updatedAt),
        updatedAt: issue.updatedAt,
        labels: issue.labels,
        wayfinderLabels: issue.labels.filter((label) => (WAYFINDER_LABELS as readonly string[]).includes(label)),
        parent: parents[0] ? scope(parents[0].number) : null,
        children: issue.subIssues.map(scope),
        blockers: issue.blockedBy.map(scope),
        native: { state: issue.state, stateReason: issue.stateReason ?? null },
      }
    })
  return { status: 'complete', root, observedAt: rootIssue.updatedAt, nodes }
}

/** Find the actual synthesis action capture of a decision, never a fabricated source. */
export function synthesisActionCapture(
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  histories: readonly DecodedHistory[],
) {
  const capture = decisionCauseCapture(decision, histories)
  if (!capture.ok)
    throw new Error(
      `Fixture decision capture is unavailable: ${capture.diagnostics.map((item) => item.code).join(',')}`,
    )
  return capture.value
}

/** Capture the producer slot named by the actual retained contribution. */
export function contributionActionCapture(
  contribution: Extract<CanonicalRecord, { kind: 'contribution' }>,
  histories: readonly DecodedHistory[],
) {
  const scope = { repository: contribution.repository, target: contribution.target }
  const history = historyFor(scope, histories)
  if (history === null || contribution.payload.inventoryId === null)
    throw new Error('Fixture contribution inventory is missing')
  const inventory = bindExternalRef(
    { scope, kind: 'review-attempt', recordId: contribution.payload.inventoryId },
    history,
  )
  if (!inventory.ok || inventory.value.kind !== 'review-attempt')
    throw new Error('Fixture inventory is not authenticated')
  const slots = inventory.value.payload.slots
  const matching = slots
    .map((slot, index) => ({ slot, index }))
    .filter(
      ({ slot }) =>
        slot.slotId === contribution.payload.host.slotId &&
        slot.phase === contribution.payload.host.phase &&
        slot.role === contribution.payload.host.role &&
        slot.chunk === contribution.payload.host.chunk,
    )
  const selected = matching[0]
  if (matching.length !== 1 || !selected?.slot.action) throw new Error('Fixture synthesis action slot is not unique')
  return {
    source: 'record' as const,
    record: { scope, kind: 'review-attempt' as const, recordId: inventory.value.recordId },
    selector: `/payload/slots/${selected.index}/action/inputs`,
    digest: canonicalValueDigest(selected.slot.action.inputs),
  }
}

/** Assess the actual authenticated decision; do not synthesize empty or preselected dispositions. */
export function criterionDispositionRecords(
  inputs: ActionInputs,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  graph: UwGraphObservation,
) {
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted review origin')
  const original = inputs.manifest.spec.effective.own.uw
  const capture = synthesisActionCapture(decision, histories)
  const assessment = assessCauseDispositions({
    context: { original, effective: inputs.manifest.spec.effective },
    capture,
    graph,
    source: { kind: 'decision', decision },
    histories,
    catalogues,
    adjudications: [],
  })
  if (!assessment.ok)
    throw new Error(
      `Cannot assess fixture dispositions: ${assessment.diagnostics.map(({ code, message }) => `${code}: ${message}`).join(', ')}`,
    )
  const dispositions = assessment.value.outcomes.map((payload, index) => {
    const id = `${decision.recordId}-disposition-${index}`
    const result = buildRecord({
      version: 1,
      recordId: id,
      operationId: `op-${id}`,
      runId: decision.runId,
      repository: original.repository,
      target: original.target,
      kind: 'cause-disposition',
      payload,
    })
    if (!result.ok || result.value.kind !== 'cause-disposition')
      throw new Error(`Cannot build fixture disposition ${id}`)
    return result.value
  })
  return { original, dispositions }
}
