import { posix, win32 } from 'node:path'
import { canonicalValueDigest } from './canonical-value.ts'
import type {
  ContextEffectIntent,
  ContextEffectReview,
  ContextEffectSources,
  ContextLocalFileObservation,
  ContextLocalFileState,
} from './context-effect-review-schema.ts'
import { type ContextEffectReportView, contextEffectSources } from './context-effect-sources.ts'
import type { NativeToolObservation } from './native-tool-observation-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { ReceiptRecord } from './workflow-control.ts'

const refuse = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', message)],
})

type Conclusion = ContextEffectIntent['negatives'][number]['reportConclusion']
type IntentCall = ContextEffectIntent['negatives'][number]['calls'][number]
type IntentNegative = ContextEffectIntent['negatives'][number]

function same(left: unknown, right: unknown): boolean {
  return canonicalValueDigest(left) === canonicalValueDigest(right)
}

function admitEnvelope(observation: NativeToolObservation): Result<void> {
  if (observation.scope !== 'guarded-tool-admission')
    return refuse('Effect review requires guarded-tool-admission observations')
  if (observation.boundary === 'open' || observation.boundary === 'invalid')
    return refuse('Effect review refuses open or invalid native tool observation boundaries')
  if (observation.boundary !== 'closed' || observation.closedBy !== 'settlement-fence')
    return refuse('Effect review requires settlement-fence closed native tool observations')
  for (const call of observation.calls) {
    if (
      call.completion === 'pending' ||
      call.completion === 'deferred' ||
      call.completion === 'ambiguous' ||
      call.completion === 'unavailable'
    )
      return refuse('Effect review refuses unresolved native tool call completions')
    if (call.completion !== 'returned') return refuse('Effect review requires returned native tool calls')
    if (call.inputDigest === null || call.resultDigest === null || call.isError === null)
      return refuse('Effect review requires available input, result and error metadata on returned calls')
  }
  return { ok: true, value: undefined }
}

function admitConclusion(conclusion: Conclusion, label: string): Result<void> {
  if (conclusion.kind === 'unresolved') return refuse(`Effect review refuses unresolved ${label}`)
  if (conclusion.kind === 'none-identified') {
    if (conclusion.reason.length === 0) return refuse(`Effect review none-identified ${label} requires a reason`)
    return { ok: true, value: undefined }
  }
  if (conclusion.resourceKeys.length === 0) return refuse(`Effect review local-files ${label} requires resource keys`)
  if (new Set(conclusion.resourceKeys).size !== conclusion.resourceKeys.length)
    return refuse(`Effect review local-files ${label} repeats resource keys`)
  if (conclusion.reason.length === 0) return refuse(`Effect review local-files ${label} requires a reason`)
  return { ok: true, value: undefined }
}

function requiredCalls(observations: readonly NativeToolObservation[]): Array<Omit<IntentCall, 'conclusion'>> {
  const required: Array<Omit<IntentCall, 'conclusion'>> = []
  for (const observation of observations) {
    for (const call of observation.calls) {
      if (call.toolName === 'yield') continue
      required.push({
        childId: observation.childId,
        sessionId: observation.sessionId,
        ordinal: call.ordinal,
        toolCallId: call.toolCallId,
        callDigest: canonicalValueDigest(call),
      })
    }
  }
  return required
}

function callKey(call: Pick<IntentCall, 'childId' | 'sessionId' | 'ordinal' | 'toolCallId' | 'callDigest'>): string {
  return `${call.childId}\0${call.sessionId}\0${call.ordinal}\0${call.toolCallId}\0${call.callDigest}`
}

function admitCalls(negative: IntentNegative, observations: readonly NativeToolObservation[]): Result<void> {
  const expected = requiredCalls(observations)
  if (negative.calls.length !== expected.length)
    return refuse('Effect review call coverage does not match observed non-yield calls')
  const seen = new Set<string>()
  for (const call of negative.calls) {
    const key = callKey(call)
    if (seen.has(key)) return refuse('Effect review repeats a native tool call conclusion')
    seen.add(key)
    if (!expected.some((item) => callKey(item) === key))
      return refuse('Effect review cites a foreign or stale native tool call')
    const admitted = admitConclusion(call.conclusion, 'call conclusion')
    if (!admitted.ok) return admitted
  }
  for (const item of expected) {
    if (!seen.has(callKey(item))) return refuse('Effect review is missing a required native tool call conclusion')
  }
  return { ok: true, value: undefined }
}

function admitState(expected: ContextLocalFileState, observation: ContextLocalFileObservation): Result<void> {
  if (!same(expected, observation.state))
    return refuse('Effect review observed file state does not match the proposed expected state')
  if (observation.state.kind === 'absent') {
    if (observation.file !== null) return refuse('Absent file observation must not carry file identity')
    return { ok: true, value: undefined }
  }
  if (observation.file === null) return refuse('Regular file observation requires file identity')
  return { ok: true, value: undefined }
}

function matchesResourcePath(observation: ContextLocalFileObservation): boolean {
  return [posix, win32].some(
    (path) =>
      path.isAbsolute(observation.absolutePath) &&
      path.normalize(observation.absolutePath) === observation.absolutePath &&
      path.dirname(observation.absolutePath) === observation.canonicalParent &&
      path.basename(observation.absolutePath) === observation.leaf &&
      path.join(observation.canonicalParent, observation.leaf) === observation.absolutePath,
  )
}

function admitResource(
  observation: ContextLocalFileObservation,
  intent: ContextEffectIntent['resources'][number] | undefined,
  namespaceId: string,
): Result<void> {
  if (observation.namespaceId !== namespaceId)
    return refuse('Effect review resource namespace does not match the live observer namespace')
  if (intent === undefined) return refuse('Effect review observes a foreign resource key')
  if (observation.absolutePath !== intent.absolutePath)
    return refuse('Effect review resource path does not match intent')
  if (!matchesResourcePath(observation))
    return refuse('Effect review resource path does not match canonical parent and leaf')
  const terminal = observation.ancestry.at(-1)
  if (terminal === undefined || terminal.path !== observation.canonicalParent)
    return refuse('Effect review resource ancestry must terminate at canonicalParent')
  return admitState(intent.expected, observation)
}

function admitResources(review: ContextEffectReview): Result<void> {
  const intentByKey = new Map<string, ContextEffectIntent['resources'][number]>()
  for (const resource of review.intent.resources) {
    intentByKey.set(resource.key, resource)
  }
  const observedKeys = new Set<string>()
  for (const observation of review.resources) {
    if (observedKeys.has(observation.key)) return refuse('Effect review observes duplicate resource keys')
    observedKeys.add(observation.key)
    const admitted = admitResource(observation, intentByKey.get(observation.key), review.namespace.id)
    if (!admitted.ok) return admitted
  }
  if (observedKeys.size !== intentByKey.size)
    return refuse('Effect review resource observations must cover intent resources exactly once')
  return { ok: true, value: undefined }
}

function admitNegative(negative: IntentNegative, source: ContextEffectReview['sources'][number]): Result<void> {
  if (!same(negative.source, source.source))
    return refuse('Effect review negative source does not match conserved chain source')
  if (!same(negative.inventory, source.inventory))
    return refuse('Effect review inventory does not match conserved observation inventory')
  const report = admitConclusion(negative.reportConclusion, 'report conclusion')
  if (!report.ok) return report
  for (const observation of source.observations) {
    const envelope = admitEnvelope(observation)
    if (!envelope.ok) return envelope
  }
  if (source.inventory.kind === 'unavailable') {
    if (source.observations.length !== 0)
      return refuse('Unavailable effect inventory must not synthesize observation envelopes')
    if (negative.calls.length !== 0) return refuse('Unavailable effect inventory must not synthesize call conclusions')
    return { ok: true, value: undefined }
  }
  return admitCalls(negative, source.observations)
}

function referenceResources(conclusion: Conclusion, referenced: Set<string>): void {
  if (conclusion.kind !== 'local-files') return
  for (const key of conclusion.resourceKeys) referenced.add(key)
}

function admitIntentResourceKeys(intent: ContextEffectIntent): Result<void> {
  const intentKeys = new Set<string>()
  for (const resource of intent.resources) {
    if (intentKeys.has(resource.key)) return refuse('Effect review intent defines duplicate resource keys')
    intentKeys.add(resource.key)
  }
  const referenced = new Set<string>()
  for (const negative of intent.negatives) {
    referenceResources(negative.reportConclusion, referenced)
    for (const call of negative.calls) referenceResources(call.conclusion, referenced)
  }
  for (const key of referenced) {
    if (!intentKeys.has(key)) return refuse('Effect review references an undefined resource key')
  }
  if (referenced.size !== intentKeys.size) return refuse('Effect review contains an unreferenced resource')
  return { ok: true, value: undefined }
}

function admitIntent(intent: ContextEffectIntent, sources: ContextEffectSources): Result<void> {
  if (intent.format !== 'omp-build-context-effect-intent/1')
    return refuse('Effect review intent format is not omp-build-context-effect-intent/1')
  if (intent.negatives.length !== sources.length)
    return refuse('Effect review must cover every authenticated negative-chain source exactly once')
  const remaining = new Map(
    intent.negatives.map((negative) => [canonicalValueDigest(negative.source), negative] as const),
  )
  if (remaining.size !== intent.negatives.length) return refuse('Effect review repeats a negative source')
  for (const source of sources) {
    const key = canonicalValueDigest(source.source)
    const matched = remaining.get(key)
    if (matched === undefined) return refuse('Effect review negative source does not match conserved chain source')
    remaining.delete(key)
    const admitted = admitNegative(matched, source)
    if (!admitted.ok) return admitted
  }
  if (remaining.size !== 0) return refuse('Effect review cites a foreign or stale negative source')
  return admitIntentResourceKeys(intent)
}

/**
 * Pre-sample coverage: same chain/report/call/conclusion/resource-reference policy and
 * pending/deferred/unknown hard stops as validateContextEffectReview, before any named-file read.
 * Returns transient report views for native Details; not a durable authority copy.
 */
export function inspectContextEffectIntent(
  chain: readonly ReceiptRecord[],
  intent: ContextEffectIntent,
): Result<{ sources: ContextEffectSources; reports: ContextEffectReportView[] }> {
  const collected = contextEffectSources(chain)
  if (!collected.ok) return collected
  const admitted = admitIntent(intent, collected.value.sources)
  if (!admitted.ok) return admitted
  return collected
}

/**
 * Full admission after host sampling: reuses inspectContextEffectIntent, then checks persisted
 * source facts and concrete observed resources under the live confirmation-local-observer namespace.
 */
export function validateContextEffectReview(
  chain: readonly ReceiptRecord[],
  review: ContextEffectReview,
): Result<void> {
  if (review.format !== 'omp-build-context-effect-review/1')
    return refuse('Effect review format is not omp-build-context-effect-review/1')
  if (review.namespace.kind !== 'confirmation-local-observer')
    return refuse('Effect review namespace must be a confirmation-local-observer')
  const inspected = inspectContextEffectIntent(chain, review.intent)
  if (!inspected.ok) return inspected
  if (!same(review.sources, inspected.value.sources))
    return refuse('Effect review sources do not match the authenticated negative-chain inventory')
  return admitResources(review)
}
