import type { IssueRef, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import type { CauseCreationProposal, CauseSisterInput } from '../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import { type Commit, diagnostic, issue } from './uw-cause-creation-support.ts'
import { causeEffectGuard } from './uw-cause-effect-guard.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type { confirmCauseIntent } from './uw-cause-intent.ts'
import { acceptCreatedCauseChild } from './uw-cause-parent-acceptance.ts'
import { attachBlockingSister, publishCauseReceipt } from './uw-cause-receipt.ts'
import { composedCauseEffectGuard } from './uw-composed-cause-guard.ts'
import type {
  CauseOperationResult,
  CreatedUwReadPort,
  PreparedUwProposal,
  UwCreateInput,
  UwReadPort,
} from './uw-contract.ts'

type ConfirmedIntent = Extract<Awaited<ReturnType<typeof confirmCauseIntent>>, { ok: true }>

type CommitArgs = {
  input: {
    reader: UwReadPort
    nativeReader: CreatedUwReadPort
    github: GitHubOptions
    commit: Commit
    guardedWriter: (guard: CauseEffectGuard, composedParent: IssueRef | null) => IssueWriter
  }
  confirmedIntent: ConfirmedIntent
  confirmation: OperatorConfirmationEvidence
  mode: 'sister' | 'report-promotion'
  ref: CauseSisterInput['disposition']
  source: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  originalDigest: string
  parentScope: Scope | null
  createInput: UwCreateInput
  relation: 'original-blocked-by-sister' | 'sister-blocked-by-original'
  proposal: CauseCreationProposal
  prepared: PreparedUwProposal
  parentAcceptance?: {
    prepared: PreparedMaterialAcceptance
    before: Extract<UwCompletionObservation, { status: 'complete' }>
    signal: AbortSignal
  }
  markKnown: (scope: Scope) => void
}

function composedConsentParent(args: CommitArgs): IssueRef | null {
  if (args.parentAcceptance === undefined) return null
  const authenticated = args.confirmedIntent.intent.value.payload.proposal
  if (authenticated.operation !== 'create' || authenticated.parentAcceptance === null)
    throw new Error('composed-parent-consent-missing')
  const consentParent = authenticated.parentAcceptance.parent
  const retainedParent = args.parentAcceptance.prepared.proposal.uw
  const plannedParent = authenticated.writes.relations.parent
  const consentIssue = issue(consentParent)
  if (
    plannedParent == null ||
    plannedParent.repository !== consentIssue.repository ||
    plannedParent.number !== consentIssue.number ||
    retainedParent.repository !== consentParent.repository ||
    retainedParent.target !== consentParent.target ||
    args.parentScope === null ||
    args.parentScope.repository !== consentParent.repository ||
    args.parentScope.target !== consentParent.target
  )
    throw new Error('composed-parent-consent-mismatch')
  return consentIssue
}

/** Execute the guarded create and prove its relations and receipt after confirmed intent readback. */
export async function commitConfirmedCause(args: CommitArgs): Promise<CauseOperationResult> {
  const {
    input,
    confirmedIntent,
    confirmation,
    mode,
    ref,
    source,
    originalDigest,
    parentScope,
    createInput,
    relation,
    proposal,
    prepared,
    markKnown,
  } = args
  const uw = ref.scope
  const { checked, intent, parent } = confirmedIntent
  const guard =
    args.parentAcceptance === undefined
      ? causeEffectGuard({ reader: input.nativeReader, github: input.github }, parent, parentScope, uw, originalDigest)
      : composedCauseEffectGuard({
          github: input.github,
          before: args.parentAcceptance.before,
          intent: intent.value,
          signal: args.parentAcceptance.signal,
        })
  const composedParent = composedConsentParent(args)
  const writer = input.guardedWriter(guard, composedParent)
  const result = await input.commit(
    createInput,
    prepared,
    confirmation,
    writer,
    args.parentAcceptance === undefined ? undefined : guard,
  )
  if (result.status === 'uncertain' || result.status === 'partial') return result
  if (result.status !== 'created')
    return {
      status: 'partial',
      uw,
      diagnostics: result.status === 'refused' ? result.diagnostics : [diagnostic(uw, 'cause-create-unconfirmed')],
    }
  const known = result.value.uw
  markKnown(known)
  const createdIssue = issue(known)
  if (mode === 'sister' && relation === 'original-blocked-by-sister') {
    const partial = await attachBlockingSister(input.nativeReader, writer, uw, known, createdIssue)
    if (partial !== null) return partial
  }
  if (args.parentAcceptance !== undefined) {
    await acceptCreatedCauseChild({
      github: input.github,
      prepared: args.parentAcceptance.prepared,
      before: args.parentAcceptance.before,
      createOperationId: proposal.operationId,
      operation: { scope: uw, recordId: intent.value.recordId, kind: 'cause-operation' },
      signal: args.parentAcceptance.signal,
      child: result.value,
    })
    if (args.parentAcceptance.signal.aborted) throw new Error('composed-cause-cancelled')
  }
  return publishCauseReceipt({
    input: { reader: input.nativeReader, github: input.github },
    uw,
    known,
    mode,
    relation,
    parentScope,
    result,
    checked,
    prepared,
    proposal,
    intent,
    source,
    ref,
    createdIssue,
  })
}
