import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import { retainedSections, type SourceContentBlock, sectionContentBlocks } from './uw-spec-source-projection.ts'
import {
  isLegacyHeading,
  type ParsedSection,
  type PreservedSourceContent,
  type SourceCriterionBlock,
  type SourceLiteralBlock,
  scanLiteralItems,
  scanOpenQuestionItems,
  scanSourceItems,
} from './uw-spec-source-scanner.ts'

type ItemScan = {
  blocks: SourceCriterionBlock[]
  malformed: UwDiagnostic[]
  noncriterion: PreservedSourceContent[]
}
type LiteralScan = ItemScan

export type BodySourceFacts = {
  legacySections: readonly ParsedSection[]
  criteria: ItemScan
  invariants: ItemScan
  exclusions: LiteralScan
  questionBlocks: SourceLiteralBlock[]
  contentBlocks: readonly SourceContentBlock[]
  preserved: PreservedSourceContent[]
  malformed: UwDiagnostic[]
}

export function scanBodySources(
  uw: Scope,
  sections: readonly ParsedSection[],
  byHeading: ReadonlyMap<string, readonly ParsedSection[]>,
): BodySourceFacts {
  const legacySections = sections.filter((section) => isLegacyHeading(section.heading))
  const legacyCriteria = legacySections.filter((section) => section.heading !== 'Acceptance Criteria')
  const criteria = scanMany(uw, [...(byHeading.get('Acceptance Criteria') ?? []), ...legacyCriteria], 'C')
  const invariants = scanMany(uw, byHeading.get('Invariants') ?? [], 'I')
  const exclusionScans = (byHeading.get('Exclusions') ?? []).map((section) => scanLiteralItems(uw, section))
  const questionScans = (byHeading.get('Open Questions') ?? []).map((section) => scanOpenQuestionItems(section))
  const exclusions = exclusionScans[0] ?? { blocks: [], malformed: [], noncriterion: [] }
  const contentBlocks: SourceContentBlock[] = [
    ...sectionContentBlocks(byHeading),
    ...exclusionScans
      .flatMap((scan) => scan.blocks)
      .map((block, index) => ({
        target: { kind: 'exclusion' as const, index },
        statement: block.statement,
        span: block.span,
        source: block.source,
      })),
    ...questionScans.flat().map((block, index) => ({
      target: { kind: 'open-question' as const, index },
      statement: block.statement,
      span: block.span,
      source: block.source,
    })),
  ]
  const preserved = [
    ...retainedSections(sections),
    ...criteria.noncriterion,
    ...invariants.noncriterion,
    ...exclusionScans.flatMap((scan) => scan.noncriterion),
  ]
  return {
    legacySections,
    criteria,
    invariants,
    exclusions,
    questionBlocks: questionScans[0] ?? [],
    contentBlocks,
    preserved,
    malformed: [...criteria.malformed, ...invariants.malformed, ...exclusionScans.flatMap((scan) => scan.malformed)],
  }
}

function scanMany(uw: Scope, sections: readonly ParsedSection[], expected: 'C' | 'I') {
  const scans = sections.map((section) => scanSourceItems(uw, section, expected))
  return {
    blocks: scans.flatMap((scan) => scan.blocks),
    malformed: scans.flatMap((scan) => scan.malformed),
    noncriterion: scans.flatMap((scan) => scan.noncriterion),
  }
}
