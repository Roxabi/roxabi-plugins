import type { IssueSpecAnalysis } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { NormalizationDecision } from '../engine/uw-normalization-schema.ts'
import type { UwProposalInput } from './uw-contract.ts'

type NormalizationTarget = Exclude<NormalizationDecision, { kind: 'removed' }>['target']
type ObligationTarget = Extract<NormalizationTarget, { kind: 'existing' | 'new' }>
type ContentTarget = Exclude<NormalizationTarget, ObligationTarget>
type ContentDestination =
  | { kind: 'section'; section: 'origin' | 'context' | 'change' }
  | { kind: 'exclusion'; index: number }
  | { kind: 'open-question'; index: number }
type ObligationSource = {
  kind: 'criterion' | 'invariant'
  id: string | null
  statement: string
  span: { start: { line: number; column: number }; end: { line: number; column: number } }
}
type ContentSource = {
  kind: 'content' | 'preserved'
  statement: string
  expectedTarget?: ContentDestination
  span: { start: { line: number; column: number }; end: { line: number; column: number } }
}
type Source = ObligationSource | ContentSource
type DraftTargets = {
  obligations: Map<string, { statement: string; family: 'criterion' | 'invariant' }>
  content: Map<string, string>
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function spanKey(span: { start: { line: number; column: number }; end: { line: number; column: number } }): string {
  return `${span.start.line}:${span.start.column}-${span.end.line}:${span.end.column}`
}

function contentTargetKey(target: ContentTarget | ContentDestination): string {
  if (target.kind === 'section') return `section:${target.section}`
  return `${target.kind}:${target.index}`
}

function obligationTargetKey(target: ObligationTarget): string {
  return target.kind === 'existing' ? `existing:${target.id}` : `new:${target.draftKey}`
}

function draftTargets(input: UwProposalInput): DraftTargets {
  const obligations = new Map<string, { statement: string; family: 'criterion' | 'invariant' }>()
  for (const [family, items] of [
    ['criterion', input.draft.criteria],
    ['invariant', input.draft.invariants],
  ] as const) {
    for (const item of items) {
      const key = item.kind === 'existing' ? `existing:${item.id}` : `new:${item.draftKey}`
      obligations.set(key, { statement: item.statement, family })
    }
  }
  const content = new Map<string, string>([
    ['section:origin', input.draft.sections.origin],
    ['section:context', input.draft.sections.context],
    ['section:change', input.draft.sections.change],
    ...input.draft.exclusions.map((value, index) => [`exclusion:${index}`, value] as const),
    ...input.draft.openQuestions.map((value, index) => [`open-question:${index}`, value] as const),
  ])
  return { obligations, content }
}

const SOURCE_DIAGNOSTIC_MESSAGES = {
  'normalization-source-unknown': 'Normalization names a source span not returned by the sole parser',
  'normalization-source-duplicate': 'Normalization accounts for one source span more than once',
} as const

function sourceDiagnostic(uw: Scope, code: keyof typeof SOURCE_DIAGNOSTIC_MESSAGES): UwDiagnostic {
  return diagnostic(uw, code, SOURCE_DIAGNOSTIC_MESSAGES[code])
}

function contentTargetDiagnostics(
  uw: Scope,
  source: ContentSource,
  target: NormalizationTarget,
  draft: DraftTargets,
  coverage: Map<string, { start: number; end: number }[]>,
): UwDiagnostic[] {
  if (target.kind === 'existing' || target.kind === 'new')
    return [diagnostic(uw, 'normalization-content-target-invalid', 'Prose cannot be assigned to an obligation target')]
  if (source.expectedTarget !== undefined && contentTargetKey(source.expectedTarget) !== contentTargetKey(target))
    return [
      diagnostic(uw, 'normalization-content-moved', 'Named content must remain in its parser-declared destination'),
    ]
  return coverContentTarget(uw, target, draft, coverage)
}

function coverContentTarget(
  uw: Scope,
  target: ContentTarget,
  draft: DraftTargets,
  coverage: Map<string, { start: number; end: number }[]>,
): UwDiagnostic[] {
  const value = draft.content.get(contentTargetKey(target))
  if (value === undefined)
    return [diagnostic(uw, 'normalization-target-unknown', 'Normalization content target is absent from the draft')]
  if (target.range.end > value.length)
    return [
      diagnostic(uw, 'normalization-content-range-invalid', 'Normalization content range exceeds its draft value'),
    ]
  const ranges = coverage.get(contentTargetKey(target)) ?? []
  ranges.push(target.range)
  coverage.set(contentTargetKey(target), ranges)
  return []
}

function obligationTargetDiagnostics(
  uw: Scope,
  source: ObligationSource,
  target: NormalizationTarget,
  draft: DraftTargets,
  claimed: Set<string>,
): UwDiagnostic[] {
  if (target.kind !== 'existing' && target.kind !== 'new')
    return [
      diagnostic(uw, 'normalization-obligation-target-invalid', 'A criterion or invariant cannot be assigned to prose'),
    ]
  const key = obligationTargetKey(target)
  const draftTarget = draft.obligations.get(key)
  if (draftTarget === undefined)
    return [diagnostic(uw, 'normalization-target-unknown', 'Normalization target is absent from the draft')]
  if (claimed.has(key))
    return [diagnostic(uw, 'normalization-target-duplicate', 'Normalization target is claimed more than once')]
  claimed.add(key)
  if (draftTarget.family !== source.kind)
    return [
      diagnostic(uw, 'normalization-identity-family-invalid', 'Criteria and invariants retain their identifier family'),
    ]
  if (source.id === null && target.kind !== 'new')
    return [diagnostic(uw, 'normalization-identity-new-invalid', 'Unnamed parser obligations require one draft key')]
  if (source.id !== null && (target.kind !== 'existing' || target.id !== source.id))
    return [
      diagnostic(uw, 'normalization-identity-continuity', 'Identified parser obligations retain the same identifier'),
    ]
  return []
}

function keptDiagnostic(
  uw: Scope,
  decision: Exclude<NormalizationDecision, { kind: 'new' | 'removed' | 'reworded' }>,
  source: Source,
  draft: DraftTargets,
): UwDiagnostic[] {
  const targetValue =
    decision.target.kind === 'existing' || decision.target.kind === 'new'
      ? draft.obligations.get(obligationTargetKey(decision.target))?.statement
      : draft.content
          .get(contentTargetKey(decision.target))
          ?.slice(decision.target.range.start, decision.target.range.end)
  return targetValue === source.statement
    ? []
    : [
        diagnostic(
          uw,
          'normalization-kept-mismatch',
          'Kept normalization must preserve the exact parser-decoded source',
        ),
      ]
}

function validateSourceDecision(
  decision: Exclude<NormalizationDecision, { kind: 'new' }>,
  uw: Scope,
  sourcesBySpan: ReadonlyMap<string, Source>,
  accounted: Set<string>,
  draft: DraftTargets,
  claimed: Set<string>,
  coverage: Map<string, { start: number; end: number }[]>,
): UwDiagnostic[] {
  const key = spanKey(decision.source)
  const source = sourcesBySpan.get(key)
  if (source === undefined) return [sourceDiagnostic(uw, 'normalization-source-unknown')]
  if (accounted.has(key)) return [sourceDiagnostic(uw, 'normalization-source-duplicate')]
  accounted.add(key)
  if (decision.kind === 'removed') return []
  const targetDiagnostics =
    'id' in source
      ? obligationTargetDiagnostics(uw, source, decision.target, draft, claimed)
      : contentTargetDiagnostics(uw, source, decision.target, draft, coverage)
  if (targetDiagnostics.length > 0 || decision.kind !== 'kept') return targetDiagnostics
  return keptDiagnostic(uw, decision, source, draft)
}

function validateDecision(
  decision: NormalizationDecision,
  uw: Scope,
  sourcesBySpan: ReadonlyMap<string, Source>,
  accounted: Set<string>,
  draft: DraftTargets,
  claimed: Set<string>,
  coverage: Map<string, { start: number; end: number }[]>,
): UwDiagnostic[] {
  if (decision.kind === 'new') {
    if (decision.target.kind !== 'new') return coverContentTarget(uw, decision.target, draft, coverage)
    const key = obligationTargetKey(decision.target)
    if (!draft.obligations.has(key))
      return [diagnostic(uw, 'normalization-target-unknown', 'Normalization target is absent from the draft')]
    if (claimed.has(key))
      return [diagnostic(uw, 'normalization-target-duplicate', 'Normalization target is claimed more than once')]
    claimed.add(key)
    return []
  }
  return validateSourceDecision(decision, uw, sourcesBySpan, accounted, draft, claimed, coverage)
}

function unaccountedSourceDiagnostics(
  uw: Scope,
  sources: readonly Source[],
  accounted: ReadonlySet<string>,
): UwDiagnostic[] {
  return sources
    .filter((source) => !accounted.has(spanKey(source.span)))
    .map(() =>
      diagnostic(
        uw,
        'normalization-source-unaccounted',
        'Every parser-extracted obligation and content span must be accounted for exactly once',
      ),
    )
}

function unaccountedTargetDiagnostics(uw: Scope, draft: DraftTargets, claimed: ReadonlySet<string>): UwDiagnostic[] {
  return [...draft.obligations.keys()]
    .filter((key) => !claimed.has(key))
    .map(() =>
      diagnostic(
        uw,
        'normalization-target-unaccounted',
        'Every draft obligation must be named by exactly one decision',
      ),
    )
}

function contentCoverageDiagnostics(
  uw: Scope,
  draft: DraftTargets,
  coverage: ReadonlyMap<string, readonly { start: number; end: number }[]>,
): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const [key, value] of draft.content) {
    if (value.length === 0) continue
    const ranges = [...(coverage.get(key) ?? [])].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    let end = 0
    for (const range of ranges) {
      if (range.start < end) diagnostics.push(diagnostic(uw, 'normalization-content-overlap', 'Content ranges overlap'))
      if (range.start > end)
        diagnostics.push(
          diagnostic(uw, 'normalization-content-unaccounted', 'Draft content has no accounting decision'),
        )
      end = Math.max(end, range.end)
    }
    if (end < value.length)
      diagnostics.push(diagnostic(uw, 'normalization-content-unaccounted', 'Draft content has no accounting decision'))
  }
  return diagnostics
}

export function validateNormalizationConservation(
  input: UwProposalInput,
  analysis: IssueSpecAnalysis,
): readonly UwDiagnostic[] {
  const sources: Source[] = [
    ...analysis.criterionSources.map((source) => ({ ...source, kind: 'criterion' as const })),
    ...analysis.invariantSources.map((source) => ({ ...source, kind: 'invariant' as const })),
    ...analysis.contentSources.map((source) => ({
      kind: 'content' as const,
      statement: source.statement,
      expectedTarget: source.target,
      span: source.span,
    })),
    ...analysis.preservedContent.map((source) => ({
      kind: 'preserved' as const,
      statement: source.text,
      span: source.span,
    })),
  ]
  const sourcesBySpan = new Map(sources.map((source) => [spanKey(source.span), source]))
  const accounted = new Set<string>()
  const claimed = new Set<string>()
  const coverage = new Map<string, { start: number; end: number }[]>()
  const draft = draftTargets(input)
  const diagnostics = input.normalization.flatMap((decision) =>
    validateDecision(decision, input.uw, sourcesBySpan, accounted, draft, claimed, coverage),
  )
  return [
    ...diagnostics,
    ...unaccountedSourceDiagnostics(input.uw, sources, accounted),
    ...unaccountedTargetDiagnostics(input.uw, draft, claimed),
    ...contentCoverageDiagnostics(input.uw, draft, coverage),
  ]
}
