import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { buildRecord } from './record-construction.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { createdChildReadbackProblem, readComposedMaterialIntent } from './workflow-composed-material-intent.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import {
  type ConcreteAcceptedState,
  type CreatedChildBinding,
  concreteAcceptedStateSchema,
  type MaterialAuthorization,
} from './workflow-mandate-schema.ts'
import {
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
  type PreparedMaterialAcceptance,
} from './workflow-spec-assessment.ts'

type ComposedAuthorization = Extract<MaterialAuthorization, { kind: 'cause-creation' }>
type Control = Extract<CanonicalRecord, { kind: 'operator-control' }>
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)
const invalid = <T>(message: string): Result<T> => fail([diagnostic('material-composition-invalid', message)])
/** Authenticate the already-confirmed outer intent, child identity, actual readback and exact slot substitution. */
export function validateComposedMaterialAuthorization(input: {
  proposal: MaterialAcceptanceProposal
  authorization: ComposedAuthorization
  confirmation: OperatorConfirmationEvidence
  histories: readonly DecodedHistory[]
}): Result<ConcreteAcceptedState> {
  const { proposal, authorization, confirmation } = input
  const intent = readComposedMaterialIntent(input)
  if (!intent.ok) return intent
  const { outer, core } = intent.value
  const binding = authorization.binding
  const readbackProblem = createdChildReadbackProblem(intent.value, binding, confirmation)
  if (readbackProblem !== null) return invalid(readbackProblem)
  const proposed = proposal.exactInputs.proposed
  const slots = proposed.children.filter((child) => 'kind' in child)
  const slot = slots[0]
  if (
    slots.length !== 1 ||
    slot === undefined ||
    slot.operationId !== outer.operationId ||
    slot.planDigest !== canonicalValueDigest(core) ||
    !equal(slot.plan, core) ||
    proposed.children.some((child) => !('kind' in child) && equalScope(child.scope, binding.child))
  )
    return invalid('Parent assessment does not contain exactly the confirmed created child slot')
  const childrenBound = proposed.children.map((child) =>
    'kind' in child
      ? {
          scope: binding.child,
          specVersion: binding.snapshot.spec.version,
          snapshot: binding.snapshot,
          tier: outer.tier,
        }
      : child,
  )
  const coverage =
    proposed.coverage === null
      ? null
      : {
          parent: proposed.coverage.parent,
          assignments: proposed.coverage.assignments.map((row) => {
            const [first, ...rest] = row.children
            const bind = (child: typeof first) => ('kind' in child ? binding.child : child)
            const children: [typeof binding.child, ...(typeof binding.child)[]] = [bind(first), ...rest.map(bind)]
            return { criterion: row.criterion, children }
          }),
        }
  const result = concreteAcceptedStateSchema.safeParse({
    snapshot: proposed.snapshot,
    tier: proposed.tier,
    inheritedOwnSpecRefs: proposed.inheritedOwnSpecRefs,
    children: childrenBound,
    coverage,
  })
  if (!result.success || !equal(result.data, authorization.boundState))
    return invalid('Persisted bound state is not the exact slot substitution')
  return { ok: true, value: result.data }
}

/** Build the internal parent control from the authenticated outer confirmation, never a second confirmation. */
export function buildComposedMaterialAcceptanceControl(input: {
  prepared: PreparedMaterialAcceptance
  operation: ExternalRecordRef
  binding: CreatedChildBinding
  histories: readonly DecodedHistory[]
}): Result<Control> {
  const { prepared, operation, binding, histories } = input
  const history = historyFor(operation.scope, histories)
  const bound = history === null ? null : bindExternalRef(operation, history)
  if (bound === null || !bound.ok || bound.value.kind !== 'cause-operation')
    return invalid('Creation intent is unavailable')
  const outer = bound.value.payload.proposal
  if (outer.operation !== 'create' || outer.parentAcceptance === null)
    return invalid('Creation intent has no parent consent')
  const proposed = prepared.proposal.exactInputs.proposed
  const children = proposed.children.map((child) =>
    'kind' in child
      ? {
          scope: binding.child,
          snapshot: binding.snapshot,
          specVersion: binding.snapshot.spec.version,
          tier: outer.tier,
        }
      : child,
  )
  const coverage =
    proposed.coverage === null
      ? null
      : {
          parent: proposed.coverage.parent,
          assignments: proposed.coverage.assignments.map((row) => {
            const [first, ...rest] = row.children
            const bind = (child: typeof first) => ('kind' in child ? binding.child : child)
            const children: [typeof binding.child, ...(typeof binding.child)[]] = [bind(first), ...rest.map(bind)]
            return { criterion: row.criterion, children }
          }),
        }
  const state = concreteAcceptedStateSchema.safeParse({
    snapshot: proposed.snapshot,
    tier: proposed.tier,
    inheritedOwnSpecRefs: proposed.inheritedOwnSpecRefs,
    children,
    coverage,
  })
  if (!state.success || prepared.digest !== materialAcceptanceDigest(prepared.proposal))
    return invalid('Prepared parent proposal or bound state is malformed')
  const authorization: ComposedAuthorization = {
    kind: 'cause-creation',
    operation: { ...operation, kind: 'cause-operation' },
    binding,
    boundState: state.data,
  }
  const confirmation = bound.value.payload.confirmation
  const checked = validateComposedMaterialAuthorization({
    proposal: prepared.proposal,
    authorization,
    confirmation,
    histories,
  })
  if (!checked.ok) return checked
  const proposal = prepared.proposal
  return buildRecord({
    repository: proposal.mandate.scope.repository,
    target: proposal.mandate.scope.target,
    version: 1,
    recordId: proposal.operationId,
    runId: proposal.operationId,
    operationId: proposal.operationId,
    kind: 'operator-control',
    payload: {
      control: 'accept-material',
      controlId: proposal.operationId,
      mandate: proposal.mandate,
      predecessor: proposal.predecessor,
      assessment: proposal.assessment,
      specVersion: proposal.exactInputs.proposed.snapshot.spec.version,
      proposalDigest: prepared.digest,
      authorization,
      confirmation,
      identityDelta: { retired: [...proposal.exactInputs.mechanical.removed] },
    },
  })
}
