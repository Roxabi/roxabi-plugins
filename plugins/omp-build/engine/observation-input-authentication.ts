import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { ObservationRef } from './criterion-evidence-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'

export function producerSourceDiagnostics(
  evidenceId: string,
  references: readonly ObservationRef[],
  inputs: ActionInputs,
): Diagnostic[] {
  const sourceRefs: ObservationRef[] = [
    ...inputs.manifest.repositoryReferences,
    ...inputs.manifest.plugin.files,
    ...inputs.manifest.expandedContext,
    ...inputs.manifest.acceptedSources,
    ...inputs.manifest.deliveryData.map(({ role: _role, ...ref }) => ref),
    ...inputs.stageSources,
  ]
  const sourceDigests = new Set(sourceRefs.map((ref) => canonicalValueDigest(ref)))
  return references.flatMap((ref) =>
    sourceDigests.has(canonicalValueDigest(ref))
      ? []
      : [
          diagnostic(
            'unknown-reference',
            `Evidence ${evidenceId} cites a source absent from the producing action inputs`,
          ),
        ],
  )
}
