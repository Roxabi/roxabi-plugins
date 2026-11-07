import { describe, expect, it } from 'vitest'
import { causeDependencyAdjustmentProposalSchema } from '../cause-dependency-adjustment-schema.ts'
import { causeAdjustmentExpectedEffect } from '../cause-dependency-control.ts'
import { nativeObservationDigest } from '../uw-native-observation-schema.ts'

const origin = { repository: 'acme/repo', target: 'acme/repo#1' }
const old = { repository: 'acme/repo', target: 'acme/repo#2' }
const replacement = { repository: 'acme/repo', target: 'acme/repo#3' }
const unrelated = { repository: 'acme/repo', target: 'acme/repo#4' }
const ref = (kind: string, recordId: string) => ({ scope: origin, kind, recordId })
const before = {
  issue: { repository: origin.repository, number: 1 },
  title: 'Exact title',
  body: 'Exact body\n',
  updatedAt: '2026-01-01T00:00:00Z',
  nativeState: { state: 'OPEN' as const, stateReason: 'REOPENED' },
  labels: ['b', 'a'],
  parent: null,
  children: [],
  blockers: [
    { repository: old.repository, number: 2 },
    { repository: unrelated.repository, number: 4 },
  ],
}
const own = { uw: origin, version: 'a'.repeat(64), sourceAccepted: ref('mandate', 'mandate') }
function proposal(nativeEffect: unknown, change: unknown = { kind: 'replace', blocker: replacement }) {
  return causeDependencyAdjustmentProposalSchema.parse({
    format: 'omp-build-cause-dependency-adjustment/1',
    operationId: 'operation',
    controlId: 'control',
    origin,
    mandate: ref('mandate', 'mandate'),
    accepted: own,
    versionVector: [own],
    disposition: ref('cause-disposition', 'cause'),
    receipt: ref('debt-receipt', 'receipt'),
    predecessor: ref('debt-receipt', 'receipt'),
    change,
    reason: 'Correct the dependency',
    references: [],
    before,
    nativeObservationDigest: nativeObservationDigest(before),
    histories: [{ scope: origin, digest: 'b'.repeat(64) }],
    nativeGraph: { root: origin, rows: [{ uw: origin, digest: nativeObservationDigest(before) }] },
    nativeEffect,
  })
}

describe('confirmed causal adjustment native effect', () => {
  it('preserves every native fact when no native mutation is authorized', () => {
    expect(causeAdjustmentExpectedEffect(proposal({ kind: 'none' }, { kind: 'withdraw' }), old)).toEqual(before)
  })
  it('removes only the causal target and adds only its explicit replacement', () => {
    const value = causeAdjustmentExpectedEffect(
      proposal({ kind: 'update-blockers', remove: [old], add: [replacement] }),
      old,
    )
    expect(value?.blockers).toEqual([
      { repository: unrelated.repository, number: 4 },
      { repository: replacement.repository, number: 3 },
    ])
    expect(value?.body).toBe(before.body)
    expect(value?.nativeState).toEqual(before.nativeState)
  })
  it('refuses unrelated removals, unrelated additions and empty updates', () => {
    expect(
      causeAdjustmentExpectedEffect(proposal({ kind: 'update-blockers', remove: [unrelated], add: [] }), old),
    ).toBeNull()
    expect(
      causeAdjustmentExpectedEffect(proposal({ kind: 'update-blockers', remove: [], add: [unrelated] }), old),
    ).toBeNull()
    expect(causeAdjustmentExpectedEffect(proposal({ kind: 'update-blockers', remove: [], add: [] }), old)).toBeNull()
  })
})
