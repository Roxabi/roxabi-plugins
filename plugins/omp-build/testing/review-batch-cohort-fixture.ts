import { nativeComment } from '../adapters/__tests__/github-workflow-support.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { RecordInputRef } from '../roxabi/uw-action-contract.ts'
import { standaloneReviewInputs } from './action-input-fixtures.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { reviewGraph } from './record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'

function payloadRef(record: CanonicalRecord): RecordInputRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: record.kind,
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
}

function assertAccounted(history: DecodedHistory, record: CanonicalRecord): void {
  const matching = history.operations.filter((operation) => operation.recordId === record.recordId)
  if (matching.length !== 1 || matching[0]?.status !== 'complete' || matching[0].authority !== 'accounted')
    throw new Error(`Fixture record ${record.recordId} is not a complete accounted native operation`)
}

function assertNative(history: DecodedHistory, record: CanonicalRecord): void {
  const matching = history.operations.filter((operation) => operation.recordId === record.recordId)
  if (matching.length !== 1 || matching[0]?.status !== 'complete' || matching[0].authority === 'foreign')
    throw new Error(`Fixture record ${record.recordId} is not a complete authenticated native operation`)
}

/**
 * An independent fictional PR inventory captures a second issue's identity as
 * expanded evidence. It adds no mandate or parent to the consuming UW. The
 * encoded comments are read through the same native transport as other records.
 */
export function reviewBatchCohortFixture() {
  const external = { repository: 'acme/app', target: 'acme/app#44' }
  const recursive = { repository: 'acme/app', target: 'acme/app#43' }
  const identity = roxabiWorkflowFixtures().identityAllocation(recursive, 'cohort-recursive-identity')
  if (identity.kind !== 'spec-identity') throw new Error('Expected a fixture identity record')
  const projection = roxabiRecordFixtures().projection
  const identityHistory = encodeCriterionRecords([identity], recursive, projection, 'automation').history
  assertAccounted(identityHistory, identity)
  const identityRef = payloadRef(identity)

  const original = standaloneReviewInputs(external)
  const manifest = { ...original.manifest, expandedContext: [identityRef] }
  const inputs = { ...original, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = reviewGraph({ scope: external, prefix: 'cohort-external', inputs, head: manifest.code.head })
  const externalIdentity = roxabiWorkflowFixtures().identityAllocation(external, 'cohort-external-identity')
  if (externalIdentity.kind !== 'spec-identity') throw new Error('Expected an external fixture identity record')
  const externalHistory = encodeCriterionRecords([externalIdentity, graph.root], external, projection, 'automation', [
    identityHistory,
  ]).history
  assertAccounted(externalHistory, externalIdentity)
  assertNative(externalHistory, graph.root)
  const externalRef = payloadRef(externalIdentity)
  const comments = new Map([
    [43, identityHistory.source.comments.map((comment, index) => nativeComment(4300 + index, comment.body))],
    [44, externalHistory.source.comments.map((comment, index) => nativeComment(4400 + index, comment.body))],
  ])

  return {
    external,
    recursive,
    externalRef,
    identityRef,
    externalHistory,
    identityHistory,
    comments,
    /** Use both refs when testing selected-evidence drift through preparation. */
    expandedContext: [externalRef, identityRef],
    /** Use only this ref to prove #43 is discovered transitively from #44. */
    recursiveExpandedContext: [externalRef],
    removeIdentity() {
      comments.set(43, [])
    },
    removeExternal() {
      comments.set(44, [])
    },
  }
}
