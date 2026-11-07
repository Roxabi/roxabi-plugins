import type { IssueSpecAnalysis } from '../adapters/github-native/uw-spec.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwProposalInput } from './uw-contract.ts'
import {
  analysisSources,
  type DiagnosticSubject,
  type DraftTargets,
  diagnostic,
  draftTargets,
  type Source,
  spanKey,
  validateDecision,
} from './uw-normalization-decision.ts'

function unaccountedSourceDiagnostics(
  uw: DiagnosticSubject,
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

export function unaccountedTargetDiagnostics(
  uw: DiagnosticSubject,
  draft: DraftTargets,
  claimed: ReadonlySet<string>,
): UwDiagnostic[] {
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

export function contentCoverageDiagnostics(
  uw: DiagnosticSubject,
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
  const sources = analysisSources(analysis)
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
