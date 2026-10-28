import { describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { uwProposalInputSchema } from '../../engine/uw-command-schema.ts'
import { allocationRef, fixture, input, UW } from '../../testing/uw-operations-fixture.ts'
import type { UwProposalInput } from '../uw-contract.ts'

function setup(context = '') {
  const { operations, state } = fixture()
  state.body = renderIssueSpecBody({
    format: 'omp-build-spec-content/1',
    version: 'a'.repeat(64),
    criteria: [{ id: 'C1', statement: 'Preserve the audit trail' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context, change: '' },
  })
  const allocated = allocationRef('identity-c1')
  state.ledger = { ...state.ledger, head: allocated, nextCriterion: '2', allocations: new Map([['C1', allocated]]) }
  const parsed = parseIssueSpecBody({ uw: UW, raw: rawSource(UW.target, state.body, null) })
  const criterion = parsed.analysis.criterionSources[0]
  if (!criterion) throw new Error('Missing parser criterion source')
  const content = parsed.analysis.contentSources[0]
  const request = {
    ...input('unused', 'unused', state.body),
    draft: {
      criteria: [{ kind: 'existing' as const, id: 'C1' as const, statement: 'Preserve the audit trail' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context, change: '' },
    },
    normalization: [
      { kind: 'kept' as const, source: criterion.span, target: { kind: 'existing' as const, id: 'C1' as const } },
      ...(content
        ? [
            {
              kind: 'kept' as const,
              source: content.span,
              target: {
                kind: 'section' as const,
                section: 'context' as const,
                range: { start: 0, end: context.length },
              },
            },
          ]
        : []),
    ],
  }
  return { operations, state, request, criterion, content }
}

type ProseKind = 'exclusion' | 'context' | 'open-question'

function newProse(kind: ProseKind, request: UwProposalInput) {
  const text =
    kind === 'exclusion' ? 'Export CSV is excluded' : kind === 'context' ? 'New context' : 'Who owns the export?'
  const target =
    kind === 'context'
      ? { kind: 'section', section: 'context', range: { start: 0, end: text.length } }
      : { kind, index: 0, range: { start: 0, end: text.length } }
  const draft = {
    ...request.draft,
    exclusions: kind === 'exclusion' ? [text] : [],
    openQuestions: kind === 'open-question' ? [text] : [],
    sections: { ...request.draft.sections, context: kind === 'context' ? text : '' },
  }
  return { text, target, draft }
}

function expectWrittenProse(body: string, kind: ProseKind, text: string) {
  const written = parseIssueSpecBody({ uw: UW, raw: rawSource(UW.target, body, null) })
  expect(written.status).toBe('conformant')
  if (written.status !== 'conformant') throw new Error('Written source did not parse as conformant')
  if (kind === 'exclusion') expect(written.snapshot.spec.exclusions).toContain(text)
  if (kind === 'open-question') expect(written.snapshot.spec.openQuestions).toContain(text)
  if (kind === 'context') expect(written.snapshot.spec.sections.context).toBe(text)
}

describe('existing UW new prose conservation', () => {
  it('prepares the unchanged allocated C1 source', async () => {
    const { operations, request } = setup()
    expect(await operations.prepare(request)).toMatchObject({ ok: true })
  })

  it('refuses new prose without an explicit decision', async () => {
    const { operations, request } = setup()
    const result = await operations.prepare({
      ...request,
      draft: { ...request.draft, exclusions: ['Export CSV is excluded'] },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected refusal')
    expect(result.diagnostics.map((d) => d.code)).toContain('normalization-content-unaccounted')
  })

  it.each(['exclusion', 'context', 'open-question'] as const)(
    'prepares explicitly accounted first %s',
    async (kind) => {
      const { operations, request, state } = setup()
      const { text, target, draft } = newProse(kind, request)
      const parsed = uwProposalInputSchema.safeParse({
        ...request,
        draft,
        normalization: [...request.normalization, { kind: 'new', target, reason: 'Intentional new content' }],
      })
      expect(parsed.success).toBe(true)
      if (!parsed.success) throw new Error('Explicit new prose decision rejected by public command grammar')
      expect(await operations.prepare(parsed.data)).toMatchObject({ ok: true })
      expect(await operations.write(parsed.data)).toMatchObject({ status: 'written' })
      expectWrittenProse(state.body, kind, text)
    },
  )

  it('does not let a new decision mask an unaccounted old source', async () => {
    const { operations, request } = setup('Existing context')
    const parsed = uwProposalInputSchema.safeParse({
      ...request,
      normalization: [
        request.normalization[0],
        {
          kind: 'new',
          target: { kind: 'section', section: 'context', range: { start: 0, end: 16 } },
          reason: 'New prose',
        },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('New prose decision rejected by grammar')
    const result = await operations.prepare(parsed.data)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected refusal')
    expect(result.diagnostics.map((d) => d.code)).toContain('normalization-source-unaccounted')
  })

  it.each([
    [
      'overlapping new ranges',
      'normalization-content-overlap',
      [
        { kind: 'new', target: { kind: 'section', section: 'context', range: { start: 0, end: 4 } }, reason: 'New' },
        { kind: 'new', target: { kind: 'section', section: 'context', range: { start: 3, end: 5 } }, reason: 'New' },
      ],
    ],
    [
      'out of bounds',
      'normalization-content-range-invalid',
      [{ kind: 'new', target: { kind: 'section', section: 'context', range: { start: 0, end: 6 } }, reason: 'New' }],
    ],
    [
      'absent destination',
      'normalization-target-unknown',
      [{ kind: 'new', target: { kind: 'exclusion', index: 0, range: { start: 0, end: 1 } }, reason: 'New' }],
    ],
  ])('refuses %s', async (_name, code, decisions) => {
    const { operations, request } = setup()
    const parsed = uwProposalInputSchema.safeParse({
      ...request,
      draft: { ...request.draft, sections: { ...request.draft.sections, context: 'hello' } },
      normalization: [...request.normalization, ...decisions],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('New prose decision rejected by grammar')
    const result = await operations.prepare(parsed.data)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected refusal')
    expect(result.diagnostics.map((d) => d.code)).toContain(code)
  })

  it('refuses overlap between kept and new content', async () => {
    const { operations, request } = setup('Existing context')
    const parsed = uwProposalInputSchema.safeParse({
      ...request,
      normalization: [
        ...request.normalization,
        { kind: 'new', target: { kind: 'section', section: 'context', range: { start: 0, end: 1 } }, reason: 'New' },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('New prose decision rejected by grammar')
    const result = await operations.prepare(parsed.data)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected refusal')
    expect(result.diagnostics.map((d) => d.code)).toContain('normalization-content-overlap')
  })

  it('rejects a new decision claiming an existing criterion', () => {
    const { request } = setup()
    expect(
      uwProposalInputSchema.safeParse({
        ...request,
        normalization: [{ kind: 'new', target: { kind: 'existing', id: 'C1' }, reason: 'New' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a new content decision without a reason or with a source', () => {
    const { request, criterion } = setup()
    const target = { kind: 'section', section: 'context', range: { start: 0, end: 1 } }
    for (const decision of [
      { kind: 'new', target },
      { kind: 'new', target, reason: '', source: criterion.span },
      { kind: 'new', target, reason: 'New', source: criterion.span },
    ]) {
      expect(uwProposalInputSchema.safeParse({ ...request, normalization: [decision] }).success).toBe(false)
    }
  })

  it('refuses missing and duplicate old prose accounting', async () => {
    const { operations, request } = setup('Existing context')
    const contentDecision = request.normalization[1]
    if (!contentDecision) throw new Error('Missing content decision')
    const missing = await operations.prepare({ ...request, normalization: request.normalization.slice(0, 1) })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('Expected refusal')
    expect(missing.diagnostics.map((d) => d.code)).toContain('normalization-source-unaccounted')
    const duplicate = await operations.prepare({
      ...request,
      normalization: [...request.normalization, contentDecision],
    })
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) throw new Error('Expected refusal')
    expect(duplicate.diagnostics.map((d) => d.code)).toContain('normalization-source-duplicate')
  })

  it('refuses forged source, moved prose and criterion ownership by prose', async () => {
    const { operations, request, criterion, content } = setup('Existing context')
    if (!content) throw new Error('Missing parser content source')
    const criterionDecision = request.normalization[0]
    const contentDecision = request.normalization[1]
    if (!criterionDecision || !contentDecision) throw new Error('Missing normalization decisions')
    const forged = await operations.prepare({
      ...request,
      normalization: [
        ...request.normalization,
        {
          kind: 'removed',
          source: { start: { line: 999, column: 1 }, end: { line: 999, column: 2 } },
          reason: 'forged',
        },
      ],
    })
    expect(forged.ok).toBe(false)
    if (forged.ok) throw new Error('Expected refusal')
    expect(forged.diagnostics.map((d) => d.code)).toContain('normalization-source-unknown')
    const moved = await operations.prepare({
      ...request,
      normalization: [
        criterionDecision,
        {
          kind: 'kept',
          source: content.span,
          target: { kind: 'section', section: 'origin', range: { start: 0, end: 1 } },
        },
      ],
    })
    expect(moved.ok).toBe(false)
    if (moved.ok) throw new Error('Expected refusal')
    expect(moved.diagnostics.map((d) => d.code)).toContain('normalization-content-moved')
    const owned = await operations.prepare({
      ...request,
      normalization: [
        {
          kind: 'kept',
          source: criterion.span,
          target: { kind: 'section', section: 'context', range: { start: 0, end: 1 } },
        },
        contentDecision,
      ],
    })
    expect(owned.ok).toBe(false)
    if (owned.ok) throw new Error('Expected refusal')
    expect(owned.diagnostics.map((d) => d.code)).toContain('normalization-obligation-target-invalid')
  })
})
