import { expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { specDigest } from '../record-digests.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, featureMandate, history, SCOPE } from './workflow-test-support.ts'

test('does not let editorial classification bypass structural, tier, child, or exclusion changes', () => {
  const { childSnapshot } = roxabiWorkflowFixtures()
  const mandated = featureMandate()
  const initial = mandateAssessmentState(mandated)
  const child = childSnapshot({ repository: SCOPE.repository, target: 'acme/app#43' }, 'child commitment')
  const proposed = [
    proposedAssessmentState(initial, {
      body: 'add C2',
      content: {
        criteria: [
          { id: 'C1', statement: BODY },
          { id: 'C2', statement: 'new commitment' },
        ],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
    }),
    proposedAssessmentState(initial, {
      body: 'remove C1',
      content: {
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
    }),
    proposedAssessmentState(initial, {
      body: BODY,
      content: {
        criteria: [{ id: 'C1', statement: BODY }],
        invariants: [],
        exclusions: ['excluded work'],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
    }),
    proposedAssessmentState(initial, { body: BODY, tier: 'F-lite' }),
    proposedAssessmentState(initial, { body: BODY, children: [child] }),
  ]
  for (const [index, state] of proposed.entries()) {
    const assessment = assessFixture(mandated, `mechanical-${index}`, initial, state, 'editorial', [
      history([mandated]),
      history([], child.scope),
    ])
    expect(resolveAcceptedSpec(mandated, [history([mandated, assessment.start, assessment.result])])).toMatchObject({
      ok: true,
      spec: { ref: { version: initial.ref.version } },
    })
  }
  const childAdded = assessFixture(
    mandated,
    'add-child',
    initial,
    proposedAssessmentState(initial, { body: BODY, children: [child] }),
    'material',
    [history([mandated]), history([], child.scope)],
  )
  const childAccepted = acceptMaterialFixture(mandated, 'accept-child', childAdded)
  const afterChild = acceptedMaterialState(childAdded, childAccepted)
  const presentationBody = `${child.snapshot.raw.body}\n`
  const presentationOnlyChild = {
    ...child,
    snapshot: {
      ...child.snapshot,
      raw: {
        ...child.snapshot.raw,
        body: presentationBody,
        bodySha256: specDigest(presentationBody),
        lastEditedAt: '2026-10-22T00:00:00Z',
      },
    },
  }
  const presentationOnly = assessFixture(
    mandated,
    'child-presentation-only',
    afterChild,
    proposedAssessmentState(afterChild, { body: BODY, children: [presentationOnlyChild] }),
    'editorial',
    [history([mandated, childAdded.start, childAdded.result, childAccepted]), history([], child.scope)],
  )
  expect(
    resolveAcceptedSpec(mandated, [
      history([
        mandated,
        childAdded.start,
        childAdded.result,
        childAccepted,
        presentationOnly.start,
        presentationOnly.result,
      ]),
    ]),
  ).toMatchObject({
    ok: true,
    spec: { children: [{ snapshot: { raw: { body: presentationBody } } }] },
  })
})
