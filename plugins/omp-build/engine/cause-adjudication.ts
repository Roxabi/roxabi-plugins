import { createHash } from 'node:crypto'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { resolveAdjudicationSources } from './cause-adjudication-sources.ts'
import type { CauseAdjudicationProposal } from './cause-disposition-schema.ts'
import { observationRefDiagnostics } from './delivery-observation-authentication.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerSourceDiagnostics } from './observation-input-authentication.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type AdjudicationInput = {
  proposal: CauseAdjudicationProposal
  pending: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  histories: readonly DecodedHistory[]
  context: CauseContext
}

function validatePriorSuccessors(input: AdjudicationInput): Diagnostic[] {
  const { proposal, pending, histories } = input
  const diagnostics: Diagnostic[] = []
  const originHistory = histories.find((history) => equalScope(history.source.scope, proposal.pending.scope))
  const originBinding = originHistory && bindExternalRef(proposal.pending, originHistory)
  if (!originBinding?.ok || JSON.stringify(originBinding.value) !== JSON.stringify(pending))
    diagnostics.push(diagnostic('cause-adjudication-unconfirmed', 'Pending disposition is not authenticated'))
  if (!originHistory) return diagnostics
  const records = recordsOf(originHistory)
  const competing = records.filter(
    (record) =>
      record.kind === 'cause-operation' &&
      record.payload.proposal.operation === 'adjudicate-cause' &&
      sameRef(record.payload.proposal.pending, proposal.pending) &&
      (record.payload.proposal.operationId !== proposal.operationId ||
        canonicalValueDigest(record.payload.proposal) !== canonicalValueDigest(proposal)),
  )
  if (competing.length)
    diagnostics.push(diagnostic('cause-adjudication-ambiguous', 'Pending disposition has competing intents'))
  const successors = records.filter(
    (record) =>
      record.kind === 'cause-disposition' &&
      record.payload.previous !== null &&
      sameRef(record.payload.previous, proposal.pending),
  )
  for (const successor of successors) {
    if (successor.kind !== 'cause-disposition') continue
    const operation = records.find(
      (record) => record.kind === 'cause-operation' && record.recordId === successor.payload.adjudication?.recordId,
    )
    if (
      operation?.kind !== 'cause-operation' ||
      operation.payload.proposal.operationId !== proposal.operationId ||
      canonicalValueDigest(operation.payload.proposal) !== canonicalValueDigest(proposal)
    )
      diagnostics.push(diagnostic('cause-adjudication-stale', 'Pending disposition already has a successor'))
  }
  if (successors.length > 1)
    diagnostics.push(diagnostic('cause-adjudication-ambiguous', 'Pending disposition has competing successors'))
  return diagnostics
}

function validatePendingMembers(input: AdjudicationInput): Diagnostic[] {
  const { proposal, pending } = input
  const diagnostics: Diagnostic[] = []
  if (
    !equalScope(proposal.uw, pending) ||
    !sameRef(proposal.pending, { scope: proposal.uw, kind: 'cause-disposition', recordId: pending.recordId }) ||
    pending.payload.outcome.state !== 'pending-blocking'
  )
    diagnostics.push(
      diagnostic('cause-adjudication-pending-mismatch', 'Adjudication must name the exact pending disposition'),
    )
  if (proposal.pendingDigest !== createHash('sha256').update(JSON.stringify(pending)).digest('hex'))
    diagnostics.push(diagnostic('cause-adjudication-pending-mismatch', 'Pending disposition digest changed'))
  const subject = pending.payload.subject
  if (subject.kind === 'rule-error') {
    if (proposal.rejectedFindingIds.length !== 0 || proposal.judgment !== null)
      diagnostics.push(
        diagnostic('cause-adjudication-membership', 'Rule error resolution cannot reject findings or replace judgment'),
      )
  } else if (subject.kind === 'retained-finding') {
    if (
      proposal.rejectedFindingIds.length !== 1 ||
      proposal.rejectedFindingIds[0] !== subject.finding.id ||
      proposal.judgment !== null
    )
      diagnostics.push(
        diagnostic(
          'cause-adjudication-membership',
          'Retained finding resolution must reject exactly its original finding',
        ),
      )
  } else {
    const members = new Set(subject.findings.map((item) => item.id))
    if (
      proposal.rejectedFindingIds.some((id) => !members.has(id)) ||
      new Set(proposal.rejectedFindingIds).size !== proposal.rejectedFindingIds.length
    )
      diagnostics.push(
        diagnostic('cause-adjudication-membership', 'Rejected findings must be distinct members of the pending cause'),
      )
  }
  return diagnostics
}

function validateAdjudicationCitations(input: AdjudicationInput, actionInputs: readonly ActionInputs[]): Diagnostic[] {
  const { proposal, histories } = input
  const diagnostics: Diagnostic[] = []
  if (
    proposal.reason.trim() === '' ||
    (input.pending.payload.subject.kind === 'cause' &&
      proposal.rejectedFindingIds.length === 0 &&
      proposal.judgment === null) ||
    proposal.references.length === 0
  )
    diagnostics.push(
      diagnostic(
        'cause-adjudication-motivation',
        'Adjudication requires a reason, cited evidence and a rejection or replacement judgment',
      ),
    )
  if (new Set(proposal.references.map(canonicalValueDigest)).size !== proposal.references.length)
    diagnostics.push(diagnostic('duplicate-reference', 'Adjudication citations must be distinct'))
  const pins = actionInputs.flatMap((entry) => [
    ...entry.manifest.repositoryReferences,
    ...entry.manifest.plugin.files,
    ...entry.manifest.expandedContext.filter((item) => item.source === 'git-file'),
  ])
  for (const ref of proposal.references) {
    if (
      input.pending.payload.subject.kind === 'cause' &&
      !actionInputs.some((entry) => producerSourceDiagnostics('adjudication', [ref], entry).length === 0)
    )
      diagnostics.push(
        diagnostic('unknown-reference', 'Adjudication cites evidence outside its producing action inputs'),
      )
    diagnostics.push(...observationRefDiagnostics('adjudication', ref, histories, pins))
  }
  return diagnostics
}

export function validateCauseAdjudication(input: AdjudicationInput): Diagnostic[] {
  const source = resolveAdjudicationSources(input)
  return [
    ...validatePriorSuccessors(input),
    ...(source.ok ? [] : source.diagnostics),
    ...validatePendingMembers(input),
    ...validateAdjudicationCitations(input, source.ok ? source.value : []),
  ]
}
export function resolveCauseActionInputs(input: {
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  history: DecodedHistory
  context: CauseContext
}): Result<ActionInputs[]> {
  const scope = { repository: input.decision.repository, target: input.decision.target }
  const decision = bindExternalRef({ scope, recordId: input.decision.recordId, kind: 'decision' }, input.history)
  if (!decision.ok || canonicalValueDigest(decision.value) !== canonicalValueDigest(input.decision))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'The immutable decision is not authenticated')],
    }
  const sourceResult = bindExternalRef(
    { scope, recordId: input.decision.payload.originalContributionId, kind: 'contribution' },
    input.history,
  )
  if (!sourceResult.ok || sourceResult.value.kind !== 'contribution')
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'Synthesis contribution is not authenticated')],
    }
  const source = sourceResult.value
  if (
    source.payload.content !== 'decision' ||
    source.payload.inventoryId === null ||
    !input.decision.inputs.includes(source.recordId) ||
    canonicalValueDigest(source.payload.structured) !== canonicalValueDigest(input.decision.payload.judgment)
  )
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'Decision does not bind its captured synthesis')],
    }
  const final = source.payload.rawAttempts.reduce<(typeof source.payload.rawAttempts)[number] | null>(
    (last, item) => (last === null || item.attemptIndex > last.attemptIndex ? item : last),
    null,
  )
  if (final === null || canonicalValueDigest(final.data) !== canonicalValueDigest(input.decision.payload.judgment))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'Decision differs from its final synthesis submission')],
    }
  const inventoryResult = bindExternalRef(
    { scope, recordId: source.payload.inventoryId, kind: 'review-attempt' },
    input.history,
  )
  if (!inventoryResult.ok || inventoryResult.value.kind !== 'review-attempt')
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'Synthesis inventory is not authenticated')],
    }
  const inventory = inventoryResult.value
  const slots = inventory.payload.slots.filter(
    (slot) =>
      slot.slotId === source.payload.host.slotId &&
      slot.phase === source.payload.host.phase &&
      slot.role === source.payload.host.role,
  )
  const slot = slots[0]
  if (
    slots.length !== 1 ||
    !slot?.action ||
    inventory.payload.stage !== 'synthesis' ||
    !source.inputs.includes(inventory.recordId) ||
    source.payload.host.origin !== 'native' ||
    source.payload.host.childId === null ||
    source.payload.host.chunk !== slot.chunk ||
    source.payload.native?.completion !== 'completed' ||
    source.payload.native.strict !== 'valid'
  )
    return {
      ok: false,
      diagnostics: [diagnostic('cause-context-unbound', 'Synthesis action slot is not bound to the contribution')],
    }
  const inputs = slot.action.inputs
  if (
    inventory.payload.actionInputDigest !== inputs.fingerprint ||
    inputs.manifest.code.head !== inventory.payload.candidateGitSHA ||
    (source.payload.host.action &&
      canonicalValueDigest(source.payload.host.action) !== canonicalValueDigest(slot.action)) ||
    !validateActionInputs(inputs).ok ||
    inputs.manifest.spec.kind !== 'accepted' ||
    !sameOwnSpecRef(inputs.manifest.spec.effective.own, input.context.effective.own) ||
    canonicalValueDigest(inputs.manifest.spec.effective) !== canonicalValueDigest(input.context.effective)
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('cause-context-unbound', 'Authenticated synthesis action does not select the exact accepted Spec'),
      ],
    }
  return { ok: true, value: [inputs] }
}
