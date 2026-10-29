import { describe, expect, test } from 'vitest'
import { assessCriterionReview } from '../criterion-admission.ts'
import { criterionEvidenceSchema, producerCriterionDeclarationSchema } from '../criterion-evidence-schema.ts'
import { observationAuthenticationDiagnostics } from '../delivery-eligibility.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import {
  candidate,
  contentReading,
  evidenceDeclaration,
  evidenceRef,
  passingTest,
  satisfied,
  solo,
} from './criterion-admission-fixture.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>

function fixture() {
  const evidence = criterionEvidenceSchema.parse({
    ...contentReading(),
    provenance: {
      kind: 'native',
      actionId: 'implement-region',
      childId: 'child-region',
      submissionIndex: 0,
      toolCallIds: [],
    },
  })
  if (evidence.method !== 'content-reading') throw new Error('expected content observation')
  const { provenance: _, ...producer } = evidence
  const data = { criteria: [{ target: evidence.target, verification: 'evidence', evidence: [producer] }] }
  const submission = {
    attemptIndex: 0,
    data,
    raw: { toolCallId: 'yield-1', executionArguments: { data } },
    partialText: null,
  }
  const native = {
    completion: 'completed',
    strict: 'valid',
    raw: { id: 'child-region', structuredOutput: { status: 'valid', data } },
    observation: { actionId: 'implement-region', childId: 'child-region', submissionIndex: 0, submission },
  }
  const receipt = {
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      action: 'implement',
      phase: 'result',
      actionId: 'implement-region',
      admission: { admitted: true },
      native,
      inputs: {
        manifest: {
          repositoryReferences: evidence.references,
          plugin: { files: [] },
          expandedContext: [],
          acceptedSources: [],
          deliveryData: [],
        },
        stageSources: [],
      },
    },
  } as unknown as Receipt
  return { evidence, producer, data, native, receipt }
}

describe('native observation authentication', () => {
  test('admits only producer observations without host provenance', () => {
    const { evidence, producer } = fixture()
    const declaration = { target: evidence.target, verification: 'evidence', evidence: [producer] }
    expect(producerCriterionDeclarationSchema.safeParse(declaration).success).toBe(true)
    expect(producerCriterionDeclarationSchema.safeParse({ ...declaration, evidence: [evidence] }).success).toBe(false)
    expect(criterionEvidenceSchema.safeParse({ ...passingTest('C1'), provenance: evidence.provenance }).success).toBe(
      false,
    )
  })

  test('binds the exact child, submission, evidence and pinned references', () => {
    const { evidence, native, receipt } = fixture()
    const authenticate = (candidate: Receipt, pins = evidence.references) =>
      observationAuthenticationDiagnostics(evidence, [], pins, candidate)
    expect(authenticate(receipt)).toEqual([])
    const changed = (patch: Record<string, unknown>): Receipt =>
      ({
        ...receipt,
        payload: { ...receipt.payload, native: { ...native, ...patch } },
      }) as unknown as Receipt
    expect(authenticate(changed({ observation: undefined }))).not.toEqual([])
    expect(authenticate(changed({ observation: { ...native.observation, childId: 'other-child' } }))).not.toEqual([])
    expect(authenticate(changed({ observation: { ...native.observation, submissionIndex: 1 } }))).not.toEqual([])
    expect(
      authenticate(changed({ raw: { ...native.raw, structuredOutput: { status: 'valid', data: { criteria: [] } } } })),
    ).not.toEqual([])
    expect(
      authenticate(
        changed({
          observation: {
            ...native.observation,
            submission: { ...native.observation.submission, data: { criteria: [] } },
          },
        }),
      ),
    ).not.toEqual([])
    expect(
      authenticate(
        changed({
          observation: {
            ...native.observation,
            submission: {
              ...native.observation.submission,
              raw: { toolCallId: 'yield-1', executionArguments: { data: { criteria: [] } } },
            },
          },
        }),
      ),
    ).not.toEqual([])
    expect(
      authenticate(
        changed({
          observation: {
            ...native.observation,
            submission: {
              ...native.observation.submission,
              raw: { toolCallId: '', executionArguments: { data: native.observation.submission.data } },
            },
          },
        }),
      ),
    ).not.toEqual([])
    const unrelated = { criteria: [] }
    expect(
      authenticate(
        changed({
          raw: { ...native.raw, structuredOutput: { status: 'valid', data: unrelated } },
          observation: {
            ...native.observation,
            submission: {
              ...native.observation.submission,
              data: unrelated,
              raw: { toolCallId: 'yield-1', executionArguments: { data: unrelated } },
            },
          },
        }),
      ),
    ).not.toEqual([])
    expect(authenticate(receipt, [])).not.toEqual([])
    const noProducerPins = {
      ...receipt,
      payload: {
        ...receipt.payload,
        inputs: {
          manifest: {
            repositoryReferences: [],
            plugin: { files: [] },
            expandedContext: [],
            acceptedSources: [],
            deliveryData: [],
          },
          stageSources: [],
        },
      },
    } as unknown as Receipt
    expect(authenticate(noProducerPins)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown-reference',
          message: expect.stringContaining('producing action inputs'),
        }),
      ]),
    )
  })

  test('authenticated observation still requires an independent supporting verdict', () => {
    const { evidence, receipt } = fixture()
    expect(observationAuthenticationDiagnostics(evidence, [], evidence.references, receipt)).toEqual([])
    const supported = satisfied(evidence, { criterionKind: 'content' })
    const row = supported.examined[0]
    const input = {
      spec: solo,
      code: candidate,
      declarations: [evidenceDeclaration(evidence)],
      evidence: [{ ref: evidenceRef(evidence), value: evidence }],
    }
    expect(assessCriterionReview({ ...input, verdicts: [supported] }).requiresChanges).toBe(false)
    expect(
      assessCriterionReview({
        ...input,
        verdicts: [
          satisfied(evidence, {
            criterionKind: 'content',
            examined: [{ ...row, truth: 'unsupported' }],
          }),
        ],
      }).requiresChanges,
    ).toBe(true)
  })
})
