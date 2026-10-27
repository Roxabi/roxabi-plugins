import { describe, expect, it } from 'vitest'
import { uwCreateInputSchema, uwProposalInputSchema } from '../../contracts.ts'

const repository = 'acme/widgets'
const draft = {
  criteria: [{ kind: 'new', draftKey: 'criterion-1', statement: 'Preserves the requested operation.' }],
  invariants: [],
  exclusions: [],
  openQuestions: [],
  sections: { origin: '', context: '', change: '' },
}
const factors = { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 }
const labels = { add: [], remove: [] }
const emptyRelations = { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] }
const normalization = [{ kind: 'new', target: { kind: 'new', draftKey: 'criterion-1' }, reason: 'New criterion.' }]

function existing(parent: { repository: string; number: number } | null | undefined) {
  return {
    uw: { repository, target: `${repository}#42` },
    sourceBodySha256: 'a'.repeat(64),
    title: 'Set parent',
    draft,
    factors,
    writes: {
      labels,
      relations: parent === undefined ? emptyRelations : { parent, ...emptyRelations },
    },
    normalization,
    tierOverride: null,
  }
}

function create(parent: { repository: string; number: number }) {
  return {
    repository,
    title: 'Create with parent',
    draft,
    factors,
    writes: { labels, relations: { parent, ...emptyRelations } },
    normalization,
    tierOverride: null,
  }
}

describe('public UW proposal JSON schemas', () => {
  it('preserves explicit same-repository parent set/remove intents while create omits the source hash', () => {
    const set = existing({ repository, number: 41 })
    const remove = existing(null)
    const omitted = existing(undefined)
    const creation = create({ repository, number: 40 })

    expect(uwProposalInputSchema.parse(set)).toEqual(set)
    expect(uwProposalInputSchema.parse(remove)).toEqual(remove)
    expect(uwProposalInputSchema.parse(omitted)).toEqual(omitted)
    expect(uwCreateInputSchema.parse(creation)).toEqual(creation)
    expect(uwCreateInputSchema.safeParse({ ...creation, sourceBodySha256: 'a'.repeat(64) }).success).toBe(false)
  })
})
