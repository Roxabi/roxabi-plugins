import { z } from 'zod'
import { identifierSchema, scopeSchema } from './record-values.ts'

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
  'stop',
  'epic-event',
  'spec-identity',
  'mandate',
  'operator-control',
  'action-receipt',
  'workflow-binding',
] as const
export const kindSchema = z.enum(KIND_NAMES)
export const WORKFLOW_RECORD_KINDS = [
  'spec-identity',
  'mandate',
  'operator-control',
  'action-receipt',
  'workflow-binding',
] as const
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
