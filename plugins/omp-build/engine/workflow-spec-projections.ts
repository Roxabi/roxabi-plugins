import type { ExternalRecordRef } from './record-references.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'

export function refProjection(ref: ExternalRecordRef) {
  return {
    scope: { repository: ref.scope.repository, target: ref.scope.target },
    recordId: ref.recordId,
    kind: ref.kind,
  }
}

/** Historical proposal digests retain the captured observation timestamp. */
export function snapshotProjection(snapshot: AssessSpecExact['proposed']['snapshot']) {
  return {
    spec: {
      format: snapshot.spec.format,
      criteria: snapshot.spec.criteria.map((item) => ({ id: item.id, statement: item.statement })),
      invariants: snapshot.spec.invariants.map((item) => ({ id: item.id, statement: item.statement })),
      exclusions: [...snapshot.spec.exclusions],
      openQuestions: [...snapshot.spec.openQuestions],
      sections: { ...snapshot.spec.sections },
      version: snapshot.spec.version,
    },
    raw: {
      reference: snapshot.raw.reference,
      body: snapshot.raw.body,
      bodySha256: snapshot.raw.bodySha256,
      lastEditedAt: snapshot.raw.lastEditedAt,
    },
  }
}

export function childrenProjection(children: AssessSpecExact['proposed']['children']) {
  return children.map((child) =>
    'kind' in child
      ? {
          kind: child.kind,
          operationId: child.operationId,
          plan: child.plan,
          planDigest: child.planDigest,
        }
      : {
          scope: { repository: child.scope.repository, target: child.scope.target },
          specVersion: child.specVersion,
          snapshot: snapshotProjection(child.snapshot),
          tier: child.tier,
        },
  )
}

/** Current-state comparison ignores only descriptive observation timestamps. */
export function currentSnapshotProjection(snapshot: AssessSpecExact['proposed']['snapshot']) {
  return {
    spec: {
      format: snapshot.spec.format,
      criteria: snapshot.spec.criteria.map((item) => ({ id: item.id, statement: item.statement })),
      invariants: snapshot.spec.invariants.map((item) => ({ id: item.id, statement: item.statement })),
      exclusions: [...snapshot.spec.exclusions],
      openQuestions: [...snapshot.spec.openQuestions],
      sections: { ...snapshot.spec.sections },
      version: snapshot.spec.version,
    },
    raw: {
      reference: snapshot.raw.reference,
      body: snapshot.raw.body,
      bodySha256: snapshot.raw.bodySha256,
    },
  }
}

export function currentChildrenProjection(children: AssessSpecExact['proposed']['children']) {
  return children.map((child) =>
    'kind' in child
      ? {
          kind: child.kind,
          operationId: child.operationId,
          plan: child.plan,
          planDigest: child.planDigest,
        }
      : {
          scope: { repository: child.scope.repository, target: child.scope.target },
          specVersion: child.specVersion,
          snapshot: currentSnapshotProjection(child.snapshot),
          tier: child.tier,
        },
  )
}
