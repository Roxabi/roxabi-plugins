import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import {
  bodyDiagnostic,
  normalizeNewlines,
  type ParsedSection,
  type PreservedSourceContent,
  type ScannedItems,
  type SourceCriterionBlock,
  type SourceSpan,
} from './uw-spec-source-scanner.ts'
import { decodeContinuationLines, decodeSpecText, isSpecTextFence } from './uw-spec-text-codec.ts'

const ITEM = /^-\s+(?:(C[1-9][0-9]*|I[1-9][0-9]*)\s*:(?: )?)?(.*)$/

type ActiveSourceItem = {
  first: number
  last: number
  source: string[]
  pendingBlankLines: string[]
  id: string | null
  statement: string
}

function decodedStatement(item: ActiveSourceItem): string {
  if (item.source.length === 1) return item.statement
  const continuation = decodeContinuationLines(item.source.slice(1))
  return item.statement === '' ? continuation : `${item.statement}\n${continuation}`
}

function completedItem(
  uw: Scope,
  section: ParsedSection,
  expected: 'C' | 'I',
  item: ActiveSourceItem,
  span: SourceSpan,
): { block: SourceCriterionBlock; malformed: UwDiagnostic[] } {
  const decoded = decodedStatement(item)
  const decodedText = decodeSpecText(decoded)
  const block: SourceCriterionBlock = {
    kind: expected === 'C' ? 'criterion' : 'invariant',
    id: item.id,
    statement: decodedText ?? decoded,
    source: item.source.join('\n'),
    span,
  }
  const malformed: UwDiagnostic[] = []
  if (item.id !== null && !item.id.startsWith(expected))
    malformed.push(
      bodyDiagnostic(
        uw,
        'spec-item-malformed',
        `${item.id} is not valid in ${section.heading}`,
        block.span,
        section.heading,
      ),
    )
  if (decodedText === null && isSpecTextFence(decoded))
    malformed.push(
      bodyDiagnostic(
        uw,
        'spec-text-fence-malformed',
        'Tagged visible text requires a matching closing fence',
        block.span,
        section.heading,
      ),
    )
  return { block, malformed }
}

export function scanSourceItems(uw: Scope, section: ParsedSection | undefined, expected: 'C' | 'I'): ScannedItems {
  if (!section) return { blocks: [], malformed: [], noncriterion: [] }
  const lines = normalizeNewlines(section.content).split('\n')
  const blocks: SourceCriterionBlock[] = []
  const malformed: UwDiagnostic[] = []
  const noncriterion: PreservedSourceContent[] = []
  const itemSpan = (first: number, last: number): SourceSpan => ({
    start: { line: section.contentSpan.start.line + first, column: 1 },
    end: { line: section.contentSpan.start.line + last, column: (lines[last] ?? '').length + 1 },
  })
  let active: ActiveSourceItem | null = null
  const finish = () => {
    if (active === null) return
    const completed = completedItem(uw, section, expected, active, itemSpan(active.first, active.last))
    blocks.push(completed.block)
    malformed.push(...completed.malformed)
    active = null
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = ITEM.exec(line)
    if (match) {
      finish()
      active = {
        first: index,
        last: index,
        source: [line],
        pendingBlankLines: [],
        id: match[1] ?? null,
        statement: match[2] ?? '',
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
      const span = itemSpan(index, index)
      noncriterion.push({ kind: 'text', section: section.heading, span, source: line })
      malformed.push(
        bodyDiagnostic(
          uw,
          'spec-item-malformed',
          `Expected a bullet item in ${section.heading}`,
          span,
          section.heading,
        ),
      )
    }
  }
  finish()
  return { blocks, malformed, noncriterion }
}
