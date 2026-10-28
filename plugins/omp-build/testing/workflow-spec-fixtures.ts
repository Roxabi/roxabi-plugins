import { buildRecord } from '../engine/record-construction.ts'
import { specDigest } from '../engine/record-digests.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Json, Scope } from '../engine/record-values.ts'
import { SPEC_IDENTITY_FORMAT } from '../engine/uw-identity-schema.ts'
import { canonicalSpec, type SpecSnapshot } from '../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../engine/uw-spec-schema.ts'

export type WorkflowSpecFixtureContext = {
  productVersion: string
  config: { version: string; digest: string; effective: Json }
  head: string | null
  editedAt: string
}

export type ApprovedChild = {
  scope: Scope
  specVersion: string
  snapshot: SpecSnapshot
  tier: 'S' | 'F-lite' | 'F-full'
}

export type WorkflowOwnSpec = {
  uw: Scope
  version: SpecSnapshot['spec']['version']
  snapshot: SpecSnapshot
  identityAllocations: Array<{ scope: Scope; recordId: string; kind: 'spec-identity' }>
}

function mustRecord(draft: Parameters<typeof buildRecord>[0]): CanonicalRecord {
  const result = buildRecord(draft)
  if (!result.ok) throw new Error(result.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
  return result.value
}

export function createWorkflowSpecFixtures(context: WorkflowSpecFixtureContext) {
  const snapshot = (body: string, reference: string) => {
    const canonical = canonicalSpec({
      format: SPEC_CONTENT_FORMAT,
      criteria: [{ id: 'C1', statement: body }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    })
    if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
    return {
      spec: canonical.value,
      raw: { reference, body, bodySha256: specDigest(body), lastEditedAt: context.editedAt },
    }
  }
  const ownSpecFromSnapshot = (scope: Scope, snapshot: SpecSnapshot): WorkflowOwnSpec => ({
    uw: scope,
    version: snapshot.spec.version,
    snapshot,
    identityAllocations: [{ scope, recordId: `spec-identity:${scope.target}`, kind: 'spec-identity' }],
  })
  const ownSpec = (scope: Scope, body: string): WorkflowOwnSpec => {
    const value = snapshot(body, scope.target)
    return ownSpecFromSnapshot(scope, value)
  }
  const childSnapshot = (scope: Scope, specBody: string, tier: ApprovedChild['tier'] = 'S'): ApprovedChild => {
    const value = snapshot(specBody, scope.target)
    return { scope, specVersion: value.spec.version, snapshot: value, tier }
  }
  const identityAllocation = (scope: Scope, recordId = `spec-identity:${scope.target}`) =>
    mustRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId,
      runId: recordId,
      operationId: recordId,
      kind: 'spec-identity',
      payload: {
        format: SPEC_IDENTITY_FORMAT,
        predecessor: null,
        proposalDigest: 'a'.repeat(64),
        confirmation: {
          route: 'omp-native-command',
          operationId: recordId,
          proposalDigest: 'a'.repeat(64),
          confirmedAt: '2026-10-21T00:00:00.000Z',
        },
        event: 'allocate',
        allocations: [{ draftKey: 'criterion-1', id: 'C1' }],
      },
    })
  const withIdentities = (records: readonly CanonicalRecord[]) => {
    const present = new Set(records.map((record) => `${record.repository}\0${record.target}\0${record.recordId}`))
    const additions: CanonicalRecord[] = []
    for (const record of records) {
      if (record.kind !== 'mandate') continue
      for (const ref of record.payload.ownSpec.identityAllocations) {
        const key = `${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
        if (present.has(key)) continue
        additions.push(identityAllocation(ref.scope, ref.recordId))
        present.add(key)
      }
    }
    return [...additions, ...records]
  }
  return { ownSpec, ownSpecFromSnapshot, childSnapshot, identityAllocation, withIdentities }
}
