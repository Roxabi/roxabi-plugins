import { canonicalValueDigest } from '../../engine/action-input.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { equalScope } from '../../engine/record-diagnostics.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { UwDeliveryFacts } from '../../engine/uw-completion-types.ts'
import { integrationOutputSchema } from '../../engine/uw-integration-schema.ts'

type Receipt = NonNullable<DecodedHistory['operations'][number]['record']> & { kind: 'action-receipt' }
type Context = {
  uw: Scope
  repositoryKey: string
  pulls: UwDeliveryFacts['pullRequests']
  integrations: UwDeliveryFacts['integrations'][number][]
  ranges: Map<string, { base: string; head: string }>
}

function addRange(ctx: Context, base: string, head: string): void {
  ctx.ranges.set(`${base}\0${head}`, { base, head })
}

function collectReceipt(ctx: Context, record: Receipt): void {
  const manifest = record.payload.inputs.manifest
  if (
    manifest.code.repository.toLowerCase() !== ctx.repositoryKey ||
    manifest.subject.kind !== 'uw' ||
    !equalScope(manifest.subject.uw, ctx.uw)
  )
    return
  if (ctx.pulls.length > 0) {
    addRange(ctx, manifest.code.base, manifest.code.head)
    for (const pull of ctx.pulls) if (pull.mergeCommit !== null) addRange(ctx, manifest.code.base, pull.mergeCommit)
  }
  if (record.payload.phase !== 'result' || record.payload.action !== 'integrate') return
  const result = integrationOutputSchema.safeParse(record.payload.structured)
  if (!result.success || result.data.code.repository.toLowerCase() !== ctx.repositoryKey) return
  ctx.integrations.push({
    source: {
      source: 'record',
      record: {
        scope: { repository: record.repository, target: record.target },
        recordId: record.recordId,
        kind: record.kind,
      },
      selector: '/payload/structured/code',
      digest: canonicalValueDigest(result.data.code),
    },
    code: result.data.code,
  })
  addRange(ctx, result.data.code.base, result.data.code.head)
}

export function collectDeliveryIntegrations(
  uw: Scope,
  histories: readonly DecodedHistory[],
  pulls: UwDeliveryFacts['pullRequests'],
  integrations: UwDeliveryFacts['integrations'][number][],
): Map<string, { base: string; head: string }> {
  const ctx: Context = { uw, repositoryKey: uw.repository.toLowerCase(), pulls, integrations, ranges: new Map() }
  for (const history of histories) {
    for (const operation of history.operations) {
      const record = operation.record
      if (record?.kind === 'action-receipt') collectReceipt(ctx, record)
    }
  }
  return ctx.ranges
}
