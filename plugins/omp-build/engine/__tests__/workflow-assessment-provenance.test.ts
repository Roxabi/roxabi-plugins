import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { History } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { prepareSpecAllocation, resolveSpecIdentityLedger } from '../uw-identity.ts'
import { canonicalSpec, validateSpecIds } from '../uw-spec.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
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
