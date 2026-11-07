import type {
  IssueRef,
  IssueWriter,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import {
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  isRetainedReportPublication,
  publishConfirmedWorkflowRecord,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
  validateCausePublication,
  validateRetainedReportPublication,
} from '../dist/contracts.js'
import type { CauseCreationProposal, CauseSisterInput } from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { defaultGh } from './feature-engine.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { diagnostic, home, issue } from './uw-cause-creation-support.ts'
import type { CauseOperationResult, CreatedUwRead, CreatedUwReadPort, PreparedUwProposal } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'

type ReceiptArgs = {
  input: { reader: CreatedUwReadPort; github: GitHubOptions }
  uw: Scope
  known: Scope
  mode: 'sister' | 'report-promotion'
  relation: 'original-blocked-by-sister' | 'sister-blocked-by-original'
  parentScope: Scope | null
  result: { value: CreatedUwRead }
  checked: { histories: readonly DecodedHistory[] }
  prepared: PreparedUwProposal
  proposal: CauseCreationProposal
  intent: { value: { recordId: string } }
  source: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  ref: CauseSisterInput['disposition']
  createdIssue: IssueRef
}

export async function attachBlockingSister(
  reader: CreatedUwReadPort,
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

function buildCauseReceipt(args: ReceiptArgs, identity: { scope: Scope; recordId: string; kind: 'spec-identity' }) {
  const { uw, known, mode, relation, parentScope, proposal, intent, source, ref } = args
  const operation = { scope: uw, recordId: intent.value.recordId, kind: 'cause-operation' as const }
  if (mode !== 'sister') {
    return buildRecord({
      ...uw,
      version: 1,
      kind: 'report-promotion',
      recordId: `${proposal.operationId}:receipt`,
      runId: proposal.operationId,
      operationId: `${proposal.operationId}:receipt`,
      payload: { format: 'omp-build-report-promotion/1', report: ref, operation, created: known, identity },
    })
  }
  const subject = source.payload.subject
  if (subject.kind !== 'cause') throw new Error('cause-subject-not-runnable')
  return buildRecord({
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
      decision: subject.decision,
      causeId: subject.cause.id,
      original: uw,
      sister: known,
      parent: parentScope,
      relation,
      identity,
    },
  })
}

function assertReceiptIdentity(
  identity: { scope: Scope; recordId: string; kind: 'spec-identity' },
  histories: readonly DecodedHistory[],
  args: ReceiptArgs,
): void {
  const identityRecord = bindExternalRef(identity, home(histories, args.known))
  if (
    !identityRecord.ok ||
    identityRecord.value.kind !== 'spec-identity' ||
    identityRecord.value.payload.proposalDigest !== args.prepared.digest ||
    identityRecord.value.payload.confirmation.operationId !== args.proposal.operationId
  )
    throw new Error('cause-identity-unconfirmed')
}

export async function publishCauseReceipt(args: ReceiptArgs): Promise<CauseOperationResult> {
  const { input, uw, known, result, checked } = args
  await assertRelations(args)
  if (!result.value.identity.ok || result.value.identity.value.head?.kind !== 'spec-identity')
    throw new Error('cause-identity-unconfirmed')
  const identity = { ...result.value.identity.value.head, kind: 'spec-identity' as const }
  const scopes = [
    ...checked.histories.map((entry) => entry.source.scope),
    known,
    ...(args.parentScope === null ? [] : [args.parentScope]),
  ]
  const unique = [...new Map(scopes.map((scope) => [`${scope.repository}\0${scope.target}`, scope])).values()]
  const reread = await readComposedWorkflowHistory(unique, input.github)
  if (!reread.ok) throw new Error('cause-receipt-history-unavailable')
  assertReceiptIdentity(identity, reread.histories, args)
  const receipt = buildCauseReceipt(args, identity)
  if (!receipt.ok)
    return {
      status: 'partial',
      uw: known,
      diagnostics: receipt.diagnostics.map((item) => diagnostic(known, item.code, item.message)),
    }
  const retained = isRetainedReportPublication(receipt.value)
  const closure = retained
    ? { ok: true as const, histories: reread.histories }
    : await readCauseHistoryClosure(reread.histories, (needed) => readComposedWorkflowHistory(needed, input.github))
  if (!closure.ok) throw new Error(closure.diagnostics.map((item) => item.code).join(','))
  const histories = closure.histories
  const receiptHome = home(histories, uw)
  const evidence = {
    record: receipt.value,
    history: receiptHome,
    externalHistories: histories.filter((entry) => entry !== receiptHome),
  }
  const invalid = retained
    ? validateRetainedReportPublication(evidence)
    : validateCausePublication({
        ...evidence,
        catalogues: await loadReviewClassCatalogues({
          histories,
          cwd: input.github.cwd,
          gh: input.github.gh ?? defaultGh(),
        }),
      })
  if (invalid.length)
    return {
      status: 'partial',
      uw: known,
      diagnostics: invalid.map((item) => diagnostic(known, item.code, item.message)),
    }
  const written = await publishConfirmedWorkflowRecord(
    receipt.value,
    input.github,
    createPublicationContextResolver(input.github, null),
    histories.filter((entry) => entry !== receiptHome),
  )
  if (written.status !== 'confirmed')
    return {
      status: 'partial',
      uw: known,
      diagnostics: written.diagnostics.map((item) => diagnostic(known, item.code, item.message)),
    }
  const confirmed = await readComposedWorkflowHistory(unique, input.github)
  if (!confirmed.ok) throw new Error('cause-receipt-readback-unavailable')
  const confirmedReceipt = bindExternalRef(
    { scope: uw, recordId: receipt.value.recordId, kind: receipt.value.kind },
    home(confirmed.histories, uw),
  )
  if (!confirmedReceipt.ok || JSON.stringify(confirmedReceipt.value) !== JSON.stringify(receipt.value))
    throw new Error('cause-receipt-readback-unconfirmed')
  return {
    status: 'created',
    value: result.value,
    receipt: { scope: uw, recordId: receipt.value.recordId, kind: receipt.value.kind },
  }
}
