import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import {
  bodyDiagnostic,
  LITERAL_ITEM,
  normalizeNewlines,
  type ParsedSection,
  type PreservedSourceContent,
  type ScannedItems,
  type SourceCriterionBlock,
  type SourceLiteralBlock,
  type SourceSpan,
} from './uw-spec-source-scanner.ts'
import {
  decodeContinuationLines,
  decodeSpecText,
  ITEM_CONTINUATION_PREFIX,
  isSpecTextFence,
} from './uw-spec-text-codec.ts'

export function scanLiteralItems(uw: Scope, section: ParsedSection | undefined): ScannedItems {
  if (!section) return { blocks: [], malformed: [], noncriterion: [] }
  const lines = normalizeNewlines(section.content).split('\n')
  const blocks: SourceCriterionBlock[] = []
  const malformed: UwDiagnostic[] = []
  const noncriterion: PreservedSourceContent[] = []
  const itemSpan = (first: number, last: number): SourceSpan => ({
    start: { line: section.contentSpan.start.line + first, column: 1 },
    end: { line: section.contentSpan.start.line + last, column: (lines[last] ?? '').length + 1 },
  })
  let active: {
    first: number
    last: number
    source: string[]
    pendingBlankLines: string[]
    statement: string
  } | null = null
  const finish = () => {
    if (!active) return
    const text = active.source.join('\n')
    const decoded =
      active.statement + (active.source.length > 1 ? `\n${decodeContinuationLines(active.source.slice(1))}` : '')
    const decodedText = decodeSpecText(decoded)
    const block: SourceCriterionBlock = {
      kind: 'criterion',
      id: null,
      statement: decodedText ?? decoded,
      source: text,
      span: itemSpan(active.first, active.last),
    }
    blocks.push(block)
    if (decodedText === null && isSpecTextFence(decoded)) {
      malformed.push(
        bodyDiagnostic(
          uw,
          'spec-text-fence-malformed',
          'Tagged visible text requires a matching closing fence',
          block.span,
          section.heading,
        ),
      )
    }
    active = null
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = LITERAL_ITEM.exec(line)
    if (match) {
      finish()
      active = {
        first: index,
        last: index,
        source: [line],
        pendingBlankLines: [],
        statement: match[1] ?? '',
      }
      continue
    }
    if (active && line.trim() === '') {
      active.pendingBlankLines.push(line)
      continue
    }
    if (active && /^\s+/.test(line)) {
      active.source.push(...active.pendingBlankLines, line)
      active.pendingBlankLines = []
      active.last = index
      continue
    }
    finish()
    if (line !== '') {
      const malformedSpan = itemSpan(index, index)
      noncriterion.push({ kind: 'text', section: section.heading, span: malformedSpan, source: line })
      malformed.push(
        bodyDiagnostic(
          uw,
          'spec-item-malformed',
          `Expected a bullet item in ${section.heading}`,
          malformedSpan,
          section.heading,
        ),
      )
    }
  }
  finish()
  return { blocks, malformed, noncriterion }
}

function questionBounds(lines: readonly string[]): { first: number; last: number } {
  let first = 0
  let last = lines.length - 1
  while (first <= last && /^\s*$/.test(lines[first] ?? '')) first += 1
  while (last >= first && /^\s*$/.test(lines[last] ?? '')) last -= 1
  if (/^<!-- complexity: [0-9]+ -->$/.test(lines[last] ?? '')) last -= 1
  while (last >= first && /^\s*$/.test(lines[last] ?? '')) last -= 1
  return { first, last }
}

function questionBlock(
  section: ParsedSection,
  lines: readonly string[],
  index: number,
): { block: SourceLiteralBlock; last: number } {
  const source = lines[index] ?? ''
  const item = LITERAL_ITEM.exec(source)
  if (item === null) {
    return {
      block: {
        statement: source,
        source,
        span: {
          start: { line: section.contentSpan.start.line + index, column: 1 },
          end: { line: section.contentSpan.start.line + index, column: source.length + 1 },
        },
      },
      last: index,
    }
  }
  const start = index
  const itemLines = [item[1] ?? '']
  while ((lines[index + 1] ?? '').startsWith(ITEM_CONTINUATION_PREFIX)) {
    index += 1
    itemLines.push((lines[index] ?? '').slice(ITEM_CONTINUATION_PREFIX.length))
  }
  const encoded = itemLines.join('\n')
  return {
    block: {
      statement: decodeSpecText(encoded) ?? encoded,
      source: lines.slice(start, index + 1).join('\n'),
      span: {
        start: { line: section.contentSpan.start.line + start, column: 1 },
        end: { line: section.contentSpan.start.line + index, column: (lines[index] ?? '').length + 1 },
      },
    },
    last: index,
  }
}

/** Open questions accept old direct lines and canonical bullet-framed visible literals. */
export function scanOpenQuestionItems(section: ParsedSection | undefined): SourceLiteralBlock[] {
  if (!section) return []
  const lines = normalizeNewlines(section.content).split('\n')
  const { first, last } = questionBounds(lines)
  const blocks: SourceLiteralBlock[] = []
  for (let index = first; index <= last; index += 1) {
    if (lines[index] === '') continue
    const question = questionBlock(section, lines, index)
    blocks.push(question.block)
    index = question.last
  }
  return blocks
}
