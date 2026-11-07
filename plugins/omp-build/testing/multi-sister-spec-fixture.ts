import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

export function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

export function sisterSpecWorld(composedParent: boolean) {
  const fixtures = roxabiWorkflowFixtures()
  const uw = { repository: 'acme/app', target: 'acme/app#42' }
  const pr = { repository: 'acme/app', target: 'acme/app#44' }
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save the selected region' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = renderIssueSpecBody(spec, { complexity: 5 })
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, '2026-10-27T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('fixture native Spec is not conformant')
  const ownSpec = fixtures.ownSpecFromSnapshot(uw, parsed.snapshot)
  const parentScope = { repository: uw.repository, target: 'acme/app#41' }
  const parentContent = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Deliver the parent objective' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const parentBody = renderIssueSpecBody(parentContent, { complexity: 5 })
  const parentParsed = parseIssueSpecBody({
    uw: parentScope,
    raw: rawSource(parentScope.target, parentBody, '2026-10-27T12:00:00Z'),
  })
  if (parentParsed.status !== 'conformant') throw new Error('fixture parent Spec is not conformant')
  const parentMandate = composedParent
    ? fixtures.epicMandate(
        parentScope,
        [
          {
            scope: uw,
            snapshot: parsed.snapshot,
            specVersion: parsed.snapshot.spec.version,
            tier: 'S',
          },
        ],
        {
          recordId: 'parent-mandate-41',
          body: parentBody,
          ownSpec: fixtures.ownSpecFromSnapshot(parentScope, parentParsed.snapshot),
          tier: 'F-lite',
        },
      )
    : null
  const parentHistory = parentMandate === null ? null : fixtures.historyFrom([parentMandate], 'automation')
  const mandate = fixtures.featureMandate(uw, {
    recordId: 'mandate-42',
    ownSpec,
    ...(parentMandate === null
      ? {}
      : {
          parent: fixtures.mandateRef(parentMandate),
          inheritedOwnSpecRefs: [
            {
              uw: parentScope,
              version: parentMandate.payload.ownSpec.version,
              sourceAccepted: fixtures.mandateRef(parentMandate),
            },
          ],
        }),
  })
  const own = fixtures.historyFrom([mandate], 'automation', 'automation', parentHistory === null ? [] : [parentHistory])
  const nativeGraph = graphFromSimulatedIssues(uw, [
    {
      number: 42,
      title: 'Original',
      body,
      updatedAt: '2026-10-27T12:00:00Z',
      state: 'OPEN',
      stateReason: null,
      labels: ['size:S'],
      subIssues: [],
      blockedBy: [],
    },
    ...(parentMandate === null
      ? []
      : [
          {
            number: 41,
            title: 'Parent',
            body: parentBody,
            updatedAt: '2026-10-27T12:00:00Z',
            state: 'OPEN',
            stateReason: null,
            labels: ['size:F-lite'],
            subIssues: [42],
            blockedBy: [],
          },
        ]),
  ])
  const inheritedHistories = parentHistory === null ? [] : [parentHistory]
  const accepted = resolveAcceptedSpec(mandate, [own, ...inheritedHistories])
  if (!accepted.ok) throw new Error(`Original accepted Spec unavailable: ${JSON.stringify(accepted.evidence)}`)
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.spec.ref,
    histories: [own, ...inheritedHistories],
    graph: nativeGraph,
  })
  if (!effective.ok) throw new Error(`Original effective Spec unavailable: ${JSON.stringify(effective.diagnostics)}`)
  return {
    fixtures,
    uw,
    pr,
    body,
    parentScope,
    parentBody,
    parentMandate,
    parentHistory,
    mandate,
    own,
    nativeGraph,
    inheritedHistories,
    effective,
  }
}
