import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import type { SpecDraft, SpecRawSource, SpecSnapshot } from '../../engine/uw-spec.ts'
import {
  type PreservedSourceContent,
  parseSpecBody,
  type SourceContentBlock,
  type SourceCriterionBlock,
  type SourceSpan,
} from './uw-spec-parser.ts'

export type { SourceSpan }
export type CriterionSource = Pick<SourceCriterionBlock, 'id' | 'statement' | 'span' | 'source'>
export type ContentSource = Pick<SourceContentBlock, 'target' | 'statement' | 'span' | 'source'>
export type PreservedContent = { span: SourceSpan; text: string; sectionHint?: string }
/**
 * Source locations are 1-based UTF-16 line/column coordinates with an exclusive end.
 * This is the sole extraction result used by normalization: consumers must not reparse bodies.
 */
export type IssueSpecAnalysis = {
  criterionSources: readonly CriterionSource[]
  invariantSources: readonly CriterionSource[]
  contentSources: readonly ContentSource[]
  preservedContent: readonly PreservedContent[]
}
export type ParsedIssueSpec =
  | { status: 'conformant'; snapshot: SpecSnapshot; diagnostics: readonly []; analysis: IssueSpecAnalysis }
  | {
      status: 'draft'
      draft: SpecDraft
      raw: SpecRawSource
      diagnostics: readonly UwDiagnostic[]
      analysis: IssueSpecAnalysis
    }
  | {
      status: 'legacy' | 'malformed'
      raw: SpecRawSource
      diagnostics: readonly UwDiagnostic[]
      analysis: IssueSpecAnalysis
    }

function analysis(
  criteria: readonly SourceCriterionBlock[],
  invariants: readonly SourceCriterionBlock[],
  content: readonly SourceContentBlock[],
  preserved: readonly PreservedSourceContent[],
): IssueSpecAnalysis {
  return {
    criterionSources: criteria.map(({ id, statement, span, source }) => ({ id, statement, span, source })),
    invariantSources: invariants.map(({ id, statement, span, source }) => ({ id, statement, span, source })),
    contentSources: content.map(({ target, statement, span, source }) => ({ target, statement, span, source })),
    preservedContent: preserved.map(({ span, source, section }) =>
      section === null ? { span, text: source } : { span, text: source, sectionHint: section },
    ),
  }
}

export function parseIssueSpecBody(input: { uw: Scope; raw: SpecRawSource }): ParsedIssueSpec {
  const parsed = parseSpecBody(input.uw, input.raw)
  const source = analysis(parsed.criterionBlocks, parsed.invariantBlocks, parsed.contentBlocks, parsed.preserved)
  if (parsed.status === 'conformant' && parsed.content !== undefined) {
    return {
      status: 'conformant',
      snapshot: { spec: parsed.content, raw: input.raw },
      diagnostics: [],
      analysis: source,
    }
  }
  if (parsed.status === 'draft' && parsed.draft !== undefined) {
    return { status: 'draft', draft: parsed.draft, raw: input.raw, diagnostics: parsed.diagnostics, analysis: source }
  }
  if (parsed.status === 'legacy') {
    return { status: 'legacy', raw: input.raw, diagnostics: parsed.diagnostics, analysis: source }
  }
  return { status: 'malformed', raw: input.raw, diagnostics: parsed.diagnostics, analysis: source }
}

export { rawSource, SPEC_HEADINGS, SPEC_MARKER } from './uw-spec-parser.ts'
export { renderIssueSpecBody } from './uw-spec-renderer.ts'
