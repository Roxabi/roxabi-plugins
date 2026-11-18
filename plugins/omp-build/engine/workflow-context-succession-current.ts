import { z } from 'zod'
import { canonicalValueDigest } from './canonical-value.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import type { Result } from './result.ts'
import {
  type ContextSuccessionManagedBaseline,
  type ContextSuccessionProposal,
  contextSuccessionManagedBaselineSchema,
} from './workflow-context-disposition-schema.ts'
import { admitContextSuccession, type ContextSuccessionAdmission } from './workflow-context-succession.ts'
import { authenticatedChildAdvance } from './workflow-context-succession-child-advance.ts'
import { authenticateSuccessorDelivery } from './workflow-context-succession-effect.ts'
import {
  createHistoricalAcceptedSpecContext,
  historicalAcceptedSpecPriorStarts,
} from './workflow-context-succession-inspection.ts'
import { controlsOf, type MandateRecord, mandateScope } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { ContextSuccessionObservation, WorkflowFacts } from './workflow-reconstruction-types.ts'

const parentAdvanceSchema = z.strictObject({
  kind: z.literal('parent-child-advance'),
  control: externalRecordRefSchema,
  candidate: z.strictObject({
    kind: z.literal('parent'),
    repository: z.string().min(1),
    head: gitObjectIdSchema,
    clean: z.literal(true),
    remoteBase: gitObjectIdSchema,
  }),
  delivery: contextSuccessionManagedBaselineSchema.shape.delivery,
})

/** A disposition changes progression only when its selected successor and fresh native baseline still match. */
export function currentContextSuccession(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  facts: Pick<WorkflowFacts, 'contextSuccessionObservation'> | null,
): Result<ReadonlySet<string>> {
  const observed = facts?.contextSuccessionObservation
  if (observed === undefined) return { ok: true, value: new Set() }
  const fail = currentSuccessionFailure
  if (observed === null || typeof observed !== 'object') return fail()
  if (!externalRecordRefSchema.safeParse(observed.control).success) return fail()
  if (observed.control.kind !== 'operator-control' || !equalScope(observed.control.scope, mandateScope(mandate)))
    return fail()
  const matches = controlsOf(evidence.issue).filter((control) => control.recordId === observed.control.recordId)
  const control = matches[0]
  if (
    matches.length !== 1 ||
    control === undefined ||
    control.payload.control !== 'select-successor' ||
    control.payload.contextDisposition === undefined ||
    !sameRef(control.payload.successor, { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId })
  )
    return fail()
  const admission = admitContextSuccession(control, evidence.causal.histories)
  if (!admission.ok) return admission
  return reconcileCurrentObservation(
    evidence,
    mandate,
    admission.value,
    observed,
    control.payload.contextDisposition.reconciliation,
  )
}

function currentSuccessionFailure(): Result<never> {
  return {
    ok: false,
    diagnostics: [diagnostic('unconfirmed', 'Current context succession baseline is not authenticated')],
  }
}

function reconcileCurrentObservation(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  admission: ContextSuccessionAdmission,
  observed: ContextSuccessionObservation,
  expected: ContextSuccessionProposal['reconciliation'],
): Result<ReadonlySet<string>> {
  if ('kind' in observed && observed.kind === 'parent-child-advance') {
    if (!matchesParentAdvance(evidence, mandate, admission, observed)) return currentSuccessionFailure()
    return currentLineageStarts(evidence, mandate)
  }
  if ('kind' in observed) {
    const effect = authenticateSuccessorDelivery(evidence, mandate, admission, observed)
    if (!effect.ok) return effect
    return currentLineageStarts(evidence, mandate)
  }
  if (!contextSuccessionManagedBaselineSchema.safeParse(observed.reconciliation).success)
    return currentSuccessionFailure()
  if (!matchesCurrentBaseline(evidence, mandate, observed.reconciliation, expected)) return currentSuccessionFailure()
  return currentLineageStarts(evidence, mandate)
}

function matchesParentAdvance(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  admission: ContextSuccessionAdmission,
  observed: Extract<ContextSuccessionObservation, { kind: 'parent-child-advance' }>,
): boolean {
  if (
    !parentAdvanceSchema.safeParse(observed).success ||
    observed.candidate.repository !== mandate.repository ||
    observed.candidate.head !== observed.candidate.remoteBase ||
    !equalScope(observed.delivery.uw, mandateScope(mandate)) ||
    observed.delivery.pullRequests.length !== 0 ||
    observed.delivery.integrations.length !== 0 ||
    observed.delivery.commits.length !== 0 ||
    !authenticatedChildAdvance(evidence, mandate, admission, observed.candidate.head)
  )
    return false
  const deliveries = evidence.causal.observation.delivery.filter((item) => equalScope(item.uw, mandateScope(mandate)))
  return (
    deliveries.length <= 1 &&
    (deliveries.length === 0 || canonicalValueDigest(deliveries[0]) === canonicalValueDigest(observed.delivery))
  )
}

function matchesCurrentBaseline(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  current: ContextSuccessionManagedBaseline,
  expected: ContextSuccessionProposal['reconciliation'],
): boolean {
  const digest = canonicalValueDigest
  if (
    digest(current.code) !== digest(expected.code) ||
    current.repository !== expected.repository ||
    current.branch !== expected.branch ||
    digest(current.status) !== digest(expected.status) ||
    digest(current.remote) !== digest(expected.remote) ||
    digest(current.delivery) !== digest(expected.delivery) ||
    current.bindingDigest !== expected.bindingDigest
  )
    return false
  const deliveries = evidence.causal.observation.delivery.filter((delivery) =>
    equalScope(delivery.uw, mandateScope(mandate)),
  )
  return deliveries.length <= 1 && (deliveries.length === 0 || digest(deliveries[0]) === digest(current.delivery))
}

/** Historical lineage contributes only after this call authenticated the current native baseline. */
function currentLineageStarts(evidence: WorkflowEvidence, mandate: MandateRecord): Result<ReadonlySet<string>> {
  const context = createHistoricalAcceptedSpecContext(evidence.causal.histories)
  if (!context.ok) return context
  return historicalAcceptedSpecPriorStarts(context.value, evidence.causal.histories, mandate)
}
