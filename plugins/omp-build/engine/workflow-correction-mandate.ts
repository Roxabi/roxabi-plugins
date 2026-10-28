import { buildRecord } from './record-construction.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Json, Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { MandateRefusal } from './workflow-mandate.ts'
import type { MandatePayload } from './workflow-mandate-schema.ts'

export type FixMandateAssessment =
  | {
      status: 'applicable'
      mandate: MandateRecord
      acceptedSpec: AcceptedOwnSpec
      execution: { correct: true; landing: false }
    }
  | { status: 'refused'; reason: MandateRefusal; evidence: Diagnostic[] }

type FixOnlyOwnSpec = Extract<MandatePayload, { role: 'fix-only' }>['ownSpec']
type FixOnlyChildren = Extract<MandatePayload, { role: 'fix-only' }>['children']
type FixOnlyTier = Extract<MandatePayload, { role: 'fix-only' }>['tier']

export function buildFixOnlyMandate(draft: {
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  lineageHead: string | null
  productVersion: string
  ownSpec: FixOnlyOwnSpec
  tier: FixOnlyTier
  children: FixOnlyChildren
  config: { version: string; digest: string; effective: Json }
  parent: ExternalRecordRef | null
  antecedent: ExternalRecordRef | null
}): Result<MandateRecord> {
  if (draft.scope.repository !== draft.ownSpec.uw.repository || draft.scope.target !== draft.ownSpec.uw.target)
    return fail([diagnostic('fix-own-uw-required', 'Fix-only mandate must bind the real own UW Spec')])
  return buildRecord({
    kind: 'mandate',
    version: 1,
    repository: draft.scope.repository,
    target: draft.scope.target,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    payload: {
      role: 'fix-only',
      format: 'omp-build-mandate/3',
      branch: draft.branch,
      base: draft.base,
      lineageHead: draft.lineageHead,
      run: null,
      ownSpec: draft.ownSpec,
      tier: draft.tier,
      children: draft.children,
      permissions: { landing: false, correct: true },
      config: {
        productVersion: draft.productVersion,
        version: draft.config.version,
        digest: draft.config.digest,
        effective: draft.config.effective,
      },
      parent: draft.parent,
      antecedent: draft.antecedent,
    },
  })
}
