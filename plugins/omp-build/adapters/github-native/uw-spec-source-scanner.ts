import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'

export type SourcePosition = { line: number; column: number }
export type SourceSpan = { start: SourcePosition; end: SourcePosition }
export type ParsedSection = {
  heading: string
  content: string
  source: string
  span: SourceSpan
  contentSpan: SourceSpan
}
export type ParsedStructure = { sections: ParsedSection[]; diagnostics: UwDiagnostic[]; marked: boolean }

export type SourceCriterionBlock = {
  kind: 'criterion' | 'invariant'
  id: string | null
  statement: string
  span: SourceSpan
  source: string
}
export type SourceLiteralBlock = {
  statement: string
  span: SourceSpan
  source: string
}
export type PreservedSourceContent = {
  kind: 'section' | 'text'
  section: string | null
  span: SourceSpan
  source: string
}
export type ScannedItems = {
  blocks: SourceCriterionBlock[]
  malformed: UwDiagnostic[]
  noncriterion: PreservedSourceContent[]
}

type ScannedHeading = { heading: string; line: number }

export const SPEC_MARKER = '<!-- omp-build-spec/1 -->'
export const SPEC_HEADINGS = [
  'Origin',
  'Context',
  'Change',
  'Acceptance Criteria',
  'Invariants',
  'Exclusions',
  'Open Questions',
] as const

const LEGACY_HEADINGS = /^(?:acceptance criteria|critères d[’']acceptation|critères|criteria)$/i

export const LITERAL_ITEM = /^- (.*)$/
export { ITEM_CONTINUATION_PREFIX } from './uw-spec-text-codec.ts'

export function bodyLocation(uw: Scope, span: SourceSpan, section?: string): UwDiagnostic['location'] {
  return { kind: 'body', uw, section, start: span.start, end: span.end }
}

export function bodyDiagnostic(
  uw: Scope,
  code: string,
  message: string,
  span: SourceSpan,
  section?: string,
): UwDiagnostic {
  return { code, message, location: bodyLocation(uw, span, section), related: [] }
}

export function sourceSpan(startLine: number, endLine: number, lines: readonly string[]): SourceSpan {
  const endText = lines[endLine - 1] ?? ''
  return { start: { line: startLine, column: 1 }, end: { line: endLine, column: endText.length + 1 } }
}

export function sourceLineSpan(line: number, start = 1, end = start): SourceSpan {
  return { start: { line, column: start }, end: { line, column: end } }
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

export function isLegacyHeading(heading: string): boolean {
  return LEGACY_HEADINGS.test(heading)
}

function headingOf(line: string, marked: boolean): string | null {
  const heading = /^(#{1,6}) ([^\n]+)$/.exec(line)
  if (heading === null || line.startsWith('\\#')) return null
  const name = heading[2] ?? ''
  return heading[1]?.length === 1 || (!marked && isLegacyHeading(name)) ? name : null
}

function nextFence(current: string | null, line: string): string | null | undefined {
  const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
  if (fence === null) return undefined
  const delimiter = fence[1] ?? ''
  if (current === null) return /^\s/.test(line) ? undefined : delimiter
  return delimiter[0] === current[0] && delimiter.length >= current.length && /^\s*$/.test(fence[2] ?? '')
    ? null
    : current
}

function scannedHeadings(lines: readonly string[], marked: boolean): ScannedHeading[] {
  const headings: ScannedHeading[] = []
  let fenced: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = nextFence(fenced, line)
    if (next !== undefined) {
      fenced = next
      continue
    }
    if (fenced !== null) continue
    const heading = headingOf(line, marked)
    if (heading !== null) headings.push({ heading, line: index + 1 })
  }
  return headings
}

function sectionsOf(lines: readonly string[], headings: readonly ScannedHeading[]): ParsedSection[] {
  return headings.map((entry, index) => {
    const next = headings[index + 1]?.line ?? lines.length + 1
    return {
      heading: entry.heading,
      content: lines.slice(entry.line, next - 1).join('\n'),
      source: lines.slice(entry.line - 1, next - 1).join('\n'),
      span: sourceSpan(entry.line, Math.max(entry.line, next - 1), lines),
      contentSpan: sourceSpan(Math.min(entry.line + 1, lines.length || 1), Math.max(entry.line + 1, next - 1), lines),
    }
  })
}

function unknownSectionDiagnostics(uw: Scope, sections: readonly ParsedSection[]): UwDiagnostic[] {
  return sections.flatMap((section) =>
    SPEC_HEADINGS.some((heading) => heading === section.heading)
      ? []
      : [
          bodyDiagnostic(
            uw,
            'spec-section-unknown',
            `Unknown H1 section ${section.heading}`,
            section.span,
            section.heading,
          ),
        ],
  )
}

export function scanSpecStructure(uw: Scope, body: string): ParsedStructure {
  const lines = normalizeNewlines(body).split('\n')
  const marked = lines.some((line) => line.trim() === SPEC_MARKER)
  const sections = sectionsOf(lines, scannedHeadings(lines, marked))
  return { sections, diagnostics: unknownSectionDiagnostics(uw, sections), marked }
}

export function sectionsByHeading(parsed: ParsedStructure): Map<string, ParsedSection[]> {
  const byHeading = new Map<string, ParsedSection[]>()
  for (const section of parsed.sections)
    byHeading.set(section.heading, [...(byHeading.get(section.heading) ?? []), section])
  return byHeading
}

export function structuralDiagnostics(
  uw: Scope,
  parsed: ParsedStructure,
  byHeading: ReadonlyMap<string, readonly ParsedSection[]>,
): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const heading of SPEC_HEADINGS) {
    const matches = byHeading.get(heading) ?? []
    if (matches.length !== 1) {
      diagnostics.push(
        bodyDiagnostic(
          uw,
          matches.length ? 'spec-section-duplicate' : 'spec-section-missing',
          `${heading} section must appear exactly once`,
          matches[0]?.span ?? sourceLineSpan(1),
          heading,
        ),
      )
    }
  }
  if (SPEC_HEADINGS.some((heading, index) => parsed.sections[index]?.heading !== heading)) {
    diagnostics.push(
      bodyDiagnostic(
        uw,
        'spec-section-order',
        'Spec H1 sections are not in the required order',
        parsed.sections[0]?.span ?? sourceLineSpan(1),
      ),
    )
  }
  return diagnostics
}

export { scanSourceItems } from './uw-spec-item-scanner.ts'
export { scanLiteralItems, scanOpenQuestionItems } from './uw-spec-literal-items.ts'
