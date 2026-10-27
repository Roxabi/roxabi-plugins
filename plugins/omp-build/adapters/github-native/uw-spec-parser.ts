import { createHash } from 'node:crypto'
import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import {
  type CriterionId,
  canonicalSpec,
  type InvariantId,
  normalized,
  type Spec,
  type SpecContent,
  type SpecDraft,
  type SpecRawSource,
} from '../../engine/uw-spec.ts'
import { scanBodySources } from './uw-spec-body-scan.ts'
import {
  decodedContent,
  malformedTextFenceDiagnostics,
  preservePreamble,
  preserveUnclassifiableBody,
  type SourceContentBlock,
} from './uw-spec-source-projection.ts'
import {
  bodyLocation,
  bodyDiagnostic as diagnostic,
  type PreservedSourceContent,
  type SourceCriterionBlock,
  scanSpecStructure,
  sectionsByHeading,
  sourceLineSpan,
  structuralDiagnostics,
} from './uw-spec-source-scanner.ts'

export type { SourceContentBlock } from './uw-spec-source-projection.ts'
export type {
  PreservedSourceContent,
  SourceCriterionBlock,
  SourcePosition,
  SourceSpan,
} from './uw-spec-source-scanner.ts'
export { SPEC_HEADINGS, SPEC_MARKER } from './uw-spec-source-scanner.ts'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function duplicateDiagnostics(uw: Scope, blocks: readonly SourceCriterionBlock[]): UwDiagnostic[] {
  const firstById = new Map<string, SourceCriterionBlock>()
  const diagnostics: UwDiagnostic[] = []
  for (const block of blocks) {
    if (block.id === null) continue
    const first = firstById.get(block.id)
    if (first === undefined) firstById.set(block.id, block)
    else
      diagnostics.push({
        ...diagnostic(uw, 'spec-id-duplicate', `Duplicate Spec item ${block.id}`, block.span),
        related: [bodyLocation(uw, first.span)],
      })
  }
  return diagnostics
}

export type ParsedBody = {
  status: 'conformant' | 'draft' | 'legacy' | 'malformed'
  content?: Spec
  draft?: SpecDraft
  diagnostics: readonly UwDiagnostic[]
  criterionBlocks: readonly SourceCriterionBlock[]
  invariantBlocks: readonly SourceCriterionBlock[]
  contentBlocks: readonly SourceContentBlock[]
  preserved: readonly PreservedSourceContent[]
}

function malformedResult(
  diagnostics: readonly UwDiagnostic[],
  criteria: readonly SourceCriterionBlock[],
  invariants: readonly SourceCriterionBlock[],
  contentBlocks: readonly SourceContentBlock[],
  preserved: readonly PreservedSourceContent[],
  status: 'legacy' | 'malformed' = 'malformed',
): ParsedBody {
  return { status, diagnostics, criterionBlocks: criteria, invariantBlocks: invariants, contentBlocks, preserved }
}

function isCriterionId(id: string | null): id is CriterionId {
  return id !== null && /^C[1-9][0-9]*$/.test(id)
}

function isInvariantId(id: string | null): id is InvariantId {
  return id !== null && /^I[1-9][0-9]*$/.test(id)
}

function draftCriteria(blocks: readonly SourceCriterionBlock[]): SpecDraft['criteria'] {
  return blocks.map((block, index): SpecDraft['criteria'][number] => {
    if (block.id === null) return { kind: 'new', draftKey: `${block.kind}-${index + 1}`, statement: block.statement }
    if (!isCriterionId(block.id)) throw new Error(`Expected criterion ID, received ${block.id}`)
    return { kind: 'existing', id: block.id, statement: block.statement }
  })
}

function draftInvariants(blocks: readonly SourceCriterionBlock[]): SpecDraft['invariants'] {
  return blocks.map((block, index): SpecDraft['invariants'][number] => {
    if (block.id === null) return { kind: 'new', draftKey: `${block.kind}-${index + 1}`, statement: block.statement }
    if (!isInvariantId(block.id)) throw new Error(`Expected invariant ID, received ${block.id}`)
    return { kind: 'existing', id: block.id, statement: block.statement }
  })
}

function identifiedItems<K extends CriterionId | InvariantId>(
  blocks: readonly SourceCriterionBlock[],
  matches: (id: string | null) => id is K,
): { id: K; statement: string }[] {
  return blocks.map((block) => {
    if (!matches(block.id)) throw new Error(`Expected named Spec item, received ${block.id ?? 'unnamed'}`)
    return { id: block.id, statement: block.statement }
  })
}

function invalidItemDiagnostics(
  uw: Scope,
  criteria: readonly SourceCriterionBlock[],
  invariants: readonly SourceCriterionBlock[],
): UwDiagnostic[] {
  return [
    ...criteria
      .filter((block) => normalized(block.statement) === '')
      .map((block) =>
        diagnostic(
          uw,
          'spec-item-malformed',
          `${block.id} must have a non-empty statement`,
          block.span,
          'Acceptance Criteria',
        ),
      ),
    ...invariants
      .filter((block) => normalized(block.statement) === '')
      .map((block) =>
        diagnostic(uw, 'spec-item-malformed', `${block.id} must have a non-empty statement`, block.span, 'Invariants'),
      ),
  ]
}

export function parseSpecBody(uw: Scope, raw: SpecRawSource): ParsedBody {
  const parsed = scanSpecStructure(uw, raw.body)
  const byHeading = sectionsByHeading(parsed)
  const diagnostics = [...parsed.diagnostics, ...structuralDiagnostics(uw, parsed, byHeading)]
  const sourceFacts = scanBodySources(uw, parsed.sections, byHeading, parsed.marked)
  const { criteria, invariants, exclusions, questionBlocks, contentBlocks, legacySections, preserved } = sourceFacts
  diagnostics.push(...sourceFacts.malformed)
  diagnostics.push(...preservePreamble(uw, raw, parsed.sections, preserved))
  diagnostics.push(...preserveUnclassifiableBody(uw, raw, parsed.sections, preserved))
  const allBlocks = [...criteria.blocks, ...invariants.blocks]
  diagnostics.push(...duplicateDiagnostics(uw, allBlocks))
  const sections = {
    origin: decodedContent(byHeading.get('Origin')?.[0]?.content ?? ''),
    context: decodedContent(byHeading.get('Context')?.[0]?.content ?? ''),
    change: decodedContent(byHeading.get('Change')?.[0]?.content ?? ''),
  }
  diagnostics.push(...malformedTextFenceDiagnostics(uw, byHeading))
  const questions = questionBlocks
  if (!parsed.marked) {
    const legacy = legacySections.length > 0
    diagnostics.push(
      diagnostic(
        uw,
        'spec-legacy-format',
        legacy ? 'Legacy specification headings require normalization' : 'Spec marker is missing',
        sourceLineSpan(1),
      ),
    )
    return malformedResult(
      diagnostics,
      criteria.blocks,
      invariants.blocks,
      contentBlocks,
      preserved,
      legacy ? 'legacy' : 'malformed',
    )
  }
  if (diagnostics.length > 0)
    return malformedResult(diagnostics, criteria.blocks, invariants.blocks, contentBlocks, preserved)
  const draft: SpecDraft = {
    criteria: draftCriteria(criteria.blocks),
    invariants: draftInvariants(invariants.blocks),
    exclusions: exclusions.blocks.map((block) => block.statement),
    openQuestions: questions.map((block) => block.statement),
    sections,
  }
  if (allBlocks.some((block) => block.id === null))
    return {
      status: 'draft',
      draft,
      diagnostics: [],
      criterionBlocks: criteria.blocks,
      invariantBlocks: invariants.blocks,
      contentBlocks,
      preserved,
    }
  const content = {
    format: 'omp-build-spec-content/1',
    criteria: identifiedItems(criteria.blocks, isCriterionId),
    invariants: identifiedItems(invariants.blocks, isInvariantId),
    exclusions: exclusions.blocks.map((block) => block.statement),
    openQuestions: draft.openQuestions,
    sections,
  } satisfies SpecContent
  const canonical = canonicalSpec(content)
  if (!canonical.ok) {
    const itemDiagnostics = invalidItemDiagnostics(uw, criteria.blocks, invariants.blocks)
    return malformedResult(
      itemDiagnostics.length > 0
        ? itemDiagnostics
        : canonical.diagnostics.map((entry) => diagnostic(uw, entry.code, entry.message, sourceLineSpan(1))),
      criteria.blocks,
      invariants.blocks,
      contentBlocks,
      preserved,
    )
  }
  return {
    status: 'conformant',
    content: canonical.value,
    diagnostics: [],
    criterionBlocks: criteria.blocks,
    invariantBlocks: invariants.blocks,
    contentBlocks,
    preserved,
  }
}

export function rawSource(reference: string, body: string, lastEditedAt: string | null): SpecRawSource {
  return { reference, body, bodySha256: sha256(body), lastEditedAt }
}
