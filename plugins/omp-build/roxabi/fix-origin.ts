import {
  type CauseContext,
  canonicalValueDigest,
  type PreparedCauseCapture,
  resolveSpecEffective,
  type Scope,
} from '../dist/contracts.js'
import { type FixActionResult, failure } from './fix-contract.ts'
import type { UwReadPort } from './uw-contract.ts'

/** Resolve the current accepted own Spec from the bound UW, never from request prose. */
export async function resolveFixOrigin(
  uw: Scope | undefined,
  reader: UwReadPort,
): Promise<FixActionResult<CauseContext>> {
  if (uw === undefined) return failure('correction-original-uw-required')
  try {
    const read = await reader.readUw(uw)
    if (read.accepted.status !== 'accepted') return failure('correction-spec-not-accepted')
    const effective = resolveSpecEffective({
      mode: 'current',
      own: read.accepted.value.ref,
      histories: read.observation.histories,
      graph: read.observation.graph,
    })
    if (!effective.ok) return failure('correction-spec-not-accepted', ...effective.diagnostics.map((item) => item.code))
    if (effective.value.own.uw.repository !== uw.repository || effective.value.own.uw.target !== uw.target)
      return failure('correction-origin-mismatch')
    return { ok: true, value: { original: uw, effective: effective.value } }
  } catch {
    return failure('correction-spec-not-accepted')
  }
}

/** Re-observe the graph and the complete effective vector immediately before disposition admission. */
export async function dispositionContext(
  causeContext: CauseContext,
  capture: PreparedCauseCapture,
  reader: UwReadPort,
): Promise<
  FixActionResult<{
    causeContext: CauseContext
    capture: PreparedCauseCapture
    graph: import('../engine/uw-graph.ts').UwGraphObservation
  }>
> {
  try {
    const read = await reader.readUw(causeContext.original)
    if (read.accepted.status !== 'accepted') return failure('correction-spec-not-accepted')
    const effective = resolveSpecEffective({
      mode: 'current',
      own: read.accepted.value.ref,
      histories: read.observation.histories,
      graph: read.observation.graph,
    })
    if (!effective.ok || canonicalValueDigest(effective.value) !== canonicalValueDigest(causeContext.effective))
      return failure('correction-origin-stale')
    return { ok: true as const, value: { causeContext, capture, graph: read.observation.graph } }
  } catch {
    return failure('correction-spec-not-accepted')
  }
}
