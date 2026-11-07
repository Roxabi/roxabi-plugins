import { sameScope } from '../dist/contracts.js'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { resolveFramingReference } from './feature-continuation-admission.ts'
import { loadContracts } from './feature-engine.ts'
import type { FramingSubmissionResult } from './feature-framing-contract.ts'
import { recheck, refused, reopen, type SubmitActual, stale } from './feature-framing-controller-form-gate.ts'
import { advance } from './feature-framing-controller-index.ts'
import {
  asUwDiagnostics,
  type BoundSelection,
  type ControllerCore,
  currentAt,
  framingDiagnostic,
  type LeaseState,
  submission,
} from './feature-framing-controller-lease.ts'
import { readOnlyUw } from './feature-framing-controller-proposal.ts'
import { nodeOf, observationOf } from './feature-framing-controller-slots.ts'
import { framingReferenceInText, framingUserEntry } from './feature-framing-source.ts'

type SelectForm = Extract<FramingForm, { kind: 'select-existing' }>
type ReferenceText = { text: string; selected: BoundSelection['selection']['text'] }

/** The exact operator-written text that must contain the reference token. */
function referenceText(
  lease: LeaseState,
  form: SelectForm,
  actual: SubmitActual,
): ReferenceText | FramingSubmissionResult {
  if (form.text === 'accepted-args') {
    if (lease.source.kind !== 'free-text')
      return refused(lease, 'framing-reference-text-unavailable', 'Only a free-text request has accepted arguments')
    return { text: lease.source.acceptedArgs, selected: 'accepted-args' }
  }
  const entry = framingUserEntry(actual.ctx, form.text.entryId)
  if (!entry.ok) return submission(lease, 'refused', asUwDiagnostics(lease, entry.diagnostics))
  return { text: entry.value, selected: { sessionId: lease.origin.sessionId, entryId: form.text.entryId } }
}

/** Resolve through the engine at the origin; a resolved member is never selected twice. */
async function resolveSelection(
  core: ControllerCore,
  lease: LeaseState,
  form: SelectForm,
  actual: SubmitActual,
): Promise<{ scope: Scope } | FramingSubmissionResult> {
  const engine = await loadContracts()
  if ('missing' in engine)
    return refused(lease, 'framing-engine-unavailable', `Contracts unavailable: ${engine.missing}`)
  const scope = await resolveFramingReference({
    reference: form.reference,
    cwd: lease.origin.cwd,
    gh: core.host.gh,
    engine,
  })
  if (!currentAt(core, lease, actual.ctx)) return stale(lease)
  if ('kind' in scope)
    return refused(
      lease,
      'framing-reference-unresolved',
      scope.kind === 'blocked' ? scope.reason : `Reference resolved to ${scope.kind}`,
    )
  const duplicate =
    (lease.source.kind === 'issue' && sameScope(scope, lease.source.uw)) ||
    lease.selections.some((item) => sameScope(item.uw, scope))
  if (duplicate) return refused(lease, 'framing-slot-duplicate', `${scope.target} is already a framing member`)
  return { scope }
}

export async function selectExisting(
  core: ControllerCore,
  lease: LeaseState,
  form: SelectForm,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  if (lease.selections.some((item) => item.key === form.key))
    return refused(lease, 'framing-slot-duplicate', `Slot ${form.key} is already selected`)
  const written = referenceText(lease, form, actual)
  if ('status' in written) return written
  if (!framingReferenceInText(written.text, form.reference))
    return refused(
      lease,
      'framing-reference-token',
      'The reference must appear as a complete operator-written issue token',
    )
  const resolved = await resolveSelection(core, lease, form, actual)
  if ('status' in resolved) return resolved
  const scope = resolved.scope
  const read = await (await readOnlyUw(core, lease, actual.ctx)).readUw(scope)
  if (!currentAt(core, lease, actual.ctx)) return stale(lease)
  const node = nodeOf(read, scope)
  if (node === null)
    return refused(lease, 'framing-selection-unreadable', `${scope.target} needs one complete native observation`)
  const blocked = await recheck(core, lease, actual, lease.revision)
  if (blocked) return blocked
  const bound: BoundSelection = {
    key: form.key,
    uw: scope,
    selection: { kind: 'operator-reference', text: written.selected, reference: form.reference },
    sourceBodySha256: node.raw.bodySha256,
    observed: observationOf(node),
    title: node.title,
    body: node.raw.body,
    analysis: read.parsed.analysis,
  }
  lease.selections.push(Object.freeze(bound))
  reopen(lease, null)
  advance(lease, actual.ctx)
  return submission(lease, 'accepted', [
    framingDiagnostic(
      lease,
      'framing-selection-bound',
      `Bound slot ${form.key} to ${scope.target}; reference it as { kind: 'selected', key: '${form.key}' }`,
    ),
  ])
}
