import { describe, expect, it } from 'vitest'
import { parseIssueSpecBody, parseSpecMaterial, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { type FramingConservationInput, validateFramingConservation } from '../uw-framing-conservation.ts'

const uw = { repository: 'acme/app', target: 'acme/app#17' }
const nativeOrigin = { kind: 'native' as const, member: 'root' }
const materialOrigin = { kind: 'material' as const, id: 'm1' }
function fixture(): FramingConservationInput {
  const body = '# Acceptance Criteria\n\n- C1: Preserve behavior'
  const native = parseIssueSpecBody({ uw, raw: rawSource('#17', body, null) }).analysis
  const material = parseSpecMaterial({
    repository: uw.repository,
    material: 'm1',
    raw: rawSource('entry', body, null),
  }).analysis
  const nativeCriterion = native.criterionSources[0]
  const materialCriterion = material.criterionSources[0]
  if (!nativeCriterion || !materialCriterion || nativeCriterion.id !== 'C1')
    throw new Error('parser fixture must contain identified criterion')
  const target = { kind: 'existing', id: 'C1' } as const
  return {
    sources: [
      { origin: nativeOrigin, identity: 'native-ledger', analysis: native },
      { origin: materialOrigin, identity: 'none', analysis: material },
    ],
    members: [
      {
        member: 'root',
        subject: { kind: 'uw', uw },
        draft: {
          criteria: [{ ...target, statement: 'Preserve behavior' }],
          invariants: [],
          sections: { origin: '', context: '', change: '' },
          exclusions: [],
          openQuestions: [],
        },
        decisions: [
          { origin: nativeOrigin, decision: { kind: 'kept', source: nativeCriterion.span, target } },
          { origin: materialOrigin, decision: { kind: 'kept', source: materialCriterion.span, target } },
        ],
        merges: [
          {
            target,
            reason: 'Both sources describe the same obligation',
            sources: [
              { origin: nativeOrigin, span: nativeCriterion.span },
              { origin: materialOrigin, span: materialCriterion.span },
            ],
          },
        ],
      },
    ],
  }
}

describe('aggregate source conservation', () => {
  it('accounts colliding coordinates separately through an explicit identity-preserving merge', () => {
    expect(validateFramingConservation(fixture())).toEqual([])
  })
  it('rejects an undeclared duplicate and material identity adoption', () => {
    const input = fixture()
    const member = input.members[0]
    if (!member) throw new Error('fixture member missing')
    const result = validateFramingConservation({ ...input, members: [{ ...member, merges: [] }] })
    expect(result.map((entry) => entry.code)).toContain('normalization-target-duplicate')
    const materialOnly = validateFramingConservation({
      ...input,
      members: [{ ...member, decisions: member.decisions.slice(1), merges: [] }],
    })
    expect(materialOnly.map((entry) => entry.code)).toContain('normalization-material-identity')
  })
  it('does not turn an identified native obligation into a newly allocated identity', () => {
    const input = fixture()
    const member = input.members[0]
    const decision = member?.decisions[0]
    if (!member || !decision || decision.decision.kind !== 'kept') throw new Error('fixture native decision missing')
    const target = { kind: 'new' as const, draftKey: 'replacement' }
    const result = validateFramingConservation({
      sources: input.sources.slice(0, 1),
      members: [
        {
          ...member,
          draft: { ...member.draft, criteria: [{ ...target, statement: 'Preserve behavior' }] },
          decisions: [{ ...decision, decision: { ...decision.decision, target } }],
          merges: [],
        },
      ],
    })
    expect(result.map((entry) => entry.code)).toContain('normalization-identity-continuity')
  })
  it('rejects multiple parser analyses for the same source origin', () => {
    const input = fixture()
    const native = input.sources[0]
    if (!native) throw new Error('fixture native source missing')
    const result = validateFramingConservation({ ...input, sources: [...input.sources, native] })
    expect(result.map((entry) => entry.code)).toContain('normalization-source-origin-duplicate')
  })
  it('rejects a merge that omits one source or repeats a source', () => {
    const input = fixture()
    const member = input.members[0]
    const merge = member?.merges[0]
    if (!member || !merge?.sources[0]) throw new Error('fixture merge missing')
    const invalid = { ...merge, sources: [merge.sources[0], merge.sources[0]] }
    const diagnostics = validateFramingConservation({ ...input, members: [{ ...member, merges: [invalid] }] })
    expect(diagnostics.map((entry) => entry.code)).toContain('normalization-merge-invalid')
  })
  it('rejects an unaccounted material source and a foreign native source', () => {
    const input = fixture()
    const member = input.members[0]
    if (!member) throw new Error('fixture member missing')
    const missing = validateFramingConservation({
      ...input,
      members: [{ ...member, decisions: member.decisions.slice(0, 1), merges: [] }],
    })
    expect(missing.map((entry) => entry.code)).toContain('normalization-source-unaccounted')
    const foreign = validateFramingConservation({ ...input, members: [{ ...member, member: 'other', merges: [] }] })
    expect(foreign.map((entry) => entry.code)).toContain('normalization-source-foreign-member')
  })
  it('accounts kept, reworded, removed and genuinely new obligations without replacing native identities', () => {
    const analysis = parseIssueSpecBody({
      uw,
      raw: rawSource(
        '#17',
        '# Acceptance Criteria\n- C1: Keep export\n- C2: Retry export\n- C3: Remove obsolete format',
        null,
      ),
    }).analysis
    const [kept, reworded, removed] = analysis.criterionSources
    if (!kept || !reworded || !removed) throw new Error('expected three native obligations')
    const member: FramingConservationInput['members'][number] = {
      member: 'root',
      subject: { kind: 'uw', uw },
      draft: {
        criteria: [
          { kind: 'existing', id: 'C1', statement: 'Keep export' },
          { kind: 'existing', id: 'C2', statement: 'Retry failed exports once' },
          { kind: 'new', draftKey: 'audit', statement: 'Record export outcome' },
        ],
        invariants: [],
        sections: { origin: '', context: '', change: '' },
        exclusions: [],
        openQuestions: [],
      },
      decisions: [
        { origin: nativeOrigin, decision: { kind: 'kept', source: kept.span, target: { kind: 'existing', id: 'C1' } } },
        {
          origin: nativeOrigin,
          decision: {
            kind: 'reworded',
            source: reworded.span,
            target: { kind: 'existing', id: 'C2' },
            reason: 'Bound the retry behavior',
          },
        },
        {
          origin: nativeOrigin,
          decision: { kind: 'removed', source: removed.span, reason: 'The obsolete format is out of scope' },
        },
        {
          origin: null,
          decision: {
            kind: 'new',
            target: { kind: 'new', draftKey: 'audit' },
            reason: 'Audit the new delivery behavior',
          },
        },
      ],
      merges: [],
    }
    const sources: FramingConservationInput['sources'] = [{ origin: nativeOrigin, identity: 'native-ledger', analysis }]
    expect(validateFramingConservation({ sources, members: [member] })).toEqual([])
    const omittedRemoval = {
      ...member,
      decisions: member.decisions.filter(({ decision }) => decision.kind !== 'removed'),
    }
    expect(validateFramingConservation({ sources, members: [omittedRemoval] }).map(({ code }) => code)).toEqual([
      'normalization-source-unaccounted',
    ])
  })

  it('refuses an explicit merge that would erase another native identity', () => {
    const analysis = parseIssueSpecBody({
      uw,
      raw: rawSource('#17', '# Acceptance Criteria\n- C1: First behavior\n- C2: Second behavior', null),
    }).analysis
    const [first, second] = analysis.criterionSources
    if (!first || !second) throw new Error('expected two native obligations')
    const target = { kind: 'existing', id: 'C1' } as const
    const decisions = [first, second].map((source) => ({
      origin: nativeOrigin,
      decision: { kind: 'reworded' as const, source: source.span, target, reason: 'Combine behaviors' },
    }))
    const result = validateFramingConservation({
      sources: [{ origin: nativeOrigin, identity: 'native-ledger', analysis }],
      members: [
        {
          member: 'root',
          subject: { kind: 'uw', uw },
          draft: {
            criteria: [{ ...target, statement: 'Combined behavior' }],
            invariants: [],
            sections: { origin: '', context: '', change: '' },
            exclusions: [],
            openQuestions: [],
          },
          decisions,
          merges: [
            {
              target,
              reason: 'Combine behaviors',
              sources: [first, second].map(({ span }) => ({ origin: nativeOrigin, span })),
            },
          ],
        },
      ],
    })
    expect(result.map(({ code }) => code)).toEqual(['normalization-identity-continuity'])
  })
})
