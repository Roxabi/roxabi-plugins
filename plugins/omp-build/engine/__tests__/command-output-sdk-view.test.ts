import { describe, expect, test } from 'vitest'
import { assessCriterionReview } from '../criterion-admission.ts'
import { commandOutputSchema, criterionEvidenceSchema } from '../criterion-evidence-schema.ts'
import {
  candidate,
  evidenceDeclaration,
  evidenceRef,
  passingTest,
  satisfied,
  solo,
} from './criterion-admission-fixture.ts'

describe('SDK command output views', () => {
  test('requires explicit source and incomplete status', () => {
    const view = { kind: 'sdk-view', text: 'visible output', source: 'native-tool-result' }
    expect(commandOutputSchema.safeParse({ ...view, completeness: 'potentially-incomplete' }).success).toBe(true)
    expect(commandOutputSchema.safeParse({ ...view, completeness: 'known-incomplete' }).success).toBe(true)
    expect(commandOutputSchema.safeParse(view).success).toBe(false)
    expect(commandOutputSchema.safeParse({ ...view, completeness: 'complete' }).success).toBe(false)
    expect(
      commandOutputSchema.safeParse({ ...view, source: 'raw', completeness: 'potentially-incomplete' }).success,
    ).toBe(false)
  })

  test('capture alone does not replace a reviewer judgment', () => {
    const original = passingTest('C1')
    if (original.method !== 'test') throw new Error('expected test evidence')
    const value = criterionEvidenceSchema.parse({
      ...original,
      after: {
        ...original.after,
        run: {
          ...original.after.run,
          output: {
            kind: 'sdk-view',
            text: 'PASS',
            source: 'native-tool-result',
            completeness: 'potentially-incomplete',
          },
        },
      },
    })
    const supported = satisfied(value)
    const input = {
      spec: solo,
      code: candidate,
      declarations: [evidenceDeclaration(value)],
      evidence: [{ ref: evidenceRef(value), value }],
    }
    expect(assessCriterionReview({ ...input, verdicts: [supported] }).requiresChanges).toBe(false)
    expect(
      assessCriterionReview({
        ...input,
        verdicts: [
          satisfied(value, {
            examined: [{ ...supported.examined[0], truth: 'unsupported' }],
          }),
        ],
      }).requiresChanges,
    ).toBe(true)
  })
})
