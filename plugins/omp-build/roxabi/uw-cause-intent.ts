import {
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  isRetainedReportPublication,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
  validateCausePublication,
  validateRetainedReportPublication,
} from '../dist/contracts.js'
import type { CauseCreationProposal, CauseSisterInput, CreationContext } from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import { checkDuplicate, diagnostic, exactNewIntent, hash, home, same } from './uw-cause-creation-support.ts'
import { assertCauseParentUnchanged, observeCauseParent } from './uw-cause-parent.ts'
import { type CauseRead, readAuthenticatedCause, readAuthenticatedReport } from './uw-cause-read.ts'
import { assertComposedBefore } from './uw-composed-cause-guard.ts'
import type { CauseOperationResult, CreatedUwReadPort, PreparedUwProposal, UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { createParentEngagementReadPort } from './uw-parent-engagement.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

type Parent = NonNullable<Extract<CreationContext, { kind: 'sister' }>['parentObservation']>
type Intent = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Args = {
  input: { reader: UwReadPort; nativeReader: CreatedUwReadPort; github: GitHubOptions }
  mode: 'sister' | 'report-promotion'
  ref: CauseSisterInput['disposition']
  source: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  originalDigest: string
  parent: Parent | null
  proposal: CauseCreationProposal
  prepared: PreparedUwProposal
  confirmation: OperatorConfirmationEvidence
  composed?: { before: Extract<UwCompletionObservation, { status: 'complete' }>; signal: AbortSignal }
  markEffect: () => void
}

async function readFresh(args: Args) {
  const { input, mode, ref, source, originalDigest, parent } = args
  const checked =
    mode === 'sister'
      ? await readAuthenticatedCause(ref, input.reader, input.github)
      : await readAuthenticatedReport(ref, input.github)
  const checkedSource = 'disposition' in checked ? checked.disposition : checked.record
  if (hash(checkedSource) !== hash(source)) throw new Error('cause-disposition-stale')
  const own = home(checked.histories, ref.scope)
  checkDuplicate(own, ref)
  if (
    nativeIssueObservationDigest(rootObservation(ref.scope, await input.nativeReader.readUw(ref.scope))) !==
    originalDigest
  )
    throw new Error('cause-original-stale')
  if (args.composed !== undefined && parent !== null && args.proposal.parentAcceptance !== null) {
    await assertComposedBefore({
      github: input.github,
      before: args.composed.before,
      parent: parent.parent,
      signal: args.composed.signal,
    })
  } else if (parent !== null) {
    await assertCauseParentUnchanged(parent, createParentEngagementReadPort(input.github), null)
  }
  return { checked, own }
}

function buildIntent(
  args: Args,
  checked: CauseRead | { record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>; histories: DecodedHistory[] },
) {
  const { ref, proposal, prepared, confirmation } = args
  const uw = ref.scope
  const intent = buildRecord({
    ...uw,
    version: 1,
    kind: 'cause-operation',
    recordId: `${proposal.operationId}:intent`,
    runId: proposal.operationId,
    operationId: `${proposal.operationId}:intent`,
    payload: { format: 'omp-build-cause-operation/1', proposal, proposalDigest: prepared.digest, confirmation },
  })
  if (!intent.ok)
    return {
      ok: false as const,
      diagnostics: intent.diagnostics.map((item) => diagnostic(uw, item.code, item.message)),
    }
  const histories = checked.histories
  const own = home(histories, uw)
  const evidence = {
    record: intent.value,
    history: own,
    externalHistories: histories.filter((history) => history !== own),
  }
  const errors = isRetainedReportPublication(intent.value)
    ? validateRetainedReportPublication(evidence)
    : 'disposition' in checked
      ? validateCausePublication({ ...evidence, catalogues: checked.catalogues })
      : [{ code: 'cause-operation-source-unconfirmed', message: 'Current cause evidence is required' }]
  if (errors.length)
    return { ok: false as const, diagnostics: errors.map((item) => diagnostic(uw, item.code, item.message)) }
  return { ok: true as const, value: intent.value }
}

async function persistIntent(
  args: Args,
  intent: Intent,
  own: DecodedHistory,
  histories: readonly DecodedHistory[],
): Promise<CauseOperationResult | null> {
  const { input, ref, markEffect } = args
  const uw = ref.scope
  markEffect()
  const published = await publishConfirmedWorkflowRecord(
    intent,
    input.github,
    createPublicationContextResolver(input.github, null),
    histories.filter((history) => history !== own),
  )
  if (published.status !== 'confirmed')
    return {
      status: 'partial',
      uw,
      diagnostics: published.diagnostics.map((item) => diagnostic(uw, item.code, item.message)),
    }
  const confirmed = await readComposedWorkflowHistory(
    histories.map((history) => history.source.scope),
    input.github,
  )
  if (!confirmed.ok) throw new Error('cause-intent-history-unavailable')
  const confirmedHome = home(confirmed.histories, uw)
  const bound = bindExternalRef({ scope: uw, recordId: intent.recordId, kind: 'cause-operation' }, confirmedHome)
  if (!bound.ok || hash(bound.value) !== hash(intent) || !exactNewIntent(own, confirmedHome, intent.recordId))
    throw new Error('cause-intent-unconfirmed')
  return null
}

export async function confirmCauseIntent(args: Args) {
  const { checked, own } = await readFresh(args)
  const intent = buildIntent(args, checked)
  if (!intent.ok) return { ok: false as const, result: { status: 'refused' as const, diagnostics: intent.diagnostics } }
  const failure = await persistIntent(args, intent.value, own, checked.histories)
  if (failure !== null) return { ok: false as const, result: failure }
  let parent = args.parent
  if (args.composed === undefined && parent !== null && same(parent.parent, args.ref.scope)) {
    const afterIntent = await observeCauseParent(args.ref.scope, createParentEngagementReadPort(args.input.github))
    if (afterIntent.state !== 'inactive' || afterIntent.nativeDigest !== parent.nativeDigest)
      throw new Error('cause-parent-stale')
    parent = afterIntent
  }
  return { ok: true as const, checked, intent, parent }
}
