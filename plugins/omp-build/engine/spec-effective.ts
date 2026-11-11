import { FINDING_TARGET_FORMAT } from './finding-target-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameOwnSpecRef } from './record-diagnostics.ts'
import { currentEffectiveEngagementProblem, type TerminalChildSuccession } from './spec-effective-engagement.ts'
import { type SpecEffective, specEffectiveSchema } from './spec-effective-schema.ts'
import type { SpecVersionVector } from './uw-completion-types.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { scopeKey, type UwGraphObservation } from './uw-graph.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecAt } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { historyFor, mandatesOf } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

export type SpecEffectiveRequest = { own: OwnSpecRef; histories: readonly DecodedHistory[] } & (
  | { mode: 'historical'; versionVector: SpecVersionVector; assessmentReplay?: AssessmentReplayContext }
  | { mode: 'current'; graph: UwGraphObservation }
)

function refusal(own: OwnSpecRef, code: string, message: string): UwResult<never> {
  return {
    ok: false,
    diagnostics: [{ code, message, location: { kind: 'record', ref: own.sourceAccepted }, related: [] }],
  }
}

function acceptedAt(ref: OwnSpecRef, input: SpecEffectiveRequest): AcceptedOwnSpec | null {
  const history = historyFor(ref.uw, input.histories)
  if (history === null || !history.source.complete) return null
  if (input.mode === 'current') {
    const mandate = selectedMandate(history)
    if (!('kind' in mandate) || mandate.kind !== 'mandate') return null
    const result = resolveAcceptedSpec(mandate, input.histories)
    return result.ok && sameOwnSpecRef(result.spec.ref, ref) ? result.spec : null
  }
  const matches: AcceptedOwnSpec[] = []
  for (const mandate of mandatesOf(history)) {
    const result = resolveAcceptedSpecAt(mandate, input.histories, ref, input.assessmentReplay)
    if (result.ok && sameOwnSpecRef(result.spec.ref, ref)) matches.push(result.spec)
  }
  const [match] = matches
  return matches.length === 1 && match !== undefined ? match : null
}

function sameVector(left: readonly OwnSpecRef[], right: readonly OwnSpecRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const expected = right[index]
      return expected !== undefined && sameOwnSpecRef(ref, expected)
    })
  )
}

function inheritedStates(input: SpecEffectiveRequest, own: AcceptedOwnSpec): UwResult<AcceptedOwnSpec[]> {
  const states: AcceptedOwnSpec[] = [own]
  const scopes = new Set([scopeKey(own.ref.uw)])
  for (const [index, ref] of own.inheritedOwnSpecRefs.entries()) {
    const key = scopeKey(ref.uw)
    if (scopes.has(key)) return refusal(input.own, 'effective-ancestry-cycle', 'Accepted inheritance repeats a UW')
    scopes.add(key)
    const ancestor = acceptedAt(ref, input)
    if (ancestor === null)
      return refusal(
        input.own,
        'effective-ancestor-unavailable',
        `Accepted ancestor ${ref.uw.repository} ${ref.uw.target} is unavailable, ambiguous, or no longer current`,
      )
    const expected = own.inheritedOwnSpecRefs.slice(index + 1)
    if (!sameVector(ancestor.inheritedOwnSpecRefs, expected))
      return refusal(
        input.own,
        'effective-ancestry-mismatch',
        'Ancestor inheritance does not match the complete pinned suffix',
      )
    states.push(ancestor)
  }
  return { ok: true, value: states }
}

function effectiveValue(
  own: AcceptedOwnSpec,
  states: readonly AcceptedOwnSpec[],
  vector: SpecVersionVector,
  requested: OwnSpecRef,
): UwResult<SpecEffective> {
  const inherited = {
    invariants: states.slice(1).flatMap((state) =>
      state.snapshot.spec.invariants.map((item) => ({
        target: { format: FINDING_TARGET_FORMAT, kind: 'invariant' as const, spec: state.ref, id: item.id },
        statement: item.statement,
      })),
    ),
    exclusions: states
      .slice(1)
      .flatMap((state) =>
        state.snapshot.spec.exclusions.map((statement, index) => ({ ref: { spec: state.ref, index }, statement })),
      ),
  }
  const parsed = specEffectiveSchema.safeParse({
    format: 'omp-build-spec-effective/2',
    resolution: 'resolved',
    own: own.ref,
    versionVector: vector,
    spec: own.snapshot.spec,
    inherited,
  })
  return parsed.success
    ? { ok: true, value: parsed.data }
    : refusal(requested, 'effective-malformed', 'Authenticated Spec does not form a valid effective Spec')
}

/** Resolve each pinned accepted prefix only after its complete authenticated chain has been replayed. */
function resolveEffective(
  input: SpecEffectiveRequest,
  controlAuthority: boolean,
  succession: TerminalChildSuccession | null,
): UwResult<SpecEffective> {
  const own = acceptedAt(input.own, input)
  if (own === null)
    return refusal(
      input.own,
      'effective-own-unavailable',
      'The exact accepted own Spec and its complete chain are unavailable or ambiguous',
    )
  const vector: SpecVersionVector = [own.ref, ...own.inheritedOwnSpecRefs]
  if (input.mode === 'historical' && !sameVector(input.versionVector, vector))
    return refusal(
      input.own,
      'effective-vector-mismatch',
      'Historical vector does not equal the authenticated accepted inheritance pins',
    )
  const states = inheritedStates(input, own)
  if (!states.ok) return states
  if (input.mode === 'current') {
    const problem = currentEffectiveEngagementProblem(input, states.value, controlAuthority, succession)
    if (problem !== null) return problem
  }
  return effectiveValue(own, states.value, vector, input.own)
}

export function resolveSpecEffective(input: SpecEffectiveRequest): UwResult<SpecEffective> {
  return resolveEffective(input, false, null)
}

/** Current authority for a control that must separately validate its proposed wait edges. */
export function resolveSpecEffectiveForControl(
  input: Extract<SpecEffectiveRequest, { mode: 'current' }>,
): UwResult<SpecEffective> {
  return resolveEffective(input, true, null)
}

/** Validate only the active Parent's engagement while its exact terminal child is explicitly replaced. */
export function resolveSpecEffectiveForTerminalChildSuccession(
  input: Extract<SpecEffectiveRequest, { mode: 'current' }>,
  succession: TerminalChildSuccession,
): UwResult<SpecEffective> {
  return resolveEffective(input, false, succession)
}
