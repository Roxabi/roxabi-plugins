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
import { observeAssessmentContextReplay, workflowContextTerminal } from '../workflow-context-terminal.ts'
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

test('replays the current assessment without losing an authenticated historical retirement', () => {
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
  const retirement = assessFixture(historical, 'retire-c1', original, proposed, 'material')
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
  const state = mandateAssessmentState(current)
  const pending = assessFixture(
    current,
    'current-pending',
    state,
    { snapshot: state.snapshot, tier: state.tier, children: state.children },
    'editorial',
  )
  if (
    pending.start.kind !== 'action-receipt' ||
    pending.start.payload.action !== 'assess-spec' ||
    pending.start.payload.phase !== 'start'
  )
    throw new Error('expected pending assessment')
  const replay = { actionId: pending.start.payload.actionId, fingerprint: pending.start.payload.inputs.fingerprint }
  const foreign = must(
    buildRecord({
      ...pending.start,
      recordId: 'foreign-collision',
      operationId: 'foreign-collision-op',
      payload: { ...pending.start.payload, mandate: ref(historical) },
    }),
  )
  const records = [first, second, historical, retirement.start, retirement.result, control, current, pending.start]
  const issue = decode([...records, foreign], new Set([foreign.recordId]))
  const accepted = resolveAcceptedSpec(current, [issue], replay)
  if (!accepted.ok) throw new Error(`current replay refused: ${accepted.reason}`)
  expect(accepted.spec.snapshot.spec.criteria.map((item) => item.id)).toEqual(['C2'])
  expect(resolveAcceptedSpec(current, [issue])).toMatchObject({ ok: false })
  const ledgerInput = { uw: SCOPE, history: issue, histories: [issue], accepted: accepted.spec }
  expect(resolveSpecIdentityLedger(ledgerInput)).toMatchObject({ ok: false })
  const ledger = must(resolveSpecIdentityLedger({ ...ledgerInput, assessmentReplay: replay }))
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
  const foreignOnly = decode([...records.slice(0, -1), foreign], new Set([foreign.recordId]))
  expect(resolveAcceptedSpec(current, [foreignOnly], replay)).toMatchObject({ ok: false })
  expect(
    resolveSpecIdentityLedger({
      uw: SCOPE,
      history: foreignOnly,
      histories: [foreignOnly],
      accepted: accepted.spec,
      assessmentReplay: replay,
    }),
  ).toMatchObject({ ok: false })
  const other = assessFixture(
    current,
    'competing-pending',
    state,
    { snapshot: state.snapshot, tier: state.tier, children: state.children },
    'editorial',
  )
  const competing = decode([...records, foreign, other.start], new Set([foreign.recordId]))
  expect(resolveAcceptedSpec(current, [competing], replay)).toMatchObject({ ok: false })
  expect(
    resolveSpecIdentityLedger({
      uw: SCOPE,
      history: competing,
      histories: [competing],
      accepted: accepted.spec,
      assessmentReplay: replay,
    }),
  ).toMatchObject({ ok: false })
})

test('active assessment replay refuses invalid negative-context successors', () => {
  const mandated = shippedFeatureMandate()
  const state = mandateAssessmentState(mandated)
  const proposed = { snapshot: state.snapshot, tier: state.tier, children: state.children }
  const prior = assessFixture(mandated, 'negative', state, proposed, 'editorial')
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
  const replay = { actionId: pending.payload.actionId, fingerprint: inputs.fingerprint }
  // The mandate's allocation is part of the fixture's authenticated history.
  const base = decode([mandated, prior.start, negative, pending])
  const actual = retainedStart(base, pending.recordId)
  expect(workflowContextTerminal(base, 'assess-spec')).toBe('uncertain')
  expect(observeAssessmentContextReplay(base, actual)).toBe('observed')
  expect(resolveAcceptedSpec(mandated, [base])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [base], replay)).toMatchObject({ ok: true })
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
    const changed = must(buildRecord({ ...pending, payload: { ...pending.payload, inputs: changedInputs } }))
    const issue = decode([mandated, prior.start, negative, changed])
    const observed = observeAssessmentContextReplay(issue, retainedStart(issue, changed.recordId))
    expect(observed, item.name).not.toBe('observed')
    expect(
      resolveAcceptedSpec(mandated, [issue], { actionId: replay.actionId, fingerprint: changedInputs.fingerprint }),
      item.name,
    ).toMatchObject({ ok: false })
  }
  const completed = assessFixture(mandated, 'completed-successor', state, proposed, 'editorial')
  if (
    completed.start.kind !== 'action-receipt' ||
    completed.start.payload.action !== 'assess-spec' ||
    completed.start.payload.phase !== 'start'
  )
    throw new Error('expected successor start')
  const successorStart = must(buildRecord({ ...completed.start, payload: { ...completed.start.payload, inputs } }))
  const successorResult = must(buildRecord({ ...completed.result, payload: { ...completed.result.payload, inputs } }))
  const fork = decode([mandated, prior.start, negative, successorStart, successorResult, pending])
  expect(observeAssessmentContextReplay(fork, retainedStart(fork, pending.recordId))).toBe('ambiguous')
  expect(resolveAcceptedSpec(mandated, [fork], replay)).toMatchObject({ ok: false })
})
