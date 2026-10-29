import { createHash } from 'node:crypto'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import type { SpecIdentityLedger } from './uw-identity.ts'
import {
  SPEC_CONTENT_FORMAT,
  type Spec,
  type SpecContent,
  type SpecItemId,
  type SpecVersion,
  specContentSchema,
  specSchema,
} from './uw-spec-schema.ts'

export type { ExclusionRef, OwnSpecRef } from './uw-spec-schema.ts'
export {
  type CriterionId,
  criterionIdSchema,
  type DraftItem,
  exclusionRefSchema,
  type InvariantId,
  invariantIdSchema,
  ownSpecRefSchema,
  SPEC_CONTENT_FORMAT,
  type Spec,
  type SpecContent,
  type SpecDraft,
  type SpecItemId,
  type SpecRawSource,
  type SpecSnapshot,
  type SpecVersion,
  specContentSchema,
  specDraftSchema,
  specRawSourceSchema,
  specSchema,
  specSnapshotSchema,
  type UwTier,
  uwTierSchema,
} from './uw-spec-schema.ts'
export function normalized(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '')
}
function contentOf(content: SpecContent): SpecContent {
  return {
    format: SPEC_CONTENT_FORMAT,
    criteria: content.criteria.map((item) => ({ ...item, statement: normalized(item.statement) })),
    invariants: content.invariants.map((item) => ({ ...item, statement: normalized(item.statement) })),
    exclusions: content.exclusions.map(normalized),
    openQuestions: content.openQuestions.map(normalized),
    sections: {
      origin: normalized(content.sections.origin),
      context: normalized(content.sections.context),
      change: normalized(content.sections.change),
    },
  }
}
export function specVersion(content: SpecContent): SpecVersion {
  return createHash('sha256')
    .update(JSON.stringify(contentOf(content)), 'utf8')
    .digest('hex')
}

function location(uw: Scope, path: (string | number)[], id?: SpecItemId): UwDiagnostic['location'] {
  return { kind: 'spec', uw, path, ...(id === undefined ? {} : { id }) }
}

export function canonicalSpec(content: SpecContent): Result<Spec> {
  const normalizedContent = contentOf(content)
  const parsed = specContentSchema.safeParse(normalizedContent)
  return parsed.success
    ? { ok: true, value: { ...parsed.data, version: specVersion(parsed.data) } }
    : {
        ok: false,
        diagnostics: [{ code: 'spec-invalid', message: parsed.error.issues.map((issue) => issue.message).join('; ') }],
      }
}
export function validateSpecIds(spec: Spec, ledger: SpecIdentityLedger): UwResult<Spec> {
  const diagnostics: UwDiagnostic[] = []
  const seen = new Set<string>()
  for (const [section, items] of [
    ['criteria', spec.criteria],
    ['invariants', spec.invariants],
  ] as const) {
    items.forEach((item, index) => {
      if (seen.has(item.id))
        diagnostics.push({
          code: 'spec-id-duplicate',
          message: `Spec item ${item.id} is repeated`,
          location: location(ledger.uw, [section, index], item.id),
          related: [],
        })
      seen.add(item.id)
    })
  }
  const parsed = specSchema.safeParse(spec)
  if (!parsed.success)
    diagnostics.push(
      ...parsed.error.issues.map((issue) => ({
        code: 'spec-invalid',
        message: issue.message,
        location: location(
          ledger.uw,
          issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        ),
        related: [],
      })),
    )
  if (!parsed.success) return { ok: false, diagnostics }
  for (const [section, items] of [
    ['criteria', spec.criteria],
    ['invariants', spec.invariants],
  ] as const) {
    items.forEach((item, index) => {
      if (ledger.retired.has(item.id))
        diagnostics.push({
          code: 'spec-id-retired',
          message: `Spec item ${item.id} is retired`,
          location: location(ledger.uw, [section, index], item.id),
          related: [],
        })
      else if (!ledger.allocations.has(item.id))
        diagnostics.push({
          code: 'spec-id-unallocated',
          message: `Spec item ${item.id} has no durable allocation`,
          location: location(ledger.uw, [section, index], item.id),
          related: [],
        })
    })
  }
  return diagnostics.length === 0 ? { ok: true, value: spec } : { ok: false, diagnostics }
}
