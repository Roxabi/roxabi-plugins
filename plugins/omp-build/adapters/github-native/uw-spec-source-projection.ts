import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import type { SpecRawSource } from '../../engine/uw-spec.ts'
import {
  bodyDiagnostic,
  isLegacyHeading,
  normalizeNewlines,
  type ParsedSection,
  type PreservedSourceContent,
  SPEC_HEADINGS,
  SPEC_MARKER,
  sourceSpan,
} from './uw-spec-source-scanner.ts'
import { decodeSpecText, isSpecTextFence } from './uw-spec-text-codec.ts'

export type SourceContentBlock = {
  target:
    | { kind: 'section'; section: 'origin' | 'context' | 'change' }
    | { kind: 'exclusion'; index: number }
    | { kind: 'open-question'; index: number }
  statement: string
  span: { start: { line: number; column: number }; end: { line: number; column: number } }
  source: string
}

export function structuralContent(value: string): string {
  const lines = normalizeNewlines(value).split('\n')
  while (lines[0] !== undefined && /^\s*$/.test(lines[0])) lines.shift()
  while (lines.at(-1) !== undefined && /^\s*$/.test(lines.at(-1) ?? '')) lines.pop()
  return lines.join('\n')
}

export function decodedContent(value: string): string {
  const structural = structuralContent(value)
  return decodeSpecText(structural) ?? structural
}

export function retainedSections(sections: readonly ParsedSection[]): PreservedSourceContent[] {
  return sections
    .filter(
      (section) =>
        !SPEC_HEADINGS.includes(section.heading as (typeof SPEC_HEADINGS)[number]) && !isLegacyHeading(section.heading),
    )
    .map((section) => ({
      kind: 'section' as const,
      section: section.heading,
      span: section.span,
      source: section.source,
    }))
}

export function sectionContentBlocks(byHeading: ReadonlyMap<string, readonly ParsedSection[]>): SourceContentBlock[] {
  const names = [
    ['Origin', 'origin'],
    ['Context', 'context'],
    ['Change', 'change'],
  ] as const
  return names.flatMap(([heading, section]) =>
    (byHeading.get(heading) ?? []).flatMap((entry) => {
      const statement = decodedContent(entry.content)
      return statement === ''
        ? []
        : [
            {
              target: { kind: 'section' as const, section },
              statement,
              span: entry.contentSpan,
              source: entry.content,
            },
          ]
    }),
  )
}

export function preservePreamble(
  uw: Scope,
  raw: SpecRawSource,
  sections: readonly ParsedSection[],
  preserved: PreservedSourceContent[],
): UwDiagnostic[] {
  const firstHeading = sections[0]?.span.start.line
  if (firstHeading === undefined) return []
  const lines = normalizeNewlines(raw.body).split('\n')
  const diagnostics: UwDiagnostic[] = []
  for (let line = 1; line < firstHeading; line += 1) {
    const source = lines[line - 1] ?? ''
    if (source !== '' && source.trim() !== SPEC_MARKER) {
      const span = sourceSpan(line, line, lines)
      preserved.push({ kind: 'text', section: null, span, source })
      diagnostics.push(
        bodyDiagnostic(
          uw,
          'spec-content-unclassifiable',
          'Body content outside Spec sections is preserved for normalization',
          span,
        ),
      )
    }
  }
  return diagnostics
}

export function preserveUnclassifiableBody(
  uw: Scope,
  raw: SpecRawSource,
  sections: readonly ParsedSection[],
  preserved: PreservedSourceContent[],
): UwDiagnostic[] {
  if (sections.length !== 0 || raw.body === '') return []
  const lines = normalizeNewlines(raw.body).split('\n')
  const span = sourceSpan(1, lines.length, lines)
  preserved.push({ kind: 'text', section: null, span, source: raw.body })
  return [bodyDiagnostic(uw, 'spec-content-unclassifiable', 'Body has no classifiable Spec sections', span)]
}

export function malformedTextFenceDiagnostics(
  uw: Scope,
  byHeading: ReadonlyMap<string, readonly ParsedSection[]>,
): UwDiagnostic[] {
  return ['Origin', 'Context', 'Change'].flatMap((heading) =>
    (byHeading.get(heading) ?? []).flatMap((section) => {
      const encoded = structuralContent(section.content)
      return isSpecTextFence(encoded) && decodeSpecText(encoded) === null
        ? [
            bodyDiagnostic(
              uw,
              'spec-text-fence-malformed',
              'Tagged visible text requires a matching closing fence',
              section.contentSpan,
              heading,
            ),
          ]
        : []
    }),
  )
}
