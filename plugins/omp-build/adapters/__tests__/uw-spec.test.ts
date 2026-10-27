import { describe, expect, it } from 'vitest'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { githubScope } from '../github/transport.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../github-native/uw-spec.ts'

const uw = githubScope('acme/app', 17)

function strictBody(): string {
  return `<!-- omp-build-spec/1 -->

# Origin

Une origine avec  deux espaces.

# Context

\`\`\`md
# Cette ligne reste dans une fence
\`\`\`

# Change

Conserver la langue de l’auteur.

# Acceptance Criteria

- C1 : Première obligation
  avec une continuation 😀 indentée.

# Invariants

- I1 : Une invariance.

# Exclusions

- Rien de plus.

# Open Questions

<!-- complexity: 5 -->
`
}

describe('UW Spec body grammar', () => {
  it('classifies a strict body as conformant with UTF-16 criterion source boundaries', () => {
    const raw = rawSource('#17', strictBody(), '2026-10-27T12:00:00Z')
    const parsed = parseIssueSpecBody({ uw, raw })

    expect(parsed.status).toBe('conformant')
    if (parsed.status !== 'conformant') throw new Error('expected conformant Spec')
    expect(parsed.snapshot.raw.bodySha256).toBe(raw.bodySha256)
    expect(parsed.snapshot.spec.criteria).toEqual([
      { id: 'C1', statement: 'Première obligation\navec une continuation 😀 indentée.' },
    ])
    const sourceLines = strictBody().split('\n')
    const criterionLine = sourceLines.findIndex((line) => line.startsWith('- C1 :'))
    const continuation = sourceLines[criterionLine + 1]
    expect(parsed.analysis.criterionSources[0]?.span).toEqual({
      start: { line: criterionLine + 1, column: 1 },
      end: { line: criterionLine + 2, column: (continuation?.length ?? 0) + 1 },
    })
    expect(
      parsed.analysis.contentSources.some(
        (entry) =>
          entry.target.kind === 'section' &&
          entry.target.section === 'context' &&
          entry.statement.includes('# Cette ligne reste dans une fence'),
      ),
    ).toBe(true)
  })

  it('retains blank paragraphs within an indented continuation but excludes trailing section whitespace', () => {
    const body = strictBody().replace(
      '  avec une continuation 😀 indentée.',
      '  avec une continuation 😀 indentée.\n\n  Puis une seconde continuation.',
    )
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })

    expect(parsed.status).toBe('conformant')
    if (parsed.status !== 'conformant') throw new Error('expected conformant Spec')
    expect(parsed.snapshot.spec.criteria).toEqual([
      {
        id: 'C1',
        statement: 'Première obligation\navec une continuation 😀 indentée.\n\nPuis une seconde continuation.',
      },
    ])
    const sourceLines = body.split('\n')
    const finalContinuation = sourceLines.findIndex((line) => line.startsWith('  Puis une seconde continuation.'))
    expect(parsed.analysis.criterionSources[0]?.span.end).toEqual({
      line: finalContinuation + 1,
      column: (sourceLines[finalContinuation]?.length ?? 0) + 1,
    })
  })

  it('keeps a presentation-only structural blank out of the canonical version while preserving raw SHA', () => {
    const first = parseIssueSpecBody({ uw, raw: rawSource('#17', strictBody(), null) })
    const second = parseIssueSpecBody({
      uw,
      raw: rawSource('#17', strictBody().replace('# Context\n\n', '# Context\n\n\n'), null),
    })

    expect(first.status).toBe('conformant')
    expect(second.status).toBe('conformant')
    if (first.status !== 'conformant' || second.status !== 'conformant') throw new Error('expected conformant Specs')
    expect(first.snapshot.spec.version).toBe(second.snapshot.spec.version)
    expect(first.snapshot.raw.bodySha256).not.toBe(second.snapshot.raw.bodySha256)
  })

  it('renders only the fixed English H1 grammar and parses its own output', () => {
    const content = canonicalSpec({
      format: 'omp-build-spec-content/1',
      sections: { origin: '\n  # Origine littérale\n', context: 'Contexte', change: 'Changement' },
      criteria: [{ id: 'C1', statement: 'Garder\n  le français.' }],
      invariants: [{ id: 'I1', statement: 'Ne pas perdre les espaces.' }],
      exclusions: ['\n  Pas de migration.\n'],
      openQuestions: ['# Question littérale\n<!-- complexity: 5 -->'],
    })
    if (!content.ok) throw new Error('expected canonical Spec')
    const body = renderIssueSpecBody(content.value, { complexity: 5 })

    expect(body).toContain('~~~omp-build-text')
    expect(parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })).toMatchObject({
      status: 'conformant',
      snapshot: { spec: content.value },
    })
  })

  it('exposes French legacy criterion blocks and every unclassified prose span without admitting a Spec', () => {
    const parsed = parseIssueSpecBody({
      uw,
      raw: rawSource('#17', '## Critères d’acceptation\n\n- Préserver la prose\n\nTexte ambigu.', null),
    })

    expect(parsed.status).toBe('legacy')
    expect(parsed.analysis.criterionSources).toMatchObject([
      { statement: 'Préserver la prose', source: '- Préserver la prose' },
    ])
    expect(parsed.analysis.preservedContent).toMatchObject([
      { text: 'Texte ambigu.', sectionHint: 'Critères d’acceptation' },
    ])
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain('spec-item-malformed')
  })

  it('keeps every duplicate legacy criterion heading in the sole normalization source projection', () => {
    const parsed = parseIssueSpecBody({
      uw,
      raw: rawSource(
        '#17',
        '# Critères d’acceptation\n\n- C1 : Français\n\n# Acceptance Criteria\n\n- C2 : English',
        null,
      ),
    })

    expect(parsed.status).toBe('legacy')
    expect(parsed.analysis.criterionSources.map((source) => source.statement).sort()).toEqual(['English', 'Français'])
  })

  it('does not close a four-backtick fence at an inner triple-backtick line', () => {
    const body = strictBody().replace(
      '```md\n# Cette ligne reste dans une fence\n```',
      '````md\n```\n# Cette ligne reste dans une fence\n```\n````',
    )
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })

    expect(parsed.status).toBe('conformant')
  })
})
