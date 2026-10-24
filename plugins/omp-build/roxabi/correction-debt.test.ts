import { describe, expect, it } from 'vitest'
import { groupCorrectionDebt } from './correction-debt'
import type { CorrectionOutcome } from './correction-policy-contract'
import type { CauseAdmission, CorrectionCause, FixFinding } from './fix-domain'

const requiredCause: CorrectionCause = {
  id: 'RC-1',
  title: 'boundary rejects malformed input',
  mechanism: 'untrusted input reaches the consumer',
  fix: 'validate input at the boundary',
  failure: 'malformed input reaches the consumer',
  restored: 'malformed input is rejected',
  paths: ['src/consumer.ts:10'],
  proof: 'consumer rejects malformed input',
  findingIds: ['finding-blocking'],
  authorization: 'required',
  admission: { safePlan: true },
}

describe('correction debt grouping', () => {
  const findings: FixFinding[] = [
    { id: 'finding-blocking', label: 'issue', usable: true },
    { id: 'finding-optional', label: 'suggestion', usable: true },
    { id: 'finding-uncited', label: 'todo', usable: true },
  ]
  const retainedBlocking: CauseAdmission = {
    status: 'retained',
    cause: requiredCause,
    diagnostics: ['member-unusable:finding-blocking'],
  }
  const retainedOptional: CauseAdmission = {
    status: 'retained',
    cause: { ...requiredCause, id: 'RC-2', findingIds: ['finding-optional'] },
    diagnostics: ['baseline-blocking-member-required'],
  }
  const evidence = {
    important: true as const,
    urgent: true as const,
    tooLarge: true as const,
    evidence: { source: 'test' },
  }

  it('keeps baseline blocking obligations separate while issuing exactly one non-blocking bundle', () => {
    const groups = groupCorrectionDebt({
      policy: { version: 'baseline' },
      findings,
      causes: [requiredCause, retainedOptional.cause],
      admissions: [retainedBlocking, retainedOptional],
      outcomes: [],
      retainedObligations: [],
      evidenceFor: () => evidence,
    })
    expect(groups.map((group) => [group.kind, group.causeIds, group.findingIds])).toEqual([
      ['blocking-cause', ['RC-1'], ['finding-blocking']],
      ['blocking-finding', [], ['finding-uncited']],
      ['nonblocking-bundle', ['RC-2'], ['finding-optional']],
    ])
    expect(groups.every((group) => group.issueAdmitted)).toBe(true)
  })

  it('withholds evidence-v1 debt when every obligation does not independently meet the conjunction', () => {
    const groups = groupCorrectionDebt({
      policy: { version: 'evidence-v1', acceptanceRef: 'accepted-policy' },
      findings,
      causes: [requiredCause, retainedOptional.cause],
      admissions: [retainedBlocking, retainedOptional],
      outcomes: [] as CorrectionOutcome[],
      retainedObligations: [],
      evidenceFor: ({ findingIds }) => ({
        important: findingIds[0] === 'finding-blocking',
        urgent: true,
        tooLarge: true,
        evidence: { source: 'test', findingIds: [...findingIds] },
      }),
    })
    expect(groups.find((group) => group.findingIds.includes('finding-blocking'))?.issueAdmitted).toBe(true)
    expect(
      groups
        .filter(
          (group) => group.findingIds.includes('finding-optional') || group.findingIds.includes('finding-uncited'),
        )
        .every((group) => !group.issueAdmitted),
    ).toBe(true)
    expect(groups.some((group) => group.kind === 'nonblocking-bundle')).toBe(false)
  })
})
