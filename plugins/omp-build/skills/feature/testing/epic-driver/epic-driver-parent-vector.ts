import type { MandateRecord } from '../../../../engine/workflow-control.ts'

/** Inherit an initial parent mandate's own Spec and its complete inherited vector. */
export function inheritedParentSpecs(parent: MandateRecord) {
  return [
    {
      uw: parent.payload.ownSpec.uw,
      version: parent.payload.ownSpec.version,
      sourceAccepted: {
        scope: { repository: parent.repository, target: parent.target },
        recordId: parent.recordId,
        kind: 'mandate' as const,
      },
    },
    ...parent.payload.inheritedOwnSpecRefs,
  ]
}
