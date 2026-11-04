import type {
  IssueRef,
  IssueWriter,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import {
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
  validateCauseDispositionRecords,
} from '../dist/contracts.js'
import type { CauseCreationProposal, CauseSisterInput } from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { diagnostic, home, issue } from './uw-cause-creation-support.ts'
import type { CauseOperationResult, PreparedUwProposal, UwRead, UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'

type ReceiptArgs = {
  input: { reader: UwReadPort; github: GitHubOptions }
  uw: Scope
  known: Scope
  mode: 'sister' | 'report-promotion'
  relation: 'original-blocked-by-sister' | 'sister-blocked-by-original'
  parentScope: Scope | null
  result: { value: UwRead }
  checked: { histories: readonly DecodedHistory[] }
  prepared: PreparedUwProposal
  proposal: CauseCreationProposal
  intent: { value: { recordId: string } }
  source: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  ref: CauseSisterInput['disposition']
  createdIssue: IssueRef
}

export async function attachBlockingSister(
  reader: UwReadPort,
  writer: IssueWriter,
  uw: Scope,
  known: Scope,
  createdIssue: IssueRef,
): Promise<CauseOperationResult | null> {
  const before = rootObservation(uw, await reader.readUw(uw))
  const plan: NativeIssueWritePlan = {
    repository: uw.repository,
    title: before.title,
    body: before.body,
    labels: { add: [], remove: [] },
    relations: { addChildren: [], removeChildren: [], addBlockers: [createdIssue], removeBlockers: [] },
  }
  const updated = await writer.update(issue(uw), plan, before)
  if (updated.status === 'written') return null
  return {
    status: 'partial',
    uw: known,
    diagnostics: updated.diagnostics.map((item) => diagnostic(known, item.code, item.message)),
  }
}

async function assertRelations(args: ReceiptArgs): Promise<void> {
  const { input, uw, known, mode, relation, parentScope, createdIssue } = args
  const originalAfter = rootObservation(uw, await input.reader.readUw(uw))
  const createdAfter = rootObservation(known, await input.reader.readUw(known))
  const has = (refs: readonly IssueRef[], target: IssueRef) =>
    refs.some((item) => item.repository === target.repository && item.number === target.number)
  const expectedParent = parentScope === null ? null : issue(parentScope)
  if (JSON.stringify(createdAfter.parent) !== JSON.stringify(expectedParent))
    throw new Error('cause-relation-unconfirmed')
  if (mode !== 'sister') return
  const linked =
    relation === 'original-blocked-by-sister'
      ? has(originalAfter.blockers, createdIssue)
      : has(createdAfter.blockers, issue(uw))
  if (!linked) throw new Error('cause-relation-unconfirmed')
}

export async function publishCauseReceipt(args: ReceiptArgs): Promise<CauseOperationResult> {
  const { input, uw, known, mode, relation, parentScope, result, checked, prepared, proposal, intent, source, ref } =
    args
  await assertRelations(args)
  if (!result.value.identity.ok || result.value.identity.value.head?.kind !== 'spec-identity')
    throw new Error('cause-identity-unconfirmed')
  const identity = { ...result.value.identity.value.head, kind: 'spec-identity' as const }
  const scopes = [...checked.histories.map((entry) => entry.source.scope), known]
  const unique = [...new Map(scopes.map((scope) => [`${scope.repository}\0${scope.target}`, scope])).values()]
  const reread = await readComposedWorkflowHistory(unique, input.github)
  if (!reread.ok) throw new Error('cause-receipt-history-unavailable')
  const identityRecord = bindExternalRef(identity, home(reread.histories, known))
  if (
    !identityRecord.ok ||
    identityRecord.value.kind !== 'spec-identity' ||
    identityRecord.value.payload.proposalDigest !== prepared.digest ||
    identityRecord.value.payload.confirmation.operationId !== proposal.operationId
  )
    throw new Error('cause-identity-unconfirmed')
  const operation = { scope: uw, recordId: intent.value.recordId, kind: 'cause-operation' as const }
  const receipt =
    mode === 'sister'
      ? buildRecord({
          ...uw,
          version: 1,
          kind: 'debt-receipt',
          recordId: `${proposal.operationId}:receipt`,
          runId: proposal.operationId,
          operationId: `${proposal.operationId}:receipt`,
          payload: {
            format: 'omp-build-debt-receipt/2',
            operation,
            disposition: ref,
            decision:
              source.payload.subject.kind === 'cause'
                ? source.payload.subject.decision
                : (() => {
                    throw new Error('cause-subject-not-runnable')
                  })(),
            causeId: source.payload.subject.kind === 'cause' ? source.payload.subject.cause.id : '',
            original: uw,
            sister: known,
            parent: parentScope,
            relation,
            identity,
          },
        })
      : buildRecord({
          ...uw,
          version: 1,
          kind: 'report-promotion',
          recordId: `${proposal.operationId}:receipt`,
          runId: proposal.operationId,
          operationId: `${proposal.operationId}:receipt`,
          payload: { format: 'omp-build-report-promotion/1', report: ref, operation, created: known, identity },
        })
  if (!receipt.ok)
    return {
      status: 'partial',
      uw: known,
      diagnostics: receipt.diagnostics.map((item) => diagnostic(known as Scope, item.code, item.message)),
    }
  const records = reread.histories.flatMap((history) =>
    history.operations.flatMap((entry) =>
      entry.status === 'complete' && entry.authority !== 'foreign' && entry.record !== null ? [entry.record] : [],
    ),
  )
  const invalid = validateCauseDispositionRecords({
    records: [...records, receipt.value],
    histories: reread.histories,
  })
  if (invalid.length)
    return {
      status: 'partial',
      uw: known,
      diagnostics: invalid.map((item) => diagnostic(known as Scope, item.code, item.message)),
    }
  const receiptHome = home(reread.histories, uw)
  const written = await publishConfirmedWorkflowRecord(
    receipt.value,
    receiptHome,
    input.github,
    null,
    reread.histories.filter((entry) => entry !== receiptHome),
  )
  if (written.status !== 'confirmed')
    return {
      status: 'partial',
      uw: known,
      diagnostics: written.diagnostics.map((item) => diagnostic(known as Scope, item.code, item.message)),
    }
  return {
    status: 'created',
    value: result.value,
    receipt: { scope: uw, recordId: receipt.value.recordId, kind: receipt.value.kind },
  }
}
