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

  it('locates empty identified criteria and invariants at their retained source items', () => {
    const body = strictBody()
      .replace(
        '- C1 : Première obligation\n  avec une continuation 😀 indentée.',
        '- C1 :\n- C2 : literal  whitespace/value',
      )
      .replace('- I1 : Une invariance.', '- I1 :\n- I2 : literal  whitespace/value')
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })
    const lines = body.split('\n')
    const criterionLine = lines.indexOf('- C1 :') + 1
    const invariantLine = lines.indexOf('- I1 :') + 1

    expect(parsed.status).toBe('malformed')
    expect(criterionLine).not.toBe(1)
    expect(invariantLine).not.toBe(1)
    expect(criterionLine).not.toBe(invariantLine)
    expect(parsed.analysis.criterionSources).toContainEqual(
      expect.objectContaining({
        id: 'C1',
        statement: '',
        source: '- C1 :',
        span: {
          start: { line: criterionLine, column: 1 },
          end: { line: criterionLine, column: '- C1 :'.length + 1 },
        },
      }),
    )
    expect(parsed.analysis.invariantSources).toContainEqual(
      expect.objectContaining({
        id: 'I1',
        statement: '',
        source: '- I1 :',
        span: {
          start: { line: invariantLine, column: 1 },
          end: { line: invariantLine, column: '- I1 :'.length + 1 },
        },
      }),
    )
    expect(parsed.analysis.criterionSources).toContainEqual(
      expect.objectContaining({ id: 'C2', statement: 'literal  whitespace/value' }),
    )
    expect(parsed.analysis.invariantSources).toContainEqual(
      expect.objectContaining({ id: 'I2', statement: 'literal  whitespace/value' }),
    )
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'spec-item-malformed',
        message: expect.stringContaining('C1'),
        location: expect.objectContaining({
          kind: 'body',
          section: 'Acceptance Criteria',
          start: { line: criterionLine, column: 1 },
          end: { line: criterionLine, column: '- C1 :'.length + 1 },
        }),
      }),
      expect.objectContaining({
        code: 'spec-item-malformed',
        message: expect.stringContaining('I1'),
        location: expect.objectContaining({
          kind: 'body',
          section: 'Invariants',
          start: { line: invariantLine, column: 1 },
          end: { line: invariantLine, column: '- I1 :'.length + 1 },
        }),
      }),
    ])
  })

  it('locates canonically empty literal criteria and invariants without losing meaningful whitespace', () => {
    const emptyCriterion = '- C1 :\n  ~~~omp-build-text\n  \n  \n  ~~~'
    const emptyInvariant = '- I1 :\n  ~~~omp-build-text\n  \n  \n  ~~~'
    const body = strictBody()
      .replace(
        '- C1 : Première obligation\n  avec une continuation 😀 indentée.',
        `${emptyCriterion}\n- C2 : literal  whitespace/value`,
      )
      .replace('- I1 : Une invariance.', `${emptyInvariant}\n- I2 : literal  whitespace/value`)
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })
    const lines = body.split('\n')
    const criterionLine = lines.indexOf('- C1 :') + 1
    const invariantLine = lines.indexOf('- I1 :') + 1

    expect(parsed.status).toBe('malformed')
    expect(parsed.analysis.criterionSources).toContainEqual(
      expect.objectContaining({ id: 'C2', statement: 'literal  whitespace/value' }),
    )
    expect(parsed.analysis.invariantSources).toContainEqual(
      expect.objectContaining({ id: 'I2', statement: 'literal  whitespace/value' }),
    )
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'spec-item-malformed',
          message: expect.stringContaining('C1'),
          location: expect.objectContaining({
            kind: 'body',
            section: 'Acceptance Criteria',
            start: { line: criterionLine, column: 1 },
            end: { line: criterionLine + 4, column: '  ~~~'.length + 1 },
          }),
        }),
        expect.objectContaining({
          code: 'spec-item-malformed',
          message: expect.stringContaining('I1'),
          location: expect.objectContaining({
            kind: 'body',
            section: 'Invariants',
            start: { line: invariantLine, column: 1 },
            end: { line: invariantLine + 4, column: '  ~~~'.length + 1 },
          }),
        }),
      ]),
    )
  })

  it.each([
    ['C1', '- C1 : Première obligation\n  avec une continuation 😀 indentée.', 'Acceptance Criteria'],
    ['I1', '- I1 : Une invariance.', 'Invariants'],
  ])('does not diagnose a valid sibling when %s has a canonically empty literal', (id, original, section) => {
    const body = strictBody().replace(original, `- ${id} :\n  ~~~omp-build-text\n  \n  \n  ~~~`)
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })
    const line = body.split('\n').indexOf(`- ${id} :`) + 1

    expect(parsed.status).toBe('malformed')
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'spec-item-malformed',
        message: expect.stringContaining(id),
        location: expect.objectContaining({ kind: 'body', section, start: { line, column: 1 } }),
      }),
    ])
  })

  it('keeps meaningful whitespace inside nonempty literal obligations', () => {
    const body = strictBody()
      .replace(
        '- C1 : Première obligation\n  avec une continuation 😀 indentée.',
        '- C1 :\n  ~~~omp-build-text\n  first  value\n  \n    second value\n  ~~~',
      )
      .replace('- I1 : Une invariance.', '- I1 :\n  ~~~omp-build-text\n  keep  spaces\n  \n    and indentation\n  ~~~')
    const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })

    expect(parsed.status).toBe('conformant')
    if (parsed.status !== 'conformant') throw new Error('expected conformant Spec')
    expect(parsed.snapshot.spec.criteria[0]?.statement).toBe('first  value\n\n  second value')
    expect(parsed.snapshot.spec.invariants[0]?.statement).toBe('keep  spaces\n\n  and indentation')
  })

  it.each(['* C1 : Première obligation', '  - C1 : Première obligation'])(
    'does not accept legacy bullet syntax in strict destination grammar: %s',
    (bullet) => {
      const body = strictBody().replace('- C1 : Première obligation\n  avec une continuation 😀 indentée.', bullet)
      const parsed = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) })

      expect(parsed.status).toBe('malformed')
    },
  )

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
