import { expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { nativeCorrectionRecords } from '../../testing/native-correction-records.ts'
import { NATIVE_AUTHOR, TEST_SCOPE } from '../../testing/record-builders.ts'
import { observedComment } from '../../testing/record-history.ts'
import { resolveCorrectionRootBasis } from '../correction-request-basis.ts'
import { parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { ObservedComment } from '../review-schema.ts'

function history(records: CanonicalRecord[]) {
  const comments: ObservedComment[] = []
  for (const record of records) {
    const encoded = encodeParts(record, 'Captured correction fixture', 65_536)
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.diagnostics))
    for (const body of encoded.value) {
      const id = String(comments.length + 100)
      comments.push(observedComment({ locator: `root-${id}`, nativeId: id, body }))
    }
  }
  return decodeHistory({
    scope: TEST_SCOPE,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
}

function fixture() {
  const records = nativeCorrectionRecords()
  const fix = records.find((record) => record.kind === 'fix-request')
  const root = records.find((record) => record.kind === 'contribution' && record.payload.content === 'operator-request')
  const inventory = records.find((record) => record.kind === 'review-attempt' && record.payload.stage === 'initial')
  if (fix?.kind !== 'fix-request' || root?.kind !== 'contribution' || inventory?.kind !== 'review-attempt')
    throw new Error('captured-correction-root-missing')
  const attempt = root.payload.rawAttempts[0]
  if (!attempt) throw new Error('captured-operator-attempt-missing')
  const head = inventory.payload.candidateGitSHA
  const binding = {
    publicationRepository: TEST_SCOPE.repository,
    localBranch: 'feature',
    destinationRef: 'refs/heads/feature',
    localHead: head,
    expectedRemoteSHA: head,
    observed: {
      target: TEST_SCOPE.target,
      baseRepository: TEST_SCOPE.repository,
      localRef: 'refs/heads/feature',
      localHead: head,
      remoteRepository: TEST_SCOPE.repository,
      pr: { headRefOid: head, headRefName: 'feature', baseRefName: 'main', headRepository: TEST_SCOPE.repository },
    },
  }
  const makeRoot = (raw: unknown) => {
    const parsed = parseRecord({ ...root, payload: { ...root.payload, rawAttempts: [{ ...attempt, raw }] } })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics))
    return parsed.value
  }
  const raw = { operatorRequest: { request: 'repair' }, candidateGitSHA: head, publishBinding: binding }
  const rootWith = (value: unknown) =>
    records.map((record) => (record.recordId === root.recordId ? makeRoot(value) : record))
  return { records, fix, root, raw, binding, head, rootWith }
}

it('authenticates the canonical decision-free request root', () => {
  const f = fixture()
  expect(resolveCorrectionRootBasis(history(f.rootWith(f.raw)), f.fix)).toMatchObject({
    ok: true,
    value: { originalCandidate: f.head, expectedRemoteHead: f.head, branch: 'feature', base: 'main' },
  })
})

it('refuses each H1 mismatch and the old unauthenticated request form', () => {
  const f = fixture()
  const b = f.binding
  const variants = [
    { ...f.raw, candidateGitSHA: null },
    { ...f.raw, publishBinding: null },
    ...[
      { localHead: 'f'.repeat(40) },
      { expectedRemoteSHA: 'f'.repeat(40) },
      { localBranch: '' },
      { destinationRef: 'refs/heads/other' },
      { publicationRepository: 'other/repo' },
    ].map((patch) => ({ ...f.raw, publishBinding: { ...b, ...patch } })),
    ...[
      { localHead: 'f'.repeat(40) },
      { localRef: 'refs/heads/other' },
      { remoteRepository: 'other/repo' },
      { target: 'acme/widgets#999' },
      { baseRepository: 'other/repo' },
    ].map((patch) => ({ ...f.raw, publishBinding: { ...b, observed: { ...b.observed, ...patch } } })),
    ...[
      { headRefOid: 'f'.repeat(40) },
      { headRefName: 'other' },
      { headRepository: 'other/repo' },
      { baseRefName: '' },
    ].map((patch) => ({
      ...f.raw,
      publishBinding: { ...b, observed: { ...b.observed, pr: { ...b.observed.pr, ...patch } } },
    })),
  ]
  for (const raw of variants)
    expect(resolveCorrectionRootBasis(history(f.rootWith(raw)), f.fix).ok, JSON.stringify(raw)).toBe(false)
  expect(resolveCorrectionRootBasis(history(f.records), f.fix).ok).toBe(false)
})

it('refuses a foreign root or fix request even when its H1 data is intact', () => {
  const f = fixture()
  const original = history(f.rootWith(f.raw))
  for (const id of [f.root.recordId, f.fix.recordId]) {
    const foreign = {
      ...original,
      operations: original.operations.map((operation) =>
        operation.recordId === id ? { ...operation, authority: 'foreign' as const } : operation,
      ),
    }
    expect(resolveCorrectionRootBasis(foreign, f.fix).ok, id).toBe(false)
  }
})
