import { canonicalValueDigest } from './canonical-value.ts'
import {
  type ContextEffectIntent,
  type ContextEffectSources,
  contextEffectNegativeRefSchema,
} from './context-effect-review-schema.ts'
import type { NativeToolObservation } from './native-tool-observation-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Contribution, NativeOutcome } from './record-values.ts'
import type { Result } from './result.ts'
import type { Json } from './schema-primitives.ts'
import type { ReceiptRecord } from './workflow-control.ts'

export type ContextEffectReportView = {
  source: ContextEffectIntent['negatives'][number]['source']
  /** Transient conserved payload for native human display — not a durable copy or authority. */
  payload: Json
}

const refuse = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', message)],
})

type ObservationSlot =
  | { kind: 'root'; native: NativeOutcome }
  | { kind: 'contribution'; index: number; contribution: Contribution }

type PositionedObservation = {
  slot: { kind: 'root' } | { kind: 'contribution'; index: number }
  observation: NativeToolObservation | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sourceRef(record: ReceiptRecord): ContextEffectIntent['negatives'][number]['source'] {
  return contextEffectNegativeRefSchema.parse({
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: 'action-receipt',
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  })
}

function terminalChildId(native: NativeOutcome): string | null {
  if (native.observation?.childId) return native.observation.childId
  const raw = object(native.raw)
  return typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : null
}

function contributionIdentity(contribution: Contribution): { actionId: string; childId: string } | null {
  const actionId = contribution.host.action?.actionId ?? contribution.native?.observation?.actionId
  const childId = contribution.host.childId ?? contribution.native?.observation?.childId ?? null
  if (actionId === undefined || actionId.length === 0 || childId === null || childId.length === 0) return null
  if (
    contribution.native?.observation !== undefined &&
    (contribution.native.observation.actionId !== actionId || contribution.native.observation.childId !== childId)
  )
    return null
  return { actionId, childId }
}

type ResultReceiptPayload = Extract<ReceiptRecord['payload'], { phase: 'result' }>

function terminalRootIdentity(
  payload: ResultReceiptPayload,
  observation: NativeToolObservation,
): { actionId: string; childId: string } | null {
  const native = payload.native
  const terminalChild = terminalChildId(native)
  if (terminalChild === null || observation.childId !== terminalChild) return null
  if (native.observation !== undefined) {
    if (observation.actionId !== native.observation.actionId || observation.childId !== native.observation.childId)
      return null
    return { actionId: native.observation.actionId, childId: native.observation.childId }
  }
  if (observation.actionId !== payload.actionId) return null
  return { actionId: payload.actionId, childId: terminalChild }
}

/** Plan-review root retains the negative specialist child outcome (feature-plan-review-result). */
function planReviewNestedIdentity(
  contributions: readonly Contribution[],
  observation: NativeToolObservation,
): { actionId: string; childId: string } | null {
  for (const contribution of contributions) {
    const identity = contributionIdentity(contribution)
    if (identity === null) continue
    if (observation.actionId !== identity.actionId || observation.childId !== identity.childId) continue
    const contributionObservation = contribution.native?.observedTools
    if (
      contributionObservation !== undefined &&
      canonicalValueDigest(contributionObservation) !== canonicalValueDigest(observation)
    )
      continue
    return identity
  }
  return null
}

function rootIdentity(
  payload: ResultReceiptPayload,
  observation: NativeToolObservation,
): { actionId: string; childId: string } | null {
  const terminal = terminalRootIdentity(payload, observation)
  if (terminal !== null) return terminal
  if (payload.action !== 'plan-review') return null
  return planReviewNestedIdentity(payload.contributions, observation)
}

function authenticateEnvelope(
  observation: NativeToolObservation,
  identity: { actionId: string; childId: string } | null,
): Result<void> {
  if (observation.scope !== 'guarded-tool-admission')
    return refuse('Native tool observation scope is not guarded-tool-admission')
  if (identity === null) return refuse('Native tool observation actionId does not match authenticated receipt identity')
  if (observation.actionId !== identity.actionId)
    return refuse('Native tool observation actionId does not match authenticated receipt identity')
  if (observation.childId !== identity.childId)
    return refuse('Native tool observation childId does not match authenticated terminal identity')
  return { ok: true, value: undefined }
}

function slotsFor(record: ReceiptRecord): Result<ObservationSlot[]> {
  if (record.payload.phase !== 'result') return refuse('Context effect source is not a result receipt')
  const slots: ObservationSlot[] = [{ kind: 'root', native: record.payload.native }]
  if (record.payload.action === 'plan-review') {
    record.payload.contributions.forEach((contribution, index) => {
      slots.push({ kind: 'contribution', index, contribution })
    })
  }
  return { ok: true, value: slots }
}

function positioned(slots: readonly ObservationSlot[], record: ReceiptRecord): Result<PositionedObservation[]> {
  const payload = record.payload
  if (payload.phase !== 'result') return refuse('Context effect source is not a result receipt')
  const positionedSlots: PositionedObservation[] = []
  for (const slot of slots) {
    const position: PositionedObservation['slot'] =
      slot.kind === 'root' ? { kind: 'root' } : { kind: 'contribution', index: slot.index }
    const native = slot.kind === 'root' ? slot.native : slot.contribution.native
    if (native === null || native.observedTools === undefined) {
      positionedSlots.push({ slot: position, observation: null })
      continue
    }
    const observation = native.observedTools
    const identity = slot.kind === 'root' ? rootIdentity(payload, observation) : contributionIdentity(slot.contribution)
    const auth = authenticateEnvelope(observation, identity)
    if (!auth.ok) return auth
    positionedSlots.push({ slot: position, observation })
  }
  return { ok: true, value: positionedSlots }
}

function inventoryOf(positions: readonly PositionedObservation[]): ContextEffectSources[number]['inventory'] {
  const digest = canonicalValueDigest(
    positions.map((position) => ({
      slot: position.slot,
      observation: position.observation === null ? null : canonicalValueDigest(position.observation),
    })),
  )
  const present = positions.filter((position) => position.observation !== null).length
  if (present === 0) return { kind: 'unavailable' }
  if (present === positions.length) return { kind: 'captured', digest }
  return { kind: 'partially-captured', digest }
}

function distinctObservations(positions: readonly PositionedObservation[]): Result<NativeToolObservation[]> {
  const observations: NativeToolObservation[] = []
  const byChildSession = new Map<string, string>()
  for (const position of positions) {
    const observation = position.observation
    if (observation === null) continue
    const key = `${observation.childId}\0${observation.sessionId}`
    const digest = canonicalValueDigest(observation)
    const prior = byChildSession.get(key)
    if (prior === undefined) {
      byChildSession.set(key, digest)
      observations.push(observation)
      continue
    }
    if (prior !== digest) return refuse('Conflicting native tool observations for the same child session')
  }
  return { ok: true, value: observations }
}

/** Derive conserved observation inventory and display payloads for every authenticated negative. */
export function contextEffectSources(
  chain: readonly ReceiptRecord[],
): Result<{ sources: ContextEffectSources; reports: ContextEffectReportView[] }> {
  if (chain.length === 0) return refuse('Context effect sources require at least one negative receipt')
  const sources: ContextEffectSources = []
  const reports: ContextEffectReportView[] = []
  for (const record of chain) {
    const source = sourceRef(record)
    const slots = slotsFor(record)
    if (!slots.ok) return slots
    const positions = positioned(slots.value, record)
    if (!positions.ok) return positions
    const observations = distinctObservations(positions.value)
    if (!observations.ok) return observations
    sources.push({
      source,
      inventory: inventoryOf(positions.value),
      observations: observations.value,
    })
    reports.push({ source, payload: record.payload as Json })
  }
  return { ok: true, value: { sources, reports } }
}
