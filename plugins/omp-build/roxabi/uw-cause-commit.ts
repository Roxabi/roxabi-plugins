import type { IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import type { CauseCreationProposal, CauseSisterInput } from '../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import { type Commit, diagnostic, issue } from './uw-cause-creation-support.ts'
import { causeEffectGuard } from './uw-cause-effect-guard.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type { confirmCauseIntent } from './uw-cause-intent.ts'
import { attachBlockingSister, publishCauseReceipt } from './uw-cause-receipt.ts'
import type { CauseOperationResult, PreparedUwProposal, UwCreateInput, UwReadPort } from './uw-contract.ts'

type ConfirmedIntent = Extract<Awaited<ReturnType<typeof confirmCauseIntent>>, { ok: true }>

type CommitArgs = {
  input: {
    reader: UwReadPort
    github: GitHubOptions
    commit: Commit
    guardedWriter: (guard: CauseEffectGuard) => IssueWriter
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
  markKnown: (scope: Scope) => void
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
  const guard = causeEffectGuard(input, parent, parentScope, uw, originalDigest)
  const writer = input.guardedWriter(guard)
  const result = await input.commit(createInput, prepared, confirmation, writer)
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
    const partial = await attachBlockingSister(input.reader, writer, uw, known, createdIssue)
    if (partial !== null) return partial
  }
  return publishCauseReceipt({
    input,
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
