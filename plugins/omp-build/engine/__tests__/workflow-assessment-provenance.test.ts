import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DecodedHistory, History } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { prepareSpecAllocation, resolveSpecIdentityLedger } from '../uw-identity.ts'
import { canonicalSpec, validateSpecIds } from '../uw-spec.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { workflowContextTerminal } from '../workflow-context-terminal.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { mandate, must, SCOPE } from './workflow-test-support.ts'

const time = '2026-10-27T12:00:00Z'

function ref(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  }
}

// A fictional native store: records cross the same encoder/decoder and binding boundary as observed comments.
function decode(records: CanonicalRecord[], foreign = new Set<string>()) {
  const complete = [...records]
  const fixtures = roxabiWorkflowFixtures()
  for (const record of records) {
    if (record.kind !== 'mandate') continue
    for (const identity of record.payload.ownSpec.identityAllocations) {
      if (!complete.some((item) => item.recordId === identity.recordId && item.target === identity.scope.target))
        complete.unshift(fixtures.identityAllocation(identity.scope, identity.recordId))
    }
  }
  const comments: History['comments'] = []
  for (const [index, record] of complete.entries()) {
    const frames = must(encodeParts(record, `# ${record.kind}`, 65_536))
    comments.push(
      ...frames.map((body, part) => ({
        locator: `comment-${index}-${part}`,
        nativeId: String(index * 100 + part + 1),
        body,
        author: foreign.has(record.recordId) ? 'stranger' : 'operator',
        createdAt: time,
        updatedAt: time,
      })),
    )
  }
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
}

function allocation(recordId: string, predecessor: ExternalRecordRef | null, id: 'C1' | 'C2') {
  const digest = 'a'.repeat(64)
  return must(
    buildRecord({
      version: 1,
      repository: SCOPE.repository,
      target: SCOPE.target,
      recordId,
      runId: recordId,
      operationId: recordId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        predecessor,
        proposalDigest: digest,
        confirmation: { route: 'omp-native-command', operationId: recordId, proposalDigest: digest, confirmedAt: time },
        event: 'allocate',
        allocations: [{ draftKey: `draft-${id}`, id }],
      },
    }),
  )
}

function retainedStart(issue: DecodedHistory, id: string) {
  const record = issue.operations.find((op) => op.recordId === id && op.authority === 'accounted')?.record
  if (record?.kind !== 'action-receipt' || record.payload.action !== 'assess-spec' || record.payload.phase !== 'start')
    throw new Error('decoded assessment start missing')
  return record
}

test('retains retired identities across authenticated historical mandates', () => {
  const first = allocation('identity-c1', null, 'C1')
  const second = allocation('identity-c2', ref(first), 'C2')
  const base = mandate({ scope: SCOPE })
  if (base.kind !== 'mandate') throw new Error('expected mandate')
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [
        { id: 'C1', statement: 'Original commitment' },
        { id: 'C2', statement: 'Kept commitment' },
      ],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = 'C1: Original commitment\nC2: Kept commitment'
  const initial = { spec, raw: { reference: SCOPE.target, body, bodySha256: specDigest(body), lastEditedAt: time } }
  const historical = must(
    buildRecord({
      ...base,
      payload: {
        ...base.payload,
        ownSpec: {
          ...base.payload.ownSpec,
          uw: SCOPE,
          version: spec.version,
          snapshot: initial,
          identityAllocations: [ref(first), ref(second)],
        },
      },
    }),
  )
  if (historical.kind !== 'mandate') throw new Error('expected historical mandate')
  const original = mandateAssessmentState(historical)
  const proposed = proposedAssessmentState(original, {
    body: 'Kept commitment',
    content: {
      criteria: [{ id: 'C2', statement: 'Kept commitment' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
  })
  const retirement = assessFixture(historical, 'retire-c1', original, proposed, 'material', [
    decode([first, second, historical]),
  ])
  const control = acceptMaterialFixture(historical, 'accept-retirement', retirement)
  const current = must(
    buildRecord({
      ...historical,
      recordId: 'current-mandate',
      operationId: 'current-mandate-op',
      payload: {
        ...historical.payload,
        antecedent: ref(historical),
        ownSpec: {
          ...historical.payload.ownSpec,
          version: proposed.snapshot.spec.version,
          snapshot: proposed.snapshot,
        },
      },
    }),
  )
  if (current.kind !== 'mandate') throw new Error('expected current mandate')
  const issue = decode([first, second, historical, retirement.start, retirement.result, control, current])
  const accepted = resolveAcceptedSpec(current, [issue])
  if (!accepted.ok) throw new Error(`Current mandate history refused: ${accepted.reason}`)
  expect(accepted.spec.snapshot.spec.criteria.map((item) => item.id)).toEqual(['C2'])
  const ledgerInput = { uw: SCOPE, history: issue, histories: [issue], accepted: accepted.spec }
  const ledger = must(resolveSpecIdentityLedger(ledgerInput))
  expect(ledger.retired.get('C1')).toEqual(ref(control))
  expect(validateSpecIds(initial.spec, ledger)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-id-retired' })]),
  })
  const plan = must(
    prepareSpecAllocation(
      {
        criteria: [{ kind: 'new', draftKey: 'replacement', statement: 'A new commitment' }],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
      ledger,
    ),
  )
  expect(plan.assignments).toEqual([{ draftKey: 'replacement', id: 'C3' }])
})

test('historical assessments reject completed successors with invalid expanded-context provenance', () => {
  const mandated = shippedFeatureMandate()
  const state = mandateAssessmentState(mandated)
  const proposed = {
    snapshot: state.snapshot,
    tier: state.tier,
    children: state.children,
    inheritedOwnSpecRefs: state.inheritedOwnSpecRefs,
    coverage: state.coverage,
  }
  const prior = assessFixture(mandated, 'negative', state, proposed, 'editorial', [decode([mandated])])
  if (
    prior.start.kind !== 'action-receipt' ||
    prior.start.payload.action !== 'assess-spec' ||
    prior.start.payload.phase !== 'start'
  )
    throw new Error('expected start')
  const negative = must(
    buildRecord({
      ...prior.result,
      payload: {
        ...prior.result.payload,
        structured: {
          outcome: 'missing-context',
          missing: [{ locator: { kind: 'information-request', description: 'policy' }, reason: 'needed', targets: [] }],
        },
      },
    }),
  )
  if (
    negative.kind !== 'action-receipt' ||
    negative.payload.action !== 'assess-spec' ||
    negative.payload.phase !== 'result'
  )
    throw new Error('expected result')
  const lineage = {
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(negative.payload),
  }
  const added = {
    source: 'git-file' as const,
    repository: SCOPE.repository,
    commit: 'b'.repeat(40),
    path: 'policy.txt',
    digest: 'c'.repeat(64),
  }
  const manifest = { ...prior.start.payload.inputs.manifest, expandedContext: [lineage, added] }
  const inputs = { ...prior.start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const pending = must(
    buildRecord({
      ...prior.start,
      recordId: 'expanded-start',
      operationId: 'expanded-op',
      payload: { ...prior.start.payload, actionId: 'expanded-action', inputs },
    }),
  )
  if (
    pending.kind !== 'action-receipt' ||
    pending.payload.action !== 'assess-spec' ||
    pending.payload.phase !== 'start'
  )
    throw new Error('expected expanded start')
  const completed = must(
    buildRecord({
      ...prior.result,
      recordId: 'expanded-result',
      operationId: 'expanded-result-op',
      payload: {
        ...prior.result.payload,
        actionId: pending.payload.actionId,
        inputs,
        start: ref(pending),
      },
    }),
  )
  if (
    completed.kind !== 'action-receipt' ||
    completed.payload.action !== 'assess-spec' ||
    completed.payload.phase !== 'result'
  )
    throw new Error('Expected completed expanded-context result')
  // The mandate's allocation is part of the fixture's authenticated history.
  const base = decode([mandated, prior.start, negative, pending])
  const actual = retainedStart(base, pending.recordId)
  expect(workflowContextTerminal(base, 'assess-spec', actual.payload.mandate)).toBe('uncertain')
  expect(resolveAcceptedSpec(mandated, [base])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [decode([mandated, prior.start, negative, pending, completed])])).toMatchObject({
    ok: true,
  })
  const stageRef = { ...lineage, record: { ...lineage.record, recordId: 'other-stage' } }
  const cases = [
    {
      name: 'changed negative digest',
      manifest: { ...manifest, expandedContext: [{ ...lineage, digest: 'd'.repeat(64) }, added] },
      stageSources: inputs.stageSources,
    },
    {
      name: 'no new context',
      manifest: { ...manifest, expandedContext: [lineage] },
      stageSources: inputs.stageSources,
    },
    {
      name: 'changed authority',
      manifest: { ...manifest, code: { ...manifest.code, head: 'd'.repeat(40) } },
      stageSources: inputs.stageSources,
    },
    { name: 'changed stage sources', manifest, stageSources: [stageRef] },
  ]
  for (const item of cases) {
    const changedInputs = {
      ...inputs,
      manifest: item.manifest,
      fingerprint: actionInputDigest(item.manifest),
      stageSources: item.stageSources,
    }
    const changedStart = must(buildRecord({ ...pending, payload: { ...pending.payload, inputs: changedInputs } }))
    const changedResult = must(buildRecord({ ...completed, payload: { ...completed.payload, inputs: changedInputs } }))
    const issue = decode([mandated, prior.start, negative, changedStart, changedResult])
    expect(resolveAcceptedSpec(mandated, [issue]), item.name).toMatchObject({
      ok: false,
      evidence: [{ code: 'action-context-missing' }],
    })
  }
})
