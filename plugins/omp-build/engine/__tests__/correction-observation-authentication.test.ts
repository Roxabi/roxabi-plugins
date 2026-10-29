import { describe, expect, test } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { shippedMandate } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import type { PinnedFileRef } from '../action-input-schema.ts'
import { correctionObservationAuthenticationDiagnostics } from '../correction-observation-authentication.ts'
import { assessCriterionReview } from '../criterion-admission.ts'
import { criterionEvidenceSchema } from '../criterion-evidence-schema.ts'
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

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

function fixture(method: 'test' | 'content-reading') {
  const original = method === 'test' ? passingTest('C1') : contentReading()
  const evidence = criterionEvidenceSchema.parse(
    method === 'test'
      ? original
      : {
          ...original,
          provenance: {
            kind: 'native',
            actionId: 'implement-region',
            childId: 'child-region',
            submissionIndex: 0,
            toolCallIds: [],
          },
        },
  )
  const allRefs =
    evidence.method === 'test'
      ? [...evidence.after.versionClaim.references, ...(evidence.before?.versionClaim.references ?? [])]
      : evidence.references
  const refs = allRefs.filter((ref): ref is PinnedFileRef => ref.source === 'git-file')
  const expandedContext = allRefs.filter((ref) => ref.source !== 'git-file')
  const base = acceptedActionInputs(shippedMandate(), 'correction')
  const manifest = { ...base.manifest, repositoryReferences: refs, expandedContext }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  let producer: unknown
  let commandRuns: unknown[] = []
  let bashCalls: unknown[] = []
  if (evidence.method === 'test') {
    producer = {
      id: evidence.id,
      target: evidence.target,
      method: 'test',
      scenario: evidence.scenario,
      after: { toolCallId: evidence.after.run.toolCallId, versionClaim: evidence.after.versionClaim },
      before: null,
    }
    commandRuns = [evidence.after.run]
    bashCalls = [
      {
        toolCallId: evidence.after.run.toolCallId,
        input: { command: evidence.after.run.command },
        effectiveCwd: '.',
        exitCode: evidence.after.run.exitCode,
        result: { output: 'captured' },
      },
    ]
  } else {
    const { provenance: _, ...value } = evidence
    producer = value
  }
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
    raw: { terminal: { id: 'child-region', structuredOutput: { status: 'valid', data } }, proofEvidence: null },
    observation: { actionId: 'implement-region', childId: 'child-region', submissionIndex: 0, submission },
    commandProvenance: evidence.provenance,
    commandRuns,
    bashCalls,
  }
  const contribution = {
    kind: 'contribution',
    payload: {
      host: { origin: 'native', childId: 'child-region', action: { actionId: 'implement-region', inputs } },
      native,
      rawAttempts: [submission],
      structured: data,
    },
  } as unknown as Contribution
  return { evidence, refs, contribution, native, inputs, data, submission }
}

describe('correction evidence authentication', () => {
  test('authenticates genuine submitted observation and captured test run', () => {
    for (const method of ['content-reading', 'test'] as const) {
      const { evidence, refs, contribution } = fixture(method)
      expect(correctionObservationAuthenticationDiagnostics(evidence, [], refs, contribution)).toEqual([])
    }
  })

  test('rejects wrong child, altered submission, missing producer reference and spoofed run', () => {
    const observation = fixture('content-reading')
    const check = (contribution: Contribution) =>
      correctionObservationAuthenticationDiagnostics(observation.evidence, [], observation.refs, contribution)
    expect(
      check({
        ...observation.contribution,
        payload: {
          ...observation.contribution.payload,
          host: { ...observation.contribution.payload.host, childId: 'other-child' },
        },
      }),
    ).not.toEqual([])
    expect(
      check({
        ...observation.contribution,
        payload: { ...observation.contribution.payload, structured: { criteria: [] } },
      }),
    ).not.toEqual([])
    const manifest = { ...observation.inputs.manifest, repositoryReferences: [] }
    const inputs = { ...observation.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    expect(
      check({
        ...observation.contribution,
        payload: {
          ...observation.contribution.payload,
          host: { ...observation.contribution.payload.host, action: { actionId: 'implement-region', inputs } },
        },
      }),
    ).not.toEqual([])
    const run = fixture('test')
    const forged = {
      ...run.contribution,
      payload: { ...run.contribution.payload, native: { ...run.native, bashCalls: [] } },
    } as unknown as Contribution
    expect(correctionObservationAuthenticationDiagnostics(run.evidence, [], run.refs, forged)).not.toEqual([])
  })

  test('authenticated observation does not replace an independent verdict', () => {
    const { evidence, refs, contribution } = fixture('content-reading')
    expect(correctionObservationAuthenticationDiagnostics(evidence, [], refs, contribution)).toEqual([])
    const supported = satisfied(evidence, { criterionKind: 'content' })
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
            examined: [{ ...supported.examined[0], truth: 'unsupported' }],
          }),
        ],
      }).requiresChanges,
    ).toBe(true)
  })
})
