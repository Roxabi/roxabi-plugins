import { createHash } from 'node:crypto'
import type { IssueRef, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { CreationContext } from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type { PreparedUwProposal, UwCreateInput, UwOperationResult } from './uw-contract.ts'
export type Prepare = (
  input: UwCreateInput,
  context: CreationContext,
) => PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] }
export type Commit = (
  input: UwCreateInput,
  prepared: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  writer: IssueWriter,
  composedGuard?: CauseEffectGuard,
) => Promise<UwOperationResult>
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const same = (a: Scope, b: Scope) => a.repository === b.repository && a.target === b.target
export function diagnostic(uw: Scope, code: string, message = code): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
export function issue(scope: Scope): IssueRef {
  const prefix = `${scope.repository}#`
  const number = scope.target.startsWith(prefix) ? Number(scope.target.slice(prefix.length)) : NaN
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('cause-invalid-issue')
  return { repository: scope.repository, number }
}
export function causeError(uw: Scope, error: unknown): UwDiagnostic[] {
  const message = error instanceof Error ? error.message : String(error)
  return [diagnostic(uw, /^[a-z][a-z0-9-]+$/.test(message) ? message : 'cause-source-unavailable', message)]
}
export function home(histories: readonly DecodedHistory[], scope: Scope): DecodedHistory {
  const found = histories.find((history) => same(history.source.scope, scope))
  if (!found) throw new Error('cause-history-missing')
  return found
}
function incompleteOperation(operation: DecodedHistory['operations'][number]): boolean {
  return (
    operation.authority !== 'foreign' &&
    (operation.kind === 'cause-operation' || operation.claimedKinds.includes('cause-operation')) &&
    (operation.status !== 'complete' || operation.record === null)
  )
}

export function checkDuplicate(history: DecodedHistory, ref: { scope: Scope; recordId: string }): void {
  for (const operation of history.operations) {
    if (incompleteOperation(operation)) throw new Error('cause-creation-incomplete')
    if (
      operation.authority === 'foreign' ||
      operation.status !== 'complete' ||
      operation.record?.kind !== 'cause-operation'
    )
      continue
    const proposal = operation.record.payload.proposal
    if (proposal.operation !== 'create') continue
    const source = proposal.creation.kind === 'sister' ? proposal.creation.disposition : proposal.creation.report
    if (same(source.scope, ref.scope) && source.recordId === ref.recordId) throw new Error('cause-creation-incomplete')
  }
}
export function exactNewIntent(before: DecodedHistory, after: DecodedHistory, recordId: string): boolean {
  const added = after.operations.filter(
    (operation) =>
      operation.recordId === recordId && operation.status === 'complete' && operation.authority !== 'foreign',
  )
  if (added.length !== 1 || added[0]?.record?.kind !== 'cause-operation') return false
  const old = after.operations.filter((operation) => operation.recordId !== recordId)
  if (JSON.stringify(old) !== JSON.stringify(before.operations)) return false
  const ids = new Set(added[0].parts.map((part) => part.nativeId))
  const restored = {
    ...after,
    operations: old,
    source: { ...after.source, comments: after.source.comments.filter((comment) => !ids.has(comment.nativeId)) },
  }
  return JSON.stringify(restored) === JSON.stringify(before)
}
