import { createHash } from 'node:crypto'
import {
  type ActionInputManifest,
  type ActionInputs,
  actionInputsSchema,
  type DeliveryDataRef,
  type PinnedFileRef,
  type RecordInputRef,
} from './action-input-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'

type RefLike = RecordInputRef | PinnedFileRef

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = ordered(source[key])
    return sorted
  }
  return value
}

function recordIdentity(ref: RecordInputRef): string {
  return [
    ref.record.scope.repository,
    ref.record.scope.target,
    ref.record.kind,
    ref.record.recordId,
    ref.selector,
  ].join('\0')
}

function pinnedIdentity(ref: PinnedFileRef): string {
  return [ref.repository, ref.commit, ref.path].join('\0')
}

function refIdentity(ref: RefLike): string {
  return ref.source === 'record' ? `record\0${recordIdentity(ref)}` : `file\0${pinnedIdentity(ref)}`
}

function byIdentity(left: RefLike, right: RefLike): number {
  const leftKey = refIdentity(left)
  const rightKey = refIdentity(right)
  if (leftKey < rightKey) return -1
  if (leftKey > rightKey) return 1
  return 0
}

function durableSource(raw: { reference: string; body: string; bodySha256: string }): {
  reference: string
  body: string
  bodySha256: string
} {
  return { reference: raw.reference, body: raw.body, bodySha256: raw.bodySha256 }
}

function durableSpec(spec: ActionInputManifest['spec']) {
  if (spec.kind === 'proposed') {
    return {
      kind: spec.kind,
      uw: spec.uw,
      snapshot: { spec: spec.snapshot.spec, raw: durableSource(spec.snapshot.raw) },
    }
  }
  if (spec.kind === 'unframed') {
    return { kind: spec.kind, uw: spec.uw, source: durableSource(spec.source), parser: spec.parser }
  }
  return spec
}

function sortedManifest(manifest: ActionInputManifest): ActionInputManifest {
  return {
    ...manifest,
    acceptedSources: [...manifest.acceptedSources].sort(byIdentity),
    deliveryData: [...manifest.deliveryData].sort(byIdentity),
    repositoryReferences: [...manifest.repositoryReferences].sort(byIdentity),
    plugin: { ...manifest.plugin, files: [...manifest.plugin.files].sort(byIdentity) },
    expandedContext: [...manifest.expandedContext].sort(byIdentity),
  }
}

/** Lexical UTF-8 JSON of the durable manifest. Set-valued refs are identity-sorted. Spec order is preserved. Observed lastEditedAt stays on the wire snapshot and is omitted here. */
export function canonicalActionInput(manifest: ActionInputManifest): string {
  const sorted = sortedManifest(manifest)
  return JSON.stringify(ordered({ ...sorted, spec: durableSpec(sorted.spec) }))
}

export function actionInputDigest(manifest: ActionInputManifest): string {
  return createHash('sha256').update(canonicalActionInput(manifest), 'utf8').digest('hex')
}

/** Canonical SHA-256 of one selected record value. Identity-sorts object keys; preserves array order. */
export function canonicalValueDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)), 'utf8')
    .digest('hex')
}

function duplicate(refs: readonly RefLike[], label: string, diagnostics: Diagnostic[]): void {
  const seen = new Map<string, string>()
  for (const ref of refs) {
    const key = refIdentity(ref)
    const previous = seen.get(key)
    if (previous === undefined) {
      seen.set(key, ref.digest)
      continue
    }
    diagnostics.push({
      code: previous === ref.digest ? 'duplicate-reference' : 'mismatch',
      message: `${label} repeats ${key}`,
    })
  }
}

const ADMITTED_ROLE_SELECTOR: Record<DeliveryDataRef['role'], RegExp | null> = {
  plan: /^\/payload\/structured$/,
  'plan-review': /^\/payload\/(?:slots(?:\/\d+)?|contributions(?:\/\d+)?)$/,
  implementation: /^\/payload\/(?:structured\/criteria|criterionReceipt\/criteria)\/\d+$/,
  'criterion-evidence': /^\/payload\/(?:structured\/criteria|criterionReceipt\/criteria)\/\d+\/evidence\/\d+$/,
  'correction-lineage': /^\/payload$/,
  // No frozen pointer yet. An unconstrained selector can launder native/raw as proof.
  'external-observation': null,
}

/** Role-owned JSON Pointers only. Unknown or unconstrained roles are refused. */
export function selectorAdmitted(role: DeliveryDataRef['role'], selector: string): boolean {
  return ADMITTED_ROLE_SELECTOR[role]?.test(selector) ?? false
}

export function recordScopeIdentity(ref: RecordInputRef): string {
  return [ref.record.scope.repository, ref.record.scope.target, ref.record.kind, ref.record.recordId].join('\0')
}

/** Current-root outputs only. Prior distinct review context is lawful unless B includes it here. */
export function citesCurrentRootOutput(input: ActionInputs, currentOutputs: readonly RecordInputRef[]): Diagnostic[] {
  const current = new Set(currentOutputs.map(recordScopeIdentity))
  const diagnostics: Diagnostic[] = []
  for (const ref of [
    ...input.manifest.acceptedSources,
    ...input.manifest.deliveryData,
    ...input.manifest.expandedContext,
  ]) {
    if (ref.source !== 'record' || !current.has(recordScopeIdentity(ref))) continue
    diagnostics.push({
      code: 'self-output',
      message: `Normative input repeats current output ${ref.record.recordId}`,
    })
  }
  return diagnostics
}

function stageOverlap(input: ActionInputs, diagnostics: Diagnostic[]): void {
  const stage = new Set(input.stageSources.map(recordScopeIdentity))
  const normative = [
    ...input.manifest.acceptedSources,
    ...input.manifest.deliveryData,
    ...input.manifest.expandedContext,
  ]
  for (const ref of normative) {
    if (ref.source !== 'record') continue
    if (stage.has(recordScopeIdentity(ref))) {
      diagnostics.push({
        code: 'self-output',
        message: `Normative input repeats current output ${ref.record.recordId}`,
      })
    }
  }
  for (const ref of input.manifest.deliveryData) {
    if (!selectorAdmitted(ref.role, ref.selector)) {
      diagnostics.push({
        code: 'malformed',
        message: `Delivery role ${ref.role} does not admit selector ${ref.selector}`,
      })
    }
  }
}

export function validateActionInputs(input: ActionInputs): Result<ActionInputs> {
  const parsed = actionInputsSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, diagnostics: [{ code: 'malformed', message: 'action inputs are not binding/1' }] }
  const diagnostics: Diagnostic[] = []
  const manifest = parsed.data.manifest
  duplicate(manifest.acceptedSources, 'accepted source', diagnostics)
  duplicate(manifest.deliveryData, 'delivery data', diagnostics)
  duplicate(manifest.repositoryReferences, 'repository reference', diagnostics)
  duplicate(manifest.plugin.files, 'plugin file', diagnostics)
  duplicate(manifest.expandedContext, 'expanded context', diagnostics)
  duplicate(parsed.data.stageSources, 'stage source', diagnostics)
  stageOverlap(parsed.data, diagnostics)
  if (parsed.data.fingerprint !== actionInputDigest(manifest)) {
    diagnostics.push({ code: 'mismatch', message: 'action input fingerprint does not match the canonical manifest' })
  }
  return diagnostics.length === 0 ? { ok: true, value: parsed.data } : { ok: false, diagnostics }
}
