import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { canonicalValueDigest, specDigest } from '../dist/contracts.js'
import type { FramingInvocationBinding } from '../engine/framing-context-schema.ts'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { Result } from '../engine/result.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput, FramingSourceBinding } from '../engine/uw-framing-schema.ts'
import type { UwNativeNode } from '../engine/uw-graph.ts'
import { type ControllerCore, framingDiagnostic, type LeaseState } from './feature-framing-controller-lease.ts'
import { nodeOf, resolveSlots } from './feature-framing-controller-slots.ts'
import type { UwOperations, UwRead } from './uw-contract.ts'
import type { PreparedFramingProposal } from './uw-framing-contract.ts'
import { buildFramingSourceBinding } from './uw-framing-prepare.ts'

type ProposalForm = Extract<FramingForm, { kind: 'proposal' }>
type Obligation = ProposalForm['vocabulary'][number]['invariant']
type Problem = { problem: UwDiagnostic }

export function readOnlyUw(core: ControllerCore, lease: LeaseState, ctx: ExtensionContext): Promise<UwOperations> {
  return core.host.uw({ ctx, operator: lease.readOnlyOperator })
}

/** One complete authenticated read of the selected issue and its source binding digest without materials. */
export async function readIssueSource(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
): Promise<{ read: UwRead; node: UwNativeNode; basis: string } | Problem> {
  if (lease.source.kind !== 'issue')
    return { problem: framingDiagnostic(lease, 'framing-source-kind', 'Expected an issue source') }
  const uw = await readOnlyUw(core, lease, ctx)
  const read = await uw.readUw(lease.source.uw)
  const binding = buildFramingSourceBinding(read, [])
  const node = nodeOf(read, lease.source.uw)
  if (!binding.ok || node === null)
    return {
      problem: binding.ok
        ? framingDiagnostic(
            lease,
            'framing-source-incomplete',
            'The selected issue needs one complete native observation',
          )
        : (binding.diagnostics[0] ??
          framingDiagnostic(lease, 'framing-source-unreadable', 'The selected issue is unreadable')),
    }
  return { read, node, basis: canonicalValueDigest(binding.value) }
}

function obligationKey(value: Obligation): string {
  return value.kind === 'existing' ? `existing:${value.id}` : `new:${value.draftKey}`
}

function draftKeys(
  items: readonly ({ kind: 'existing'; id: string } | { kind: 'new'; draftKey: string })[],
): Set<string> {
  return new Set(items.map((item) => (item.kind === 'existing' ? `existing:${item.id}` : `new:${item.draftKey}`)))
}

type Refuse = (code: string, message: string) => UwDiagnostic

function boundExactlyOnce(accepted: readonly string[], bound: readonly string[]): boolean {
  return (
    bound.length === accepted.length && accepted.every((name) => bound.filter((item) => item === name).length === 1)
  )
}

function vocabularyProblem(
  lease: LeaseState,
  form: ProposalForm,
  invariants: ReadonlySet<string>,
  criteria: ReadonlySet<string>,
  refuse: Refuse,
): UwDiagnostic | null {
  const terms = lease.terms.map((item) => item.term)
  if (
    !boundExactlyOnce(
      terms,
      form.vocabulary.map((item) => item.term),
    )
  )
    return refuse(
      'framing-vocabulary-unbound',
      'Bind every accepted term exactly once to a root invariant and a root delivery criterion',
    )
  for (const item of form.vocabulary)
    if (!invariants.has(obligationKey(item.invariant)) || !criteria.has(obligationKey(item.criterion)))
      return refuse(
        'framing-vocabulary-binding-invalid',
        `Term ${item.term} must cite an existing root invariant and root criterion`,
      )
  return null
}

function moduleProblem(
  lease: LeaseState,
  form: ProposalForm,
  invariants: ReadonlySet<string>,
  refuse: Refuse,
): UwDiagnostic | null {
  const modules = lease.modules.map((item) => item.name)
  if (
    !boundExactlyOnce(
      modules,
      form.modules.map((item) => item.name),
    )
  )
    return refuse('framing-module-unbound', 'Bind every accepted module interface exactly once to a root invariant')
  for (const item of form.modules)
    if (!invariants.has(obligationKey(item.invariant)))
      return refuse('framing-module-binding-invalid', `Module ${item.name} must cite an existing root invariant`)
  return null
}

function shapeProblem(lease: LeaseState, aggregate: ProposalForm['aggregate'], refuse: Refuse): UwDiagnostic | null {
  const decomposes = aggregate.edges.some((edge) => edge.kind === 'parent-child' && edge.parent === aggregate.root)
  if (lease.shape === 'leaf' && decomposes)
    return refuse('framing-shape-mismatch', 'A Leaf proposal has no planned children')
  if (lease.shape !== 'parent') return null
  if (!decomposes) return refuse('framing-shape-mismatch', 'A Parent proposal decomposes its root into children')
  const typed = lease.terms.length > 0 || lease.modules.length > 0
  if (typed && !aggregate.foundations.some((item) => item.parent === aggregate.root))
    return refuse(
      'framing-foundation-missing',
      'Parent vocabulary and module interfaces need a neutral foundation child first',
    )
  return null
}

/** Typed conclusions must land on root obligations; structure is checked, semantics are not claimed. */
function bindingProblem(lease: LeaseState, form: ProposalForm): UwDiagnostic | null {
  const aggregate = form.aggregate
  const refuse: Refuse = (code, message) => framingDiagnostic(lease, code, message)
  if (aggregate.kind === 'wayfinder')
    return form.vocabulary.length > 0 || form.modules.length > 0
      ? refuse('framing-wayfinder-bindings', 'A Wayfinder proposal is non-UW and binds no vocabulary or modules')
      : null
  if (!lease.designed) return refuse('framing-stage-incomplete', `Finish the ${lease.stage} stage before proposing`)
  const root = aggregate.members.find((member) => member.slot.key === aggregate.root)
  if (root?.kind !== 'uw') return refuse('framing-root-invalid', 'The aggregate root must be a UW member')
  const invariants = draftKeys(root.draft.invariants)
  return (
    vocabularyProblem(lease, form, invariants, draftKeys(root.draft.criteria), refuse) ??
    moduleProblem(lease, form, invariants, refuse) ??
    shapeProblem(lease, aggregate, refuse)
  )
}

/**
 * Builds the exact aggregate from host-retained state and calls the read-only preparation.
 * Returns the prepared proposal and the revision it binds, or one refusal diagnostic.
 */
export async function prepareProposal(
  core: ControllerCore,
  lease: LeaseState,
  form: ProposalForm,
  ctx: ExtensionContext,
): Promise<{ prepared: Result<PreparedFramingProposal, UwDiagnostic>; revision: number } | Problem> {
  const binding = bindingProblem(lease, form)
  if (binding !== null) return { problem: binding }
  const procedures = lease.procedures
  if (procedures === null || lease.repository === null)
    return { problem: framingDiagnostic(lease, 'framing-supply-unavailable', 'Framing supply is not loaded') }
  const uw = await readOnlyUw(core, lease, ctx)
  let source: FramingSourceBinding
  let sourceNode: { node: UwNativeNode } | null = null
  if (lease.source.kind === 'issue') {
    const fresh = await readIssueSource(core, lease, ctx)
    if ('problem' in fresh) return fresh
    if (fresh.basis !== lease.sourceBasis)
      return {
        problem: framingDiagnostic(lease, 'framing-source-changed', 'The selected issue changed since framing started'),
      }
    const bound = buildFramingSourceBinding(fresh.read, lease.materials)
    if (!bound.ok)
      return {
        problem:
          bound.diagnostics[0] ??
          framingDiagnostic(lease, 'framing-source-unreadable', 'The selected issue is unreadable'),
      }
    source = bound.value
    sourceNode = { node: fresh.node }
  } else {
    source = {
      kind: 'free-text',
      acceptedArgs: lease.source.acceptedArgs,
      bodySha256: specDigest(lease.source.acceptedArgs),
      repository: lease.repository,
      materials: [...lease.materials],
    }
  }
  const slots = await resolveSlots(lease, form.aggregate, uw, sourceNode)
  if ('problem' in slots) return slots
  const input: FramingAggregateInput = {
    kind: form.aggregate.kind,
    root: form.aggregate.root,
    members: form.aggregate.members.map((member) => {
      const slot = slots.get(member.slot.key)
      if (!slot) throw new Error(`framing slot ${member.slot.key} unresolved`)
      return { ...member, slot }
    }),
    edges: form.aggregate.edges,
    coverage: form.aggregate.coverage,
    foundations: form.aggregate.foundations,
    source,
  }
  const revision = lease.revision + 1
  const invocation: FramingInvocationBinding = {
    extensionInstanceId: core.host.owner.extensionInstanceId,
    sessionId: lease.origin.sessionId,
    agentId: lease.origin.agentId,
    generation: lease.handle.generation,
    revision,
    sourceDigest: canonicalValueDigest(source),
    procedures: procedures.manifest,
  }
  return { prepared: await uw.prepareFraming(input, invocation), revision }
}
