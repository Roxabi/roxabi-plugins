import { parseIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { BoundWork, ConfigIdentity, MandateUse } from './workflow-binding.ts'
import { workflowCausalDiagnostics } from './workflow-chantier.ts'
import {
  historyFor,
  type MandateRecord,
  mandateScope,
  outstandingPauseInAuthority,
  workflowOperationProblem,
} from './workflow-control.ts'
import { selectApplicableMandate } from './workflow-mandate-admission.ts'
import type { WorkflowCausalContext } from './workflow-plan.ts'
import { selectWorkflowBinding } from './workflow-pr-binding.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import { sameCurrentAssessedState } from './workflow-spec-assessment.ts'
import { currentSnapshotProjection } from './workflow-spec-projections.ts'

type BoundWorkInput = {
  use: MandateUse
  explicitSelection: boolean
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  causal: Pick<WorkflowCausalContext, 'histories' | 'catalogues'>
  native: { branch: string; base: string }
  currentSpec?: AssessSpecExact['proposed'] | null
}

function configIdentityOf(
  mandate: MandateRecord,
): { ok: true; identity: ConfigIdentity } | { ok: false; evidence: Diagnostic[] } {
  const effective = mandate.payload.config.effective
  const raw =
    effective !== null && typeof effective === 'object' && !Array.isArray(effective)
      ? Reflect.get(effective, 'additionalRequirements')
      : undefined
  const additionalRequirements: string[] = []
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return malformedRequirements()
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0) return malformedRequirements()
      additionalRequirements.push(item)
    }
  }
  return {
    ok: true,
    identity: {
      productVersion: mandate.payload.config.productVersion,
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      additionalRequirements,
      serialized: JSON.stringify({
        productVersion: mandate.payload.config.productVersion,
        version: mandate.payload.config.version,
        digest: mandate.payload.config.digest,
        additionalRequirements,
      }),
    },
  }
}

function malformedRequirements(): { ok: false; evidence: Diagnostic[] } {
  return { ok: false, evidence: [diagnostic('malformed', 'Mandate additional requirements are malformed')] }
}

function absentBinding(input: BoundWorkInput): BoundWork {
  if (input.use !== 'landing' && input.explicitSelection) return { status: 'standalone', binding: 'absent' }
  return {
    status: 'refused',
    reason: 'missing',
    evidence: [diagnostic('mandate-absent', 'No workflow binding exists and selection was not explicit')],
  }
}

/** Accepted authority is immutable; only the live presentation may vary without changing its Spec. */
function sameLiveSnapshot(
  scope: Scope,
  current: AssessSpecExact['proposed']['snapshot'],
  accepted: AssessSpecExact['proposed']['snapshot'],
): boolean {
  if (current.raw.reference !== accepted.raw.reference) return false
  const currentSpec = JSON.stringify(currentSnapshotProjection(current).spec)
  if (currentSpec !== JSON.stringify(currentSnapshotProjection(accepted).spec)) return false
  if (current.raw.body === accepted.raw.body) return current.raw.bodySha256 === accepted.raw.bodySha256
  if (current.raw.bodySha256 !== specDigest(current.raw.body)) return false
  const parsed = parseIssueSpecBody({ uw: scope, raw: current.raw })
  return (
    parsed.status === 'conformant' && JSON.stringify(currentSnapshotProjection(parsed.snapshot).spec) === currentSpec
  )
}

function sameLiveAcceptedState(scope: Scope, current: AssessSpecExact['proposed'], accepted: AcceptedOwnSpec): boolean {
  if (sameCurrentAssessedState(current, accepted)) return true
  if (
    current.tier !== accepted.tier ||
    JSON.stringify(current.inheritedOwnSpecRefs) !== JSON.stringify(accepted.inheritedOwnSpecRefs) ||
    JSON.stringify(current.coverage) !== JSON.stringify(accepted.coverage) ||
    current.children.length !== accepted.children.length ||
    !sameLiveSnapshot(scope, current.snapshot, accepted.snapshot)
  )
    return false
  return current.children.every((child, index) => {
    const expected = accepted.children[index]
    return (
      !('kind' in child) &&
      expected !== undefined &&
      child.scope.repository === expected.scope.repository &&
      child.scope.target === expected.scope.target &&
      child.specVersion === expected.specVersion &&
      child.tier === expected.tier &&
      sameLiveSnapshot(child.scope, child.snapshot, expected.snapshot)
    )
  })
}

function applicableBoundWork(
  input: BoundWorkInput,
  mandate: MandateRecord,
  permissions: { landing: boolean; correct: boolean },
  acceptedSpec: AcceptedOwnSpec,
  configIdentity: ConfigIdentity,
): BoundWork {
  const scope = mandateScope(mandate)
  if (input.currentSpec == null)
    return {
      status: 'applicable',
      binding: 'bound',
      mandate,
      scope,
      permissions,
      acceptedSpec,
      configIdentity,
      drift: null,
    }
  const sameCurrent = sameLiveAcceptedState(scope, input.currentSpec, acceptedSpec)
  return {
    status: 'applicable',
    binding: 'bound',
    mandate,
    scope,
    permissions,
    acceptedSpec,
    configIdentity,
    drift: sameCurrent ? 'settled' : 'differs',
  }
}

function authorizedBoundWork(input: BoundWorkInput, mandate: MandateRecord): BoundWork {
  const pause = outstandingPauseInAuthority(mandate, input.histories)
  if (pause !== null) return { status: 'refused', reason: 'unconfirmed', evidence: [pause] }
  const permissions = {
    landing: mandate.payload.permissions.landing && mandate.payload.role !== 'fix-only',
    correct: mandate.payload.permissions.correct,
  }
  if (input.use === 'landing' && !permissions.landing)
    return { status: 'refused', reason: 'fix-only', evidence: [diagnostic('fix-only', 'Fix-only mandate cannot land')] }
  if (input.use === 'correction' && !permissions.correct) {
    return {
      status: 'refused',
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Mandate does not permit correction')],
    }
  }
  const accepted = resolveAcceptedSpec(mandate, input.causal.histories)
  if (!accepted.ok) return { status: 'refused', reason: accepted.reason, evidence: accepted.evidence }
  const identity = configIdentityOf(mandate)
  if (!identity.ok) return { status: 'refused', reason: 'incomplete', evidence: identity.evidence }
  return applicableBoundWork(input, mandate, permissions, accepted.spec, identity.identity)
}

function recordsOnlyDiagnostics(input: BoundWorkInput): Diagnostic[] {
  const observed = new Map<string, DecodedHistory>()
  for (const history of input.causal.histories) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    const problem = workflowOperationProblem(history)
    if (observed.has(key) || problem !== null)
      return [diagnostic(problem ?? 'ambiguous', 'Causal record histories must be complete and unique')]
    observed.set(key, history)
  }
  const selected = new Set<string>()
  for (const history of input.histories) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    const captured = observed.get(key)
    if (selected.has(key) || (captured !== history && JSON.stringify(captured) !== JSON.stringify(history)))
      return [
        diagnostic('fix-history-observation-drift', 'Selected history differs from the unique causal record closure'),
      ]
    selected.add(key)
  }
  return []
}

function hasObservation(causal: BoundWorkInput['causal']): causal is WorkflowCausalContext {
  return 'observation' in causal
}

function boundClosure(input: BoundWorkInput): { causal: WorkflowCausalContext } | { evidence: Diagnostic[] } {
  const selectedScopes = new Set<string>()
  for (const history of input.histories) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    if (selectedScopes.has(key))
      return { evidence: [diagnostic('ambiguous', 'Selected workflow histories repeat a scope')] }
    selectedScopes.add(key)
  }
  if (!hasObservation(input.causal))
    return {
      evidence: [diagnostic('fix-history-observation-drift', 'Bound work requires a complete UW observation')],
    }
  const evidence = workflowCausalDiagnostics(input.histories, input.causal)
  return evidence.length > 0 ? { evidence } : { causal: input.causal }
}

function absentClosureDiagnostics(input: BoundWorkInput): Diagnostic[] {
  const recordsDiagnostics = recordsOnlyDiagnostics(input)
  if (recordsDiagnostics.length > 0 || !hasObservation(input.causal)) return recordsDiagnostics
  return workflowCausalDiagnostics(input.histories, input.causal)
}

function selectedBoundMandate(
  input: BoundWorkInput,
  boundMandate: MandateRecord,
  causal: WorkflowCausalContext,
): BoundWork {
  const mandateHistory = historyFor(mandateScope(boundMandate), input.histories)
  if (mandateHistory === null) {
    return {
      status: 'refused',
      reason: 'missing-history',
      evidence: [diagnostic('missing-history', 'Bound mandate history is missing')],
    }
  }
  const selected = selectApplicableMandate(mandateHistory, input.histories, causal)
  if (selected.status === 'refused') return { status: 'refused', reason: selected.reason, evidence: selected.evidence }
  if (selected.mandate.recordId !== boundMandate.recordId) {
    return {
      status: 'refused',
      reason: 'ambiguous',
      evidence: [diagnostic('ambiguous', 'Bound mandate is not the active mandate')],
    }
  }
  return authorizedBoundWork(input, selected.mandate)
}

export function resolveBoundWork(input: BoundWorkInput): BoundWork {
  const binding = selectWorkflowBinding(input)
  if (binding.status === 'absent') {
    const closureDiagnostics = absentClosureDiagnostics(input)
    if (closureDiagnostics.length > 0) return { status: 'refused', reason: 'incomplete', evidence: closureDiagnostics }
    return absentBinding(input)
  }
  if (binding.status !== 'bound') {
    return {
      status: 'refused',
      reason: binding.status === 'incomplete' ? 'incomplete' : 'ambiguous',
      evidence: binding.diagnostics,
    }
  }
  const closure = boundClosure(input)
  if ('evidence' in closure) return { status: 'refused', reason: 'incomplete', evidence: closure.evidence }
  return selectedBoundMandate(input, binding.mandateRecord, closure.causal)
}
