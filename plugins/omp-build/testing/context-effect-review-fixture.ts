import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type {
  ContextEffectIntent,
  ContextEffectNamespace,
  ContextEffectReview,
  ContextEffectSources,
} from '../engine/context-effect-review-schema.ts'
import { type ContextEffectReportView, contextEffectSources } from '../engine/context-effect-sources.ts'
import type { Scope } from '../engine/schema-primitives.ts'
import { qualifyContextNegative } from '../engine/workflow-context-succession-negative.ts'
import { historyFor, type ReceiptRecord, recordsOf } from '../engine/workflow-control.ts'
import { type ContextLocalFileObserver, createContextLocalFileObserver } from '../roxabi/context-local-file-observer.ts'
import { readSuccessionBasis } from '../roxabi/feature-succession.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'

const DEFAULT_NONE_IDENTIFIED_REASON =
  'Fixture human attribution: no named local-file effects identified for this conserved negative; empty producer commands are not absence proof.'

export function fixtureScopeFromReference(reference: string, repository = 'acme/app'): Scope {
  const number = reference.trim().replace(/^#/, '')
  if (number.length === 0) throw new Error('fixture-scope-reference-invalid')
  return { repository, target: `${repository}#${number}` }
}

/** Explicit fictional none-identified coverage for every authenticated source and required non-yield call. */
export function fictionalNoneIdentifiedEffectIntent(
  sources: ContextEffectSources,
  reason: string = DEFAULT_NONE_IDENTIFIED_REASON,
): ContextEffectIntent {
  if (sources.length === 0) throw new Error('fictional-effect-intent-requires-sources')
  if (reason.length === 0) throw new Error('fictional-effect-intent-requires-reason')
  return {
    format: 'omp-build-context-effect-intent/1',
    negatives: sources.map((source) => ({
      source: source.source,
      inventory: source.inventory,
      reportConclusion: { kind: 'none-identified', reason },
      calls:
        source.inventory.kind === 'unavailable'
          ? []
          : source.observations.flatMap((observation) =>
              observation.calls
                .filter((call) => call.toolName !== 'yield')
                .map((call) => ({
                  childId: observation.childId,
                  sessionId: observation.sessionId,
                  ordinal: call.ordinal,
                  toolCallId: call.toolCallId,
                  callDigest: canonicalValueDigest(call),
                  conclusion: { kind: 'none-identified' as const, reason },
                })),
            ),
    })),
    resources: [],
  }
}

export function fictionalNoneIdentifiedEffectIntentForChain(
  chain: readonly ReceiptRecord[],
  reason: string = DEFAULT_NONE_IDENTIFIED_REASON,
): { intent: ContextEffectIntent; sources: ContextEffectSources; reports: ContextEffectReportView[] } {
  const collected = contextEffectSources(chain)
  if (!collected.ok) throw new Error(collected.diagnostics[0]?.message ?? 'context-effect-sources-unconfirmed')
  return {
    intent: fictionalNoneIdentifiedEffectIntent(collected.value.sources, reason),
    sources: collected.value.sources,
    reports: collected.value.reports,
  }
}

export function writeContextEffectIntentFile(absolutePath: string, intent: ContextEffectIntent): string {
  if (!isAbsolute(absolutePath)) throw new Error('context-effect-intent-path-must-be-absolute')
  writeFileSync(absolutePath, `${JSON.stringify(intent, null, 2)}\n`)
  return absolutePath
}

/**
 * Full proposal/disposition reconciliation only.
 * Never attach to ContextSuccessionManagedBaseline / ContextSuccessionObservation.reconciliation
 * (cold current samples are managed-only and must omit effectReview).
 */
export function fictionalContextEffectReview(input: {
  sources: ContextEffectSources
  namespace: ContextEffectNamespace
  reason?: string
}): ContextEffectReview {
  return {
    format: 'omp-build-context-effect-review/1',
    namespace: input.namespace,
    intent: fictionalNoneIdentifiedEffectIntent(input.sources, input.reason),
    sources: input.sources,
    resources: [],
  }
}

/**
 * Synthetic unavailable-inventory review + matching transient report views for confirmed
 * succession proposal/UI fixtures. Not a current-observation baseline and not cold-reconstruction proof.
 */
export function fictionalUnavailableEffectViews(input: {
  scope: Scope
  negativeRecordId: string
  payload: unknown
  namespace?: ContextEffectNamespace
  reason?: string
}): {
  effectReview: ContextEffectReview
  effectReports: ContextEffectReportView[]
  negative: ContextEffectIntent['negatives'][number]['source']
} {
  const digest = canonicalValueDigest(input.payload)
  const source: ContextEffectIntent['negatives'][number]['source'] = {
    source: 'record',
    record: { scope: input.scope, kind: 'action-receipt', recordId: input.negativeRecordId },
    selector: '/payload',
    digest,
  }
  const sources: ContextEffectSources = [{ source, inventory: { kind: 'unavailable' }, observations: [] }]
  const namespace =
    input.namespace ??
    ({
      kind: 'confirmation-local-observer',
      id: 'fixture-confirmation-local-observer',
      sessionId: 'fixture-session',
      agentId: 'Main',
    } satisfies ContextEffectNamespace)
  return {
    negative: source,
    effectReview: fictionalContextEffectReview({ sources, namespace, reason: input.reason }),
    effectReports: [{ source, payload: input.payload as ContextEffectReportView['payload'] }],
  }
}

export function createFixtureContextEffectObserverFactory(
  current: () => boolean = () => true,
): () => ContextLocalFileObserver {
  return () =>
    createContextLocalFileObserver(
      {
        kind: 'confirmation-local-observer',
        id: randomUUID(),
        sessionId: 'fixture-context-effect-session',
        agentId: 'SuccessionFixtures980',
      },
      current,
    )
}

/**
 * Explicit foreign/absent-negative fixture intent (unavailable inventory + zero digest).
 * Only for scenarios that intentionally lack a conserved negative; never a prepare-error fallback.
 * Succession stays blocked on source mismatch / unavailable inventory.
 */
export function writePlaceholderNoneIdentifiedEffectsFile(input: {
  scope: Scope
  negativeRecordId: string
  directory?: string
  reason?: string
}): { effectsFile: string; intent: ContextEffectIntent } {
  const sources: ContextEffectSources = [
    {
      source: {
        source: 'record',
        record: { scope: input.scope, kind: 'action-receipt', recordId: input.negativeRecordId },
        selector: '/payload',
        digest: '0'.repeat(64),
      },
      inventory: { kind: 'unavailable' },
      observations: [],
    },
  ]
  const intent = fictionalNoneIdentifiedEffectIntent(
    sources,
    input.reason ??
      'Explicit fixture intent: unavailable or foreign conserved negative; not absence proof and not a prepare-error fallback.',
  )
  const directory = input.directory ?? mkdtempSync(join(tmpdir(), 'context-effect-intent-'))
  mkdirSync(directory, { recursive: true })
  return {
    effectsFile: writeContextEffectIntentFile(join(directory, 'context-effect-intent.json'), intent),
    intent,
  }
}

/**
 * Fixture-only path for intentionally malformed conserved receipts (e.g. raw-positive /
 * projected-negative). Reads the live receipt digest and writes none-identified intent WITHOUT
 * qualifyContextNegative, so the public handoff gate can refuse reconciliation itself.
 * Not a prepare-error fallback and not absence-of-effects proof.
 */
export async function prepareIntentionalUnqualifiedHandoffEffects(input: {
  cwd: string
  scope: Scope
  negativeRecordId: string
  directory?: string
  reason?: string
}): Promise<{ effectsFile: string; intent: ContextEffectIntent; sources: ContextEffectSources }> {
  const read = await createInstalledUwReadPort({ cwd: input.cwd, readAuthor: 'operator' }).readUw(input.scope)
  const history = historyFor(input.scope, read.histories)
  if (history === null) throw new Error('context-effect-fixture-history-unavailable')
  const matches = recordsOf(history).filter(
    (record) => record.kind === 'action-receipt' && record.recordId === input.negativeRecordId,
  )
  const leaf = matches[0]
  if (matches.length !== 1 || leaf?.kind !== 'action-receipt')
    throw new Error('context-effect-fixture-negative-unavailable')
  const sources: ContextEffectSources = [
    {
      source: {
        source: 'record',
        record: { scope: input.scope, kind: 'action-receipt', recordId: leaf.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(leaf.payload),
      },
      inventory: { kind: 'unavailable' },
      observations: [],
    },
  ]
  const intent = fictionalNoneIdentifiedEffectIntent(
    sources,
    input.reason ??
      'Explicit fixture intent: conserved receipt intentionally unqualified as context-negative; public handoff must refuse.',
  )
  const directory = input.directory ?? mkdtempSync(join(tmpdir(), 'context-effect-intent-'))
  mkdirSync(directory, { recursive: true })
  return {
    effectsFile: writeContextEffectIntentFile(join(directory, 'context-effect-intent.json'), intent),
    intent,
    sources,
  }
}

/**
 * Reads the live conserved negative chain and writes an explicit none-identified intent file.
 * Uses the same abandoned-tip / historical handoff basis as qualifyHandoff (not selectedMandate /
 * current authority), so post-abandon recovery can still attribute the negative-linked mandate.
 */
export async function prepareFictionalNoneIdentifiedHandoffEffects(input: {
  cwd: string
  scope: Scope
  negativeRecordId: string
  directory?: string
  reason?: string
}): Promise<{
  effectsFile: string
  intent: ContextEffectIntent
  sources: ContextEffectSources
  reports: ContextEffectReportView[]
}> {
  const read = await createInstalledUwReadPort({ cwd: input.cwd, readAuthor: 'operator' }).readUw(input.scope)
  const history = historyFor(input.scope, read.histories)
  if (history === null) throw new Error('context-effect-fixture-history-unavailable')
  const matches = recordsOf(history).filter(
    (record) => record.kind === 'action-receipt' && record.recordId === input.negativeRecordId,
  )
  const leaf = matches[0]
  if (matches.length !== 1 || leaf?.kind !== 'action-receipt')
    throw new Error('context-effect-fixture-negative-unavailable')
  const negative = {
    source: 'record' as const,
    record: { scope: input.scope, kind: 'action-receipt' as const, recordId: leaf.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(leaf.payload),
  }
  // Mirror feature-context-handoff-observation.qualifyHandoff: terminal abandoned tip + abandonment
  // accepted-spec resolution, never current selectedMandate (refused after abandon).
  const basis = readSuccessionBasis(history, read.histories, true)
  if (!basis.ok) throw new Error(basis.diagnostics[0]?.message ?? 'context-effect-fixture-mandate-unavailable')
  const qualified = qualifyContextNegative({
    mandate: basis.value.terminal.mandate,
    histories: read.histories,
    negative,
  })
  if (!qualified.ok) throw new Error(qualified.diagnostics[0]?.message ?? 'context-effect-fixture-negative-unconfirmed')
  if (
    leaf.payload.phase !== 'result' ||
    leaf.payload.mandate.kind !== 'mandate' ||
    leaf.payload.mandate.recordId !== basis.value.terminal.ref.recordId
  )
    throw new Error('context-effect-fixture-negative-mandate-mismatch')
  const prepared = fictionalNoneIdentifiedEffectIntentForChain(
    qualified.value.negativeChain,
    input.reason ?? DEFAULT_NONE_IDENTIFIED_REASON,
  )
  const directory = input.directory ?? mkdtempSync(join(tmpdir(), 'context-effect-intent-'))
  mkdirSync(directory, { recursive: true })
  const effectsFile = writeContextEffectIntentFile(join(directory, 'context-effect-intent.json'), prepared.intent)
  return { effectsFile, ...prepared }
}
