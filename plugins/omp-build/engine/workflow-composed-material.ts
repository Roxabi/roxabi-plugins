import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { createdChildReadbackProblem, readComposedMaterialIntent } from './workflow-composed-material-intent.ts'
import {
  type ConcreteAcceptedState,
  concreteAcceptedStateSchema,
  type MaterialAuthorization,
} from './workflow-mandate-schema.ts'
import type { MaterialAcceptanceProposal } from './workflow-spec-assessment.ts'

type ComposedAuthorization = Extract<MaterialAuthorization, { kind: 'cause-creation' }>
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
