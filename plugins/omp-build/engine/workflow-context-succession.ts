import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { resolveAcceptedSpecAt } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { ContextSuccessionProposal } from './workflow-context-disposition-schema.ts'
import { validateContextEffectReview } from './workflow-context-effects.ts'
import { authenticateSuccessionAuthority } from './workflow-context-succession-authority.ts'
import { authenticateSuccessionBaseline } from './workflow-context-succession-baseline.ts'
import {
  createHistoricalAcceptedSpecContext,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecPriorStarts,
} from './workflow-context-succession-inspection.ts'
import { qualifyContextNegative } from './workflow-context-succession-negative.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import {
  bindExternalRef,
  type ControlRecord,
  historyFor,
  type MandateRecord,
  type ReceiptRecord,
  recordsOf,
} from './workflow-control.ts'

export { admitContextSuccession } from './workflow-context-succession-admit.ts'

const refuse = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
const same = (left: unknown, right: unknown) => canonicalValueDigest(left) === canonicalValueDigest(right)

export type ContextSuccessionAdmission = {
  control: ControlRecord
  predecessor: MandateRecord
  successor: MandateRecord
  negativeLeaf: ReceiptRecord
  replacementAccepted: AcceptedOwnSpec
  disposedStartKeys: ReadonlySet<string>
  baselineCode: ContextSuccessionCode
}
type ContextSuccessionCode = Extract<
  ReceiptRecord['payload'],
  { action: 'implement'; phase: 'result' }
>['inputs']['manifest']['code']

export function validateContextSuccessionProposal(
  proposal: ContextSuccessionProposal,
  successorPayload: MandateRecord['payload'],
  histories: readonly DecodedHistory[],
): Result<
  Pick<ContextSuccessionAdmission, 'negativeLeaf' | 'replacementAccepted' | 'disposedStartKeys' | 'baselineCode'>
> {
  const home = historyFor(proposal.predecessor.scope, histories)
  if (home === null) return refuse('Context succession predecessor history is missing')
  const bound = bindExternalRef(proposal.predecessor, home)
  if (!bound.ok || bound.value.kind !== 'mandate') return refuse('Context succession predecessor is unavailable')
  return prepareContextSuccession(
    proposal,
    bound.value,
    {
      ...proposal.successor.scope,
      recordId: proposal.successor.recordId,
      payload: successorPayload,
    },
    histories,
  )
}

/** Validate a prospective successor against authenticated history without publishing or inventing records. */
export function prepareContextSuccession(
  proposal: ContextSuccessionProposal,
  predecessor: MandateRecord,
  successor: Pick<MandateRecord, 'repository' | 'target' | 'recordId' | 'payload'>,
  histories: readonly DecodedHistory[],
  historical?: HistoricalAcceptedSpecContext,
): Result<
  Pick<ContextSuccessionAdmission, 'negativeLeaf' | 'replacementAccepted' | 'disposedStartKeys' | 'baselineCode'>
> {
  const authority = authenticateSuccessionAuthority(proposal, predecessor, successor, histories)
  if (!authority.ok) return authority
  const { home, capturedHome, capturedHistories, inCut } = authority.value
  const context =
    historical === undefined
      ? createHistoricalAcceptedSpecContext(capturedHistories)
      : { ok: true as const, value: historical }
  if (!context.ok) return context
  const qualified = qualifyContextNegative({
    mandate: predecessor,
    histories: capturedHistories,
    negative: proposal.negative,
    historical: context.value,
  })
  if (!qualified.ok) return refuse('Context succession negative is not authenticated under its predecessor')
  const negative = qualified.value.negativeLeaf
  if (negative.payload.phase !== 'result') return refuse('Context succession negative has no result')
  const action = negative.payload.action
  const priorStarts = historicalAcceptedSpecPriorStarts(context.value, qualified.value.histories, predecessor)
  if (!priorStarts.ok) return priorStarts
  if (!otherContextsClear(capturedHome, action, priorStarts.value))
    return refuse('Context succession has an unrelated context hold')
  const accepted = resolveAcceptedSpecAt(
    predecessor,
    qualified.value.histories,
    proposal.replacementAccepted,
    undefined,
    qualified.value.inspection,
    context.value,
  )
  if (
    !accepted.ok ||
    !sameOwnSpecRef(accepted.spec.ref, proposal.replacementAccepted) ||
    !sameOwnSpecRef(qualified.value.accepted.ref, accepted.spec.ref)
  )
    return refuse('Context succession replacement is not the latest authenticated accepted Spec')
  const spec = accepted.spec
  if (!carriesReplacement(successor, spec))
    return refuse('Successor does not carry the accepted replacement obligations')
  const effects = authenticateNegativeEffects(proposal, qualified.value.negativeChain, home, inCut)
  if (!effects.ok) return effects
  const priorCode = validateSuccessionChange(negative, predecessor, successor, spec)
  if (!priorCode.ok) return priorCode
  const code = priorCode.value
  const baseline = authenticateSuccessionBaseline(proposal, predecessor, successor, histories, spec, code)
  if (!baseline.ok) return baseline
  return {
    ok: true,
    value: {
      negativeLeaf: negative,
      replacementAccepted: spec,
      disposedStartKeys: qualified.value.negativeStartKeys,
      baselineCode: code,
    },
  }
}

function otherContextsClear(home: DecodedHistory, action: string, priorStarts: ReadonlySet<string>): boolean {
  for (const other of ['plan', 'plan-review', 'implement', 'integrate', 'assess-spec', 'attribute-ci'])
    if (other !== action && workflowContextTerminal(home, other, undefined, priorStarts) !== 'clear') return false
  return true
}

function carriesReplacement(
  successor: Pick<MandateRecord, 'repository' | 'target' | 'recordId' | 'payload'>,
  spec: AcceptedOwnSpec,
): boolean {
  return (
    same(successor.payload.ownSpec.snapshot, spec.snapshot) &&
    successor.payload.ownSpec.version === spec.ref.version &&
    equalScope(successor.payload.ownSpec.uw, spec.ref.uw) &&
    successor.payload.tier === spec.tier &&
    same(successor.payload.children, spec.children) &&
    same(successor.payload.inheritedOwnSpecRefs, spec.inheritedOwnSpecRefs) &&
    same(successor.payload.coverage, spec.coverage)
  )
}

function validateSuccessionChange(
  negative: ReceiptRecord,
  predecessor: MandateRecord,
  successor: Pick<MandateRecord, 'repository' | 'target' | 'recordId' | 'payload'>,
  spec: AcceptedOwnSpec,
): Result<ContextSuccessionCode> {
  const leaf = negative.payload
  if (
    (leaf.action !== 'implement' &&
      leaf.action !== 'plan' &&
      leaf.action !== 'plan-review' &&
      leaf.action !== 'assess-spec') ||
    leaf.phase !== 'result'
  )
    return refuse('Context succession leaf is not an admitted negative action')
  if (leaf.inputs.manifest.spec.kind !== 'accepted')
    return refuse('Context succession requires accepted historical inputs')
  const originalSource = leaf.inputs.manifest.spec.effective.own.sourceAccepted
  const originalIndex = spec.chain.findIndex((step) => sameRef(step.source, originalSource))
  const material =
    originalIndex >= 0 && spec.chain.slice(originalIndex + 1).some((step) => step.kind === 'accept-material')
  if (!material && same(predecessor.payload.config, successor.payload.config))
    return refuse('Context succession requires a material or product/configuration-version handoff')
  return { ok: true, value: leaf.inputs.manifest.code }
}

function authenticateNegativeEffects(
  proposal: ContextSuccessionProposal,
  chain: readonly ReceiptRecord[],
  home: DecodedHistory,
  inCut: (ref: ExternalRecordRef) => boolean,
): Result<void> {
  if (
    chain.some(
      (member) =>
        member.payload.phase !== 'result' ||
        !inCut({ scope: proposal.uw, kind: 'action-receipt', recordId: member.recordId }) ||
        !inCut(member.payload.start),
    )
  )
    return refuse('Context succession chain is outside its confirmed history cut')
  const chainIds = new Set(chain.map((record) => record.recordId))
  if (
    recordsOf(home).some(
      (record) =>
        record.kind === 'action-receipt' &&
        (record.payload.action === 'implement' || record.payload.action === 'integrate') &&
        record.payload.phase === 'result' &&
        sameRef(record.payload.mandate, proposal.predecessor) &&
        !chainIds.has(record.recordId),
    )
  )
    return refuse('Context succession has another unresolved or delivered effect')
  return validateContextEffectReview(chain, proposal.reconciliation.effectReview)
}
