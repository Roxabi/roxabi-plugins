import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import type { DecodedHistory, History } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import {
  buildSpecIdentityAllocation,
  buildSpecIdentityProposedRetirement,
  prepareSpecAllocation,
  resolveSpecIdentityLedger,
} from '../uw-identity.ts'
import { canonicalSpec, type SpecItemId, type SpecSnapshot, validateSpecIds } from '../uw-spec.ts'
import type { AcceptedOwnSpec } from '../workflow-accepted-spec-types.ts'

const UW: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const DIGEST = 'a'.repeat(64)
const CONFIRMED_AT = '2026-10-27T12:00:00Z'

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(','))
  return result.value
}

function ref(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

type NativeFrameTiming = {
  createdAt: string
  updatedAt: string
  revisedRecordIds: ReadonlySet<string>
}
const DEFAULT_FRAME_TIMING: NativeFrameTiming = {
  createdAt: CONFIRMED_AT,
  updatedAt: CONFIRMED_AT,
  revisedRecordIds: new Set(),
}

function decode(
  records: readonly CanonicalRecord[],
  complete = true,
  timing: NativeFrameTiming = DEFAULT_FRAME_TIMING,
): DecodedHistory {
  const comments: History['comments'] = []
  for (const [index, record] of records.entries()) {
    const frames = must(encodeParts(record, `# ${record.kind}`, 65_536))
    comments.push(
      ...frames.map((body, frame) => ({
        locator: `comment-${index + 1}-${frame + 1}`,
        nativeId: String(index * 10 + frame + 1),
        body,
        author: 'operator',
        createdAt: timing.createdAt,
        updatedAt: timing.revisedRecordIds.has(record.recordId) ? timing.updatedAt : timing.createdAt,
      })),
    )
  }
  return decodeHistory({
    scope: UW,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete,
    comments,
    diagnostics: [],
  })
}

function allocation(recordId: string, operationId: string, predecessor: ExternalRecordRef | null, id: 'C1' | 'C2') {
  return must(
    buildRecord({
      version: 1,
      repository: UW.repository,
      target: UW.target,
      recordId,
      runId: operationId,
      operationId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        predecessor,
        proposalDigest: DIGEST,
        confirmation: {
          route: 'omp-native-command',
          operationId,
          proposalDigest: DIGEST,
          confirmedAt: CONFIRMED_AT,
        },
        event: 'allocate',
        allocations: [{ draftKey: `draft-${id}`, id }],
      },
    }),
  )
}

function retireProposed(recordId: string, operationId: string, predecessor: ExternalRecordRef, id: SpecItemId) {
  return must(
    buildRecord({
      version: 1,
      repository: UW.repository,
      target: UW.target,
      recordId,
      runId: operationId,
      operationId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        predecessor,
        proposalDigest: DIGEST,
        confirmation: {
          route: 'omp-native-command',
          operationId,
          proposalDigest: DIGEST,
          confirmedAt: CONFIRMED_AT,
        },
        event: 'retire-proposed',
        ids: [id],
      },
    }),
  )
}

function snapshot(criteria: { id: 'C1' | 'C2'; statement: string }[]): SpecSnapshot {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria,
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = criteria.map(({ id, statement }) => `${id}: ${statement}`).join('\n')
  return { spec, raw: { reference: UW.target, body, bodySha256: specDigest(body), lastEditedAt: CONFIRMED_AT } }
}

function acceptedHistoricalC1(source: ExternalRecordRef): AcceptedOwnSpec {
  const historical = snapshot([{ id: 'C1', statement: 'Original accepted commitment' }])
  return {
    ref: { uw: UW, version: historical.spec.version, sourceAccepted: source },
    snapshot: historical,
    tier: 'S',
    children: [],
    chain: [
      {
        kind: 'accept-material',
        source,
        assessment: { scope: UW, recordId: 'assessment-retire-c1', kind: 'action-receipt' },
        from: historical.spec.version,
        to: historical.spec.version,
        proposalDigest: DIGEST,
      },
    ],
    sourceRefs: [source],
  }
}

function materialAcceptance(
  recordId: string,
  predecessor: ExternalRecordRef,
  retired: readonly 'C1'[] = [],
): CanonicalRecord {
  return must(
    buildRecord({
      version: 1,
      repository: UW.repository,
      target: UW.target,
      recordId,
      runId: 'run-accept-retirement',
      operationId: 'op-accept-retirement',
      kind: 'operator-control',
      payload: {
        control: 'accept-material',
        controlId: 'accept-retirement',
        mandate: { scope: UW, recordId: 'mandate-41', kind: 'mandate' },
        predecessor,
        assessment: { scope: UW, recordId: 'assessment-retire-c1', kind: 'action-receipt' },
        specVersion: DIGEST,
        proposalDigest: DIGEST,
        confirmation: {
          route: 'omp-native-command',
          operationId: 'op-accept-retirement',
          proposalDigest: DIGEST,
          confirmedAt: CONFIRMED_AT,
        },
        identityDelta: { retired: [...retired] },
      },
    }),
  )
}

function codes(
  result: { ok: true; value: unknown } | { ok: false; diagnostics: readonly { code: string }[] },
): string[] {
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code)
}

test('persists pre-mandate allocations through decoded history and never text-matches a later draft', () => {
  const empty = must(resolveSpecIdentityLedger({ uw: UW, history: decode([]), accepted: null }))
  const firstPlan = must(
    prepareSpecAllocation(
      {
        criteria: [{ kind: 'new', draftKey: 'first-commitment', statement: 'Send the payout exactly once' }],
        invariants: [{ kind: 'new', draftKey: 'audit', statement: 'Retain the audit trail' }],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
      empty,
    ),
  )
  const draft = must(
    buildSpecIdentityAllocation({
      uw: UW,
      plan: firstPlan,
      proposalDigest: DIGEST,
      operationId: 'allocate-first',
      confirmation: {
        route: 'omp-native-command',
        operationId: 'allocate-first',
        proposalDigest: DIGEST,
        confirmedAt: CONFIRMED_AT,
      },
    }),
  )
  const persisted = must(buildRecord(draft))
  const reloaded = must(resolveSpecIdentityLedger({ uw: UW, history: decode([persisted]), accepted: null }))

  expect(firstPlan.assignments).toEqual([
    { draftKey: 'first-commitment', id: 'C1' },
    { draftKey: 'audit', id: 'I1' },
  ])
  expect(reloaded.allocations.get('C1')).toMatchObject({ recordId: persisted.recordId })
  expect(
    must(
      prepareSpecAllocation(
        {
          criteria: [{ kind: 'new', draftKey: 'same-words', statement: 'Send the payout exactly once' }],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
        reloaded,
      ),
    ).assignments,
  ).toEqual([{ draftKey: 'same-words', id: 'C2' }])
})

test('names unknown, duplicate, retired, incomplete, colliding, and forked identity histories', () => {
  const first = allocation('identity-c1', 'allocate-c1', null, 'C1')
  const ledger = must(resolveSpecIdentityLedger({ uw: UW, history: decode([first]), accepted: null }))
  const unknown = snapshot([{ id: 'C2', statement: 'Never allocated' }]).spec
  const duplicate = {
    ...snapshot([{ id: 'C1', statement: 'One' }]).spec,
    criteria: [
      { id: 'C1' as const, statement: 'One' },
      { id: 'C1' as const, statement: 'Repeated' },
    ],
  }
  const retired = retireProposed('retire-c1', 'retire-c1', ref(first), 'C1')
  const retiredLedger = must(resolveSpecIdentityLedger({ uw: UW, history: decode([first, retired]), accepted: null }))
  const collision = allocation('identity-c1-again', 'allocate-c1-again', ref(first), 'C1')
  const fork = allocation('identity-c2-fork', 'allocate-c2-fork', null, 'C2')

  expect(codes(validateSpecIds(unknown, ledger))).toContain('spec-id-unallocated')
  expect(codes(validateSpecIds(duplicate, ledger))).toContain('spec-id-duplicate')
  expect(codes(validateSpecIds(snapshot([{ id: 'C1', statement: 'Re-added' }]).spec, retiredLedger))).toContain(
    'spec-id-retired',
  )
  expect(codes(resolveSpecIdentityLedger({ uw: UW, history: decode([first, collision]), accepted: null }))).toContain(
    'spec-ledger-conflict',
  )
  expect(codes(resolveSpecIdentityLedger({ uw: UW, history: decode([first, fork]), accepted: null }))).toContain(
    'spec-ledger-conflict',
  )
  expect(codes(resolveSpecIdentityLedger({ uw: UW, history: decode([first], false), accepted: null }))).toContain(
    'spec-ledger-incomplete',
  )
})

test('does not retire an omitted proposal, but recognizes authenticated accepted retirement without invalidating its historical snapshot', () => {
  const first = allocation('identity-c1', 'allocate-c1', null, 'C1')
  const allocated = must(resolveSpecIdentityLedger({ uw: UW, history: decode([first]), accepted: null }))
  const omitted = must(
    prepareSpecAllocation(
      {
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
      allocated,
    ),
  )
  const acceptedRetirement = materialAcceptance('accept-retire-c1', ref(first), ['C1'])
  const historicalAccepted = acceptedHistoricalC1(ref(acceptedRetirement))
  const withAcceptedRetirement = resolveSpecIdentityLedger({
    uw: UW,
    history: decode([first, acceptedRetirement]),
    accepted: historicalAccepted,
  })
  const proposedRetirement = retireProposed('retire-accepted-c1', 'retire-accepted-c1', ref(first), 'C1')
  const activeAcceptance = materialAcceptance('accept-keep-c1', ref(first))
  const activeAccepted = acceptedHistoricalC1(ref(activeAcceptance))
  const forbiddenProposedRetirement = resolveSpecIdentityLedger({
    uw: UW,
    history: decode([first, activeAcceptance, proposedRetirement]),
    accepted: activeAccepted,
  })

  expect(omitted.assignments).toEqual([])
  expect(allocated.retired.has('C1')).toBe(false)
  expect(must(withAcceptedRetirement).retired.has('C1')).toBe(true)
  expect(forbiddenProposedRetirement).toMatchObject({ ok: false })
  expect(codes(forbiddenProposedRetirement)).toContain('spec-ledger-conflict')
})
test('persists a confirmed pre-mandate withdrawal so the identity cannot return after reload', () => {
  const first = allocation('identity-c1', 'allocate-c1', null, 'C1')
  const allocated = must(resolveSpecIdentityLedger({ uw: UW, history: decode([first]), accepted: null }))
  const withdrawnPlan = must(
    prepareSpecAllocation(
      {
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
      allocated,
    ),
  )
  const withdrawal = must(
    buildSpecIdentityProposedRetirement({
      uw: UW,
      plan: withdrawnPlan,
      predecessor: ref(first),
      proposalDigest: DIGEST,
      operationId: 'withdraw-c1',
      confirmation: {
        route: 'omp-native-command',
        operationId: 'withdraw-c1',
        proposalDigest: DIGEST,
        confirmedAt: CONFIRMED_AT,
      },
    }),
  )
  const reloaded = must(
    resolveSpecIdentityLedger({ uw: UW, history: decode([first, must(buildRecord(withdrawal))]), accepted: null }),
  )

  expect(withdrawnPlan.retirements).toEqual(['C1'])
  expect(withdrawal.payload.predecessor).toEqual(ref(first))
  expect(
    codes(
      prepareSpecAllocation(
        {
          criteria: [{ kind: 'existing', id: 'C1', statement: 'Re-add' }],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
        reloaded,
      ),
    ),
  ).toContain('spec-id-retired')
  expect(
    must(
      prepareSpecAllocation(
        {
          criteria: [{ kind: 'new', draftKey: 'replacement', statement: 'Replacement commitment' }],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
        reloaded,
      ),
    ).assignments,
  ).toEqual([{ draftKey: 'replacement', id: 'C2' }])
})
test('ignores copied foreign identity frames but refuses incomplete trusted identity frames', () => {
  const first = allocation('identity-c1', 'allocate-c1', null, 'C1')
  const trusted = decode([first])
  const copied = trusted.operations[0]
  if (copied === undefined) throw new Error('expected decoded identity operation')
  const foreign = {
    ...trusted,
    operations: [
      ...trusted.operations,
      { ...copied, authority: 'foreign' as const, status: 'incomplete' as const, record: null },
    ],
  }
  const incompleteTrusted = {
    ...trusted,
    operations: [
      ...trusted.operations,
      { ...copied, authority: 'authority' as const, status: 'incomplete' as const, record: null },
    ],
  }

  expect(resolveSpecIdentityLedger({ uw: UW, history: foreign, accepted: null })).toEqual(
    resolveSpecIdentityLedger({ uw: UW, history: trusted, accepted: null }),
  )
  expect(codes(resolveSpecIdentityLedger({ uw: UW, history: incompleteTrusted, accepted: null }))).toContain(
    'spec-ledger-incomplete',
  )
})
test('refuses an edited local retirement before it can resurrect its original identity', () => {
  const first = allocation('identity-c1', 'allocate-c1', null, 'C1')
  const second = allocation('identity-c2', 'allocate-c2', ref(first), 'C2')
  const retiredC1 = retireProposed('retire-c1', 'retire-c1', ref(second), 'C1')
  const nativeFrame: NativeFrameTiming = {
    createdAt: '2026-10-27T12:00:00Z',
    updatedAt: '2026-10-27T12:01:00Z',
    revisedRecordIds: new Set(),
  }
  const unedited = must(
    resolveSpecIdentityLedger({
      uw: UW,
      history: decode([first, second, retiredC1], true, nativeFrame),
      accepted: null,
    }),
  )
  const replacement = retireProposed('retire-c1', 'retire-c1', ref(second), 'C2')
  const revised = decode([first, second, replacement], true, {
    ...nativeFrame,
    revisedRecordIds: new Set([replacement.recordId]),
  })

  expect(
    codes(validateSpecIds(snapshot([{ id: 'C1', statement: 'Resurrected commitment' }]).spec, unedited)),
  ).toContain('spec-id-retired')
  expect(resolveSpecIdentityLedger({ uw: UW, history: revised, accepted: null })).toMatchObject({ ok: false })
})
