import type { IssueSpecAnalysis } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { NormalizationDecision } from '../engine/uw-normalization-schema.ts'
import type { SpecDraft } from '../engine/uw-spec-schema.ts'
export type ConservationSubject =
  | { kind: 'uw'; uw: Scope }
  | { kind: 'framing-member'; repository: string; member: FramingMemberKey }
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
export type Source = ObligationSource | ContentSource
export type DraftTargets = {
  obligations: Map<string, { statement: string; family: 'criterion' | 'invariant' }>
  content: Map<string, string>
}
export type DiagnosticSubject = Scope | ConservationSubject

export function diagnostic(subject: DiagnosticSubject, code: string, message: string): UwDiagnostic {
  const location =
    'kind' in subject
      ? subject.kind === 'uw'
        ? { kind: 'native' as const, uw: subject.uw, connection: 'state' as const }
        : { kind: 'repository' as const, repository: subject.repository }
      : { kind: 'native' as const, uw: subject, connection: 'state' as const }
  return { code, message, location, related: [] }
}

export function spanKey(span: {
  start: { line: number; column: number }
  end: { line: number; column: number }
}): string {
  return `${span.start.line}:${span.start.column}-${span.end.line}:${span.end.column}`
}

function contentTargetKey(target: ContentTarget | ContentDestination): string {
  if (target.kind === 'section') return `section:${target.section}`
  return `${target.kind}:${target.index}`
}

export function obligationTargetKey(target: ObligationTarget): string {
  return target.kind === 'existing' ? `existing:${target.id}` : `new:${target.draftKey}`
}

export function draftTargets(input: { draft: SpecDraft }): DraftTargets {
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

export function sourceDiagnostic(uw: DiagnosticSubject, code: keyof typeof SOURCE_DIAGNOSTIC_MESSAGES): UwDiagnostic {
  return diagnostic(uw, code, SOURCE_DIAGNOSTIC_MESSAGES[code])
}

function contentTargetDiagnostics(
  uw: DiagnosticSubject,
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
  uw: DiagnosticSubject,
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
  uw: DiagnosticSubject,
  source: ObligationSource,
  target: NormalizationTarget,
  draft: DraftTargets,
  claimed: Set<string>,
  policy: { identity: 'native-ledger' | 'none'; merged: boolean },
): UwDiagnostic[] {
  if (target.kind !== 'existing' && target.kind !== 'new')
    return [
      diagnostic(uw, 'normalization-obligation-target-invalid', 'A criterion or invariant cannot be assigned to prose'),
    ]
  const key = obligationTargetKey(target)
  const draftTarget = draft.obligations.get(key)
  if (draftTarget === undefined)
    return [diagnostic(uw, 'normalization-target-unknown', 'Normalization target is absent from the draft')]
  if (claimed.has(key) && !policy.merged)
    return [diagnostic(uw, 'normalization-target-duplicate', 'Normalization target is claimed more than once')]
  claimed.add(key)
  if (draftTarget.family !== source.kind)
    return [
      diagnostic(uw, 'normalization-identity-family-invalid', 'Criteria and invariants retain their identifier family'),
    ]
  if (policy.identity === 'none') {
    return target.kind === 'existing' && !policy.merged
      ? [
          diagnostic(
            uw,
            'normalization-material-identity',
            'Material cannot allocate or claim a native identity without a declared merge',
          ),
        ]
      : []
  }
  if (source.id === null && target.kind !== 'new')
    return [diagnostic(uw, 'normalization-identity-new-invalid', 'Unnamed parser obligations require one draft key')]
  if (source.id !== null && (target.kind !== 'existing' || target.id !== source.id))
    return [
      diagnostic(uw, 'normalization-identity-continuity', 'Identified parser obligations retain the same identifier'),
    ]
  return []
}

function keptDiagnostic(
  uw: DiagnosticSubject,
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
  uw: DiagnosticSubject,
  sourcesBySpan: ReadonlyMap<string, Source>,
  accounted: Set<string>,
  draft: DraftTargets,
  claimed: Set<string>,
  coverage: Map<string, { start: number; end: number }[]>,
  policy: { identity: 'native-ledger' | 'none'; merged: boolean } = { identity: 'native-ledger', merged: false },
): UwDiagnostic[] {
  const key = spanKey(decision.source)
  const source = sourcesBySpan.get(key)
  if (source === undefined) return [sourceDiagnostic(uw, 'normalization-source-unknown')]
  if (accounted.has(key)) return [sourceDiagnostic(uw, 'normalization-source-duplicate')]
  accounted.add(key)
  if (decision.kind === 'removed') return []
  const targetDiagnostics =
    'id' in source
      ? obligationTargetDiagnostics(uw, source, decision.target, draft, claimed, policy)
      : contentTargetDiagnostics(uw, source, decision.target, draft, coverage)
  if (targetDiagnostics.length > 0 || decision.kind !== 'kept') return targetDiagnostics
  return keptDiagnostic(uw, decision, source, draft)
}

export function validateDecision(
  decision: NormalizationDecision,
  uw: DiagnosticSubject,
  sourcesBySpan: ReadonlyMap<string, Source>,
  accounted: Set<string>,
  draft: DraftTargets,
  claimed: Set<string>,
  coverage: Map<string, { start: number; end: number }[]>,
  policy: { identity: 'native-ledger' | 'none'; merged: boolean } = { identity: 'native-ledger', merged: false },
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
  return validateSourceDecision(decision, uw, sourcesBySpan, accounted, draft, claimed, coverage, policy)
}
export function analysisSources(analysis: IssueSpecAnalysis): Source[] {
  return [
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
}
