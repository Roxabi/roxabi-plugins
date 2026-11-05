import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { createWorkflowFixtures } from './workflow-fixtures.ts'

export function defaultEpicInputs(scope: Scope, range: string): ActionInputs {
  const fixtures = createWorkflowFixtures({
    productVersion: '0.13.0',
    config: {
      version: 'omp-build-workflow/1',
      digest: 'a'.repeat(64),
      effective: {
        graph: {
          version: 1,
          productVersion: '0.13.0',
          configVersion: 'omp-build-workflow/1',
          edgeOrder: 'array',
          nodes: [{ id: 'stop', action: 'stop' }],
          edges: [],
          initial: 'stop',
        },
      },
    },
    head: null,
    editedAt: '2026-10-21T00:00:00Z',
  })
  const mandate = fixtures.epicMandate(scope, [])
  const inputs = acceptedActionInputs(mandate, 'review')
  const [base, head] = range.split('..')
  const manifest = {
    ...inputs.manifest,
    code: { ...inputs.manifest.code, repository: scope.repository, base, head },
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope, recordId: mandate.recordId, kind: mandate.kind },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}
