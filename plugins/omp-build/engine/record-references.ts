import { z } from 'zod'
import type { CanonicalRecord, Kind } from './record-schema.ts'
import { type Diagnostic, identifierSchema, repoRelativePathSchema, scopeSchema } from './record-values.ts'
import { diagnostic, equalScope } from './result.ts'
import type { MandatePayload, OperatorControlPayload, WorkflowBindingPayload } from './workflow-mandate-schema.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

export const KIND_NAMES = [
  'review-attempt',
  'contribution',
  'decision',
  'review',
  'fix-request',
  'fix-result',
  'correction-result',
  'falsification-result',
  'debt-receipt',
  'proof',
  'stop',
  'epic-event',
  'mandate',
  'operator-control',
  'action-receipt',
  'workflow-binding',
] as const
export const kindSchema = z.enum(KIND_NAMES)
export const WORKFLOW_RECORD_KINDS = ['mandate', 'operator-control', 'action-receipt', 'workflow-binding'] as const
export type WorkflowRecordKind = (typeof WORKFLOW_RECORD_KINDS)[number]

export function isWorkflowKind(kind: string): kind is WorkflowRecordKind {
  return (WORKFLOW_RECORD_KINDS as readonly string[]).includes(kind)
}

export function stopBotMayAuthor(claimedKinds: readonly string[]): boolean {
  return claimedKinds.length > 0 && claimedKinds.every((kind) => kind === 'stop')
}

export const externalRecordRefSchema = z.strictObject({
  scope: scopeSchema,
  recordId: identifierSchema,
  kind: kindSchema,
})
export type ExternalRecordRef = z.infer<typeof externalRecordRefSchema>
export const scopedRecordRefSchema = externalRecordRefSchema
export type ScopedRecordRef = ExternalRecordRef

export const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$/)
const proofPinPathSchema = repoRelativePathSchema.refine(
  (path) => !path.includes('://'),
  'proof pin path must be a relative git path',
)

export const proofConfigPinSchema = z.strictObject({
  sourceCommit: gitObjectIdSchema,
  path: proofPinPathSchema,
  blob: gitObjectIdSchema.nullable(),
})
export type ProofConfigPin = z.infer<typeof proofConfigPinSchema>
export function scopedRefsOf(record: { kind: Kind; payload: unknown }): ExternalRecordRef[] {
  switch (record.kind) {
    case 'mandate': {
      const payload = record.payload as MandatePayload
      return [payload.parent, payload.antecedent].filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'operator-control': {
      const payload = record.payload as OperatorControlPayload
      const refs: Array<ExternalRecordRef | null> = [payload.mandate, payload.predecessor]
      if (payload.control === 'accept-material') refs.push(payload.assessment)
      if (payload.control === 'select-successor') refs.push(payload.successor)
      return refs.filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'action-receipt': {
      const payload = record.payload as ActionReceiptPayload
      const refs = [payload.mandate]
      if (payload.phase === 'result') refs.push(payload.start)
      return refs
    }
    case 'workflow-binding':
      return [(record.payload as WorkflowBindingPayload).mandate]
    default:
      return []
  }
}

export function partitionScopedRefs(record: Pick<CanonicalRecord, 'kind' | 'payload' | 'repository' | 'target'>): {
  sameScope: ExternalRecordRef[]
  external: ExternalRecordRef[]
} {
  const scope = { repository: record.repository, target: record.target }
  const refs = scopedRefsOf(record)
  return {
    sameScope: refs.filter((ref) => equalScope(ref.scope, scope)),
    external: refs.filter((ref) => !equalScope(ref.scope, scope)),
  }
}

export function workflowInputMeaning(record: CanonicalRecord): Diagnostic | null {
  if (!isWorkflowKind(record.kind)) return null
  const { sameScope, external } = partitionScopedRefs(record)
  for (const ref of sameScope) {
    if (!record.inputs.includes(ref.recordId))
      return diagnostic('unbound', `Same-scope reference ${ref.recordId} is missing from inputs`)
  }
  for (const ref of external) {
    if (record.inputs.includes(ref.recordId) || sameScope.some((item) => item.recordId === ref.recordId))
      return diagnostic('ambiguous', `External reference ${ref.recordId} must not be an input`)
  }
  return null
}
