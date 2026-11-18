import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  contextEffectIntentSchema,
  inspectContextEffectIntent,
  validateContextEffectReview,
} from '../dist/contracts.js'
import type { ContextEffectIntent, ContextEffectReview } from '../engine/context-effect-review-schema.ts'
import type { ContextEffectReportView } from '../engine/context-effect-sources.ts'
import type { ReceiptRecord } from '../engine/workflow-control.ts'
import type { ContextLocalFileObserver } from './context-local-file-observer.ts'

export type ContextEffectObservationInput = {
  intent: ContextEffectIntent
  observer: ContextLocalFileObserver
}

export async function readContextEffectIntent(
  path: string,
): Promise<{ ok: true; value: ContextEffectIntent } | { ok: false; reason: string }> {
  if (!isAbsolute(path) || typeof constants.O_NONBLOCK !== 'number')
    return { ok: false, reason: 'context-effect-intent-file-invalid' }
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) return { ok: false, reason: 'context-effect-intent-file-invalid' }
      const parsed = contextEffectIntentSchema.safeParse(JSON.parse(await file.readFile('utf8')))
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'context-effect-intent-invalid' }
    } finally {
      await file.close()
    }
  } catch {
    return { ok: false, reason: 'context-effect-intent-unavailable' }
  }
}

export async function observeContextEffects(
  chain: readonly ReceiptRecord[],
  input: ContextEffectObservationInput,
): Promise<
  { ok: true; value: ContextEffectReview; reports: ContextEffectReportView[] } | { ok: false; reason: string }
> {
  const inspected = inspectContextEffectIntent(chain, input.intent)
  if (!inspected.ok)
    return { ok: false, reason: inspected.diagnostics[0]?.message ?? 'context-effect-review-unconfirmed' }
  const observed = await input.observer.observe(input.intent.resources)
  if (!observed.ok) return observed
  const review: ContextEffectReview = {
    format: 'omp-build-context-effect-review/1',
    namespace: input.observer.namespace,
    intent: input.intent,
    sources: inspected.value.sources,
    resources: observed.value,
  }
  const admitted = validateContextEffectReview(chain, review)
  return admitted.ok
    ? { ok: true, value: review, reports: inspected.value.reports }
    : { ok: false, reason: admitted.diagnostics[0]?.message ?? 'context-effect-review-unconfirmed' }
}
