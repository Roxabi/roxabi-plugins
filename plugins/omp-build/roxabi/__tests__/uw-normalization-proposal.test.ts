import { describe, expect, it } from 'vitest'
import { githubScope } from '../../adapters/github/transport.ts'
import { type ParsedIssueSpec, parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { NormalizationJudgement } from '../../engine/uw-normalization-schema.ts'
import { validateNormalizationJudgement } from '../uw-normalization-proposal.ts'

const uw = githubScope('acme/app', 17)

function fixture(): { parsed: ParsedIssueSpec; judgement: NormalizationJudgement } {
  const parsed = parseIssueSpecBody({
    uw,
    raw: rawSource(
      '#17',
      '# Origin\n\nOrigine française\n\n# Context\n\nEnglish context\n\n# Change\n\nChanger sans perte\n\n# Critères d’acceptation\n\n- C1 : Préserver le critère\n\n# Exclusions\n\n- Pas de migration\n\n# Open Questions\n\nQuestion ouverte',
      null,
    ),
  })
  const content = parsed.analysis.contentSources.map((source) => {
    if (source.target.kind === 'section') {
      const value = { origin: 'Origine française', context: 'English context', change: 'Changer sans perte' }[
        source.target.section
      ]
      return {
        kind: 'kept' as const,
        source: source.span,
        target: { ...source.target, range: { start: 0, end: value.length } },
      }
    }
    const value = source.target.kind === 'exclusion' ? 'Pas de migration' : 'Question ouverte'
    return {
      kind: 'kept' as const,
      source: source.span,
      target: { ...source.target, range: { start: 0, end: value.length } },
    }
  })
  return {
    parsed,
    judgement: {
      draft: {
        criteria: [{ kind: 'existing', id: 'C1', statement: 'Préserver le critère' }],
        invariants: [],
        sections: { origin: 'Origine française', context: 'English context', change: 'Changer sans perte' },
        exclusions: ['Pas de migration'],
        openQuestions: ['Question ouverte'],
      },
      normalization: [
        ...parsed.analysis.criterionSources.map((source) => ({
          kind: 'kept' as const,
          source: source.span,
          target: { kind: 'existing' as const, id: 'C1' as const },
        })),
        ...content,
      ],
      factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
      tierOverride: null,
    },
  }
}

function diagnostics(judgement: NormalizationJudgement, parsed: ParsedIssueSpec): readonly string[] {
  return validateNormalizationJudgement(
    { uw, title: 'Normalize', parsed, graph: {} as never, writes: {} as never },
    judgement,
  ).map((entry) => entry.code)
}

describe('UW normalization conservation', () => {
  it('accounts for a French/English legacy body and all typed content destinations', () => {
    const { parsed, judgement } = fixture()

    expect(diagnostics(judgement, parsed)).toEqual([])
  })

  it.each([
    ['# Acceptance Criteria', '* Preserve existing authorized requests.', 'kept'],
    ['# Critères d’acceptation', '  - Preserve existing authorized requests.', 'reworded'],
  ])('conserves a legacy criterion from %s with bullet %s as %s', (heading, bullet, decision) => {
    const raw = rawSource('#17', `${heading}\n\n${bullet}`, null)
    const parsed = parseIssueSpecBody({ uw, raw })
    const source = parsed.analysis.criterionSources[0]
    expect(parsed.status).toBe('legacy')
    expect(source).toMatchObject({ id: null, statement: 'Preserve existing authorized requests.', source: bullet })
    if (source === undefined) throw new Error('legacy bullet must be a criterion source')

    const target: { kind: 'new'; draftKey: string } = { kind: 'new', draftKey: 'legacy-criterion' }
    const judgement: NormalizationJudgement = {
      draft: {
        criteria: [
          {
            ...target,
            statement: decision === 'kept' ? source.statement : 'Continue to preserve authorized requests.',
          },
        ],
        invariants: [],
        sections: { origin: '', context: '', change: '' },
        exclusions: [],
        openQuestions: [],
      },
      normalization: [
        decision === 'kept'
          ? { kind: 'kept', source: source.span, target }
          : { kind: 'reworded', source: source.span, target, reason: 'Clarify the original criterion' },
      ],
      factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
      tierOverride: null,
    }
    const observedAt = '2026-10-27T12:00:00.000Z'
    const result = validateNormalizationJudgement(
      {
        uw,
        title: 'Normalize',
        parsed,
        graph: {
          status: 'complete',
          root: uw,
          observedAt,
          nodes: [
            {
              uw,
              title: 'Normalize',
              raw,
              updatedAt: observedAt,
              labels: ['size:S'],
              wayfinderLabels: [],
              parent: null,
              children: [],
              blockers: [],
              native: { state: 'OPEN', stateReason: null },
            },
          ],
        },
        writes: {
          labels: { add: [], remove: [] },
          relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
        },
      },
      judgement,
    )

    expect(parsed.analysis.preservedContent).toEqual([])
    expect(result).toEqual([])
  })

  it('refuses omitted prose and an identified criterion moved to another ID', () => {
    const { parsed, judgement } = fixture()
    const criterion = parsed.analysis.criterionSources[0]
    if (criterion === undefined) throw new Error('Fixture must expose one criterion source')
    const missingContent = { ...judgement, normalization: judgement.normalization.slice(0, 1) }
    const transposed: NormalizationJudgement = {
      ...judgement,
      draft: {
        ...judgement.draft,
        criteria: [{ kind: 'existing', id: 'C2' as const, statement: 'Préserver le critère' }],
      },
      normalization: [
        {
          kind: 'kept',
          source: criterion.span,
          target: { kind: 'existing', id: 'C2' as const },
        },
        ...judgement.normalization.slice(1),
      ],
    }

    expect(diagnostics(missingContent, parsed)).toContain('normalization-source-unaccounted')
    expect(diagnostics(transposed, parsed)).toContain('normalization-identity-continuity')
  })
})
