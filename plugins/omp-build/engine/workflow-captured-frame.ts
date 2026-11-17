import { acceptedMetadataOwner } from './accepted-metadata-owner.ts'
import { canonicalValueDigest, selectorAdmitted, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { recordRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import { resolveAcceptedSpecAt, resolveAcceptedSpecPrefixes } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { matchesCommitment } from './workflow-assessment-child-sources.ts'
import type { HistoricalAcceptedSpecContext } from './workflow-context-succession-inspection.ts'
import type { MandateRecord } from './workflow-control.ts'
import { bindExternalRef, historyFor, mandatesOf } from './workflow-control.ts'
import { resolveCapturedAssessmentMandate, resolveCapturedWorkMandate } from './workflow-pr-binding.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from './workflow-spec-authentication.ts'

function matchesCapturedPrefix(
  prefix: AcceptedOwnSpec,
  effective: Extract<ActionInputs['manifest']['spec'], { kind: 'accepted' }>['effective'],
  pins: ActionInputs['manifest']['acceptedSources'],
  histories: readonly DecodedHistory[],
  extraSources: readonly ExternalRecordRef[],
): boolean {
  const vector = [prefix.ref, ...prefix.inheritedOwnSpecRefs]
  if (
    vector.length !== effective.versionVector.length ||
    vector.some((ref, i) => {
      const entry = effective.versionVector[i]
      return entry === undefined || !sameOwnSpecRef(ref, entry)
    })
  )
    return false
  const expected = [...prefix.sourceRefs, ...vector.map((ref) => ref.sourceAccepted), ...extraSources]
  const keys = new Set(expected.map((ref) => canonicalValueDigest(ref)))
  if (
    pins.length !== keys.size ||
    new Set(pins.map((pin) => canonicalValueDigest(pin.record))).size !== keys.size ||
    pins.some((pin) => pin.selector !== '/payload' || !keys.has(canonicalValueDigest(pin.record)))
  )
    return false
  return pins.every((pin) => recordRefDiagnostics('captured accepted source', pin, histories).length === 0)
}

function capturedAssessmentExtraSources(
  exact: Extract<NonNullable<ActionInputs['manifest']['operands']>, { action: 'assess-spec' }>['exactInputs'],
  pins: ActionInputs['manifest']['acceptedSources'],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): readonly ExternalRecordRef[] | null {
  const sources: ExternalRecordRef[] = [...exact.identityAllocations]
  for (const child of exact.childOwnSources) {
    const childSources = capturedChildSources(exact, child, pins, histories, replay, inspection, historical)
    if (childSources === null) return null
    sources.push(...childSources)
  }
  return sources
}

function capturedChildSources(
  exact: Extract<NonNullable<ActionInputs['manifest']['operands']>, { action: 'assess-spec' }>['exactInputs'],
  child: Extract<
    NonNullable<ActionInputs['manifest']['operands']>,
    { action: 'assess-spec' }
  >['exactInputs']['childOwnSources'][number],
  pins: ActionInputs['manifest']['acceptedSources'],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): readonly ExternalRecordRef[] | null {
  const home = historyFor(child.uw, histories)
  if (home === null || !home.source.complete) return null
  if (child.own === null) return mandatesOf(home).length === 0 ? [] : null
  const candidate = capturedChildCandidate(home, histories, child.own, replay, inspection, historical)
  if (candidate === null) return null
  const prior = exact.accepted.children.find((entry) => equalScope(entry.scope, child.uw))
  const proposed =
    exact.proposed.children.find((entry) => !('kind' in entry) && equalScope(entry.scope, child.uw)) ??
    exact.attachedChildren.find((entry) => equalScope(entry.scope, child.uw))
  const commitment = prior ?? proposed
  if (commitment === undefined || 'kind' in commitment || !matchesCommitment(candidate.spec, commitment)) return null
  if (prior === undefined || proposed !== undefined) return candidate.spec.sourceRefs
  const controls = capturedAbandonmentPins(pins, child.uw, home, candidate.mandate)
  if (controls.length !== 1 || controls[0] === undefined) return null
  return [...candidate.spec.sourceRefs, controls[0]]
}

function capturedChildCandidate(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  own: NonNullable<
    Extract<
      NonNullable<ActionInputs['manifest']['operands']>,
      { action: 'assess-spec' }
    >['exactInputs']['childOwnSources'][number]['own']
  >,
  replay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): { mandate: MandateRecord; spec: AcceptedOwnSpec } | null {
  const candidates = mandatesOf(home).flatMap((mandate) => {
    const result = resolveAcceptedSpecAt(mandate, histories, own, replay, inspection, historical)
    return result.ok && sameOwnSpecRef(result.spec.ref, own) ? [{ mandate, spec: result.spec }] : []
  })
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

function capturedAbandonmentPins(
  pins: ActionInputs['manifest']['acceptedSources'],
  uw: DecodedHistory['source']['scope'],
  home: DecodedHistory,
  mandate: MandateRecord,
): ExternalRecordRef[] {
  return pins.flatMap((pin) => {
    if (!equalScope(pin.record.scope, uw) || pin.record.kind !== 'operator-control') return []
    const bound = bindExternalRef(pin.record, home)
    return bound.ok &&
      bound.value.kind === 'operator-control' &&
      bound.value.payload.control === 'abandon' &&
      bound.value.payload.mandate.recordId === mandate.recordId &&
      equalScope(bound.value.payload.mandate.scope, uw)
      ? [pin.record]
      : []
  })
}

const refusal = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

function authenticateCapturedSources(inputs: ActionInputs, histories: readonly DecodedHistory[]): Result<void> {
  for (const ref of inputs.manifest.deliveryData) {
    if (!selectorAdmitted(ref.role, ref.selector))
      return refusal('Captured delivery source selector is not admitted for its role')
    const errors = recordRefDiagnostics('captured delivery source', ref, histories)
    if (errors.length) return { ok: false, diagnostics: errors }
  }
  for (const ref of [
    ...inputs.stageSources,
    ...inputs.manifest.expandedContext.filter((entry) => entry.source === 'record'),
  ]) {
    const errors = recordRefDiagnostics('captured context source', ref, histories)
    if (errors.length) return { ok: false, diagnostics: errors }
  }
  return { ok: true, value: undefined }
}

function authenticateCapturedMandate(
  inputs: ActionInputs,
  mandate: MandateRecord,
  mandateRef: ExternalRecordRef,
): Result<void> {
  if (
    !sameRef(mandateRef, {
      scope: { repository: mandate.repository, target: mandate.target },
      kind: 'mandate',
      recordId: mandate.recordId,
    })
  )
    return refusal('Captured work mandate differs from its sealed subject')
  const config = mandate.payload.config
  if (
    inputs.manifest.configuration.version !== config.version ||
    inputs.manifest.configuration.digest !== config.digest ||
    inputs.manifest.configuration.serialized !== JSON.stringify(config.effective)
  )
    return refusal('Captured work configuration differs from its authenticated mandate')
  return { ok: true, value: undefined }
}

/** Authenticate one sealed historical frame; the result is private inspection data, not current authority. */
export function authenticateCapturedWorkFrame(
  inputs: ActionInputs,
  mandateRef: ExternalRecordRef,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<{ mandate: MandateRecord; prefix: AcceptedOwnSpec }> {
  if (
    !validateActionInputs(inputs).ok ||
    inputs.manifest.spec.kind !== 'accepted' ||
    inputs.manifest.subject.kind !== 'uw'
  )
    return refusal('Captured work lacks valid accepted UW inputs')
  const mandate =
    inputs.manifest.purpose === 'assess-spec'
      ? resolveCapturedAssessmentMandate(inputs, histories)
      : resolveCapturedWorkMandate(inputs, histories)
  if (!mandate.ok) return mandate
  const authenticatedMandate = authenticateCapturedMandate(inputs, mandate.value, mandateRef)
  if (!authenticatedMandate.ok) return authenticatedMandate
  const effective = inputs.manifest.spec.effective
  if (
    !equalScope(effective.own.uw, inputs.manifest.subject.uw) ||
    inputs.manifest.code.repository !== inputs.manifest.subject.uw.repository
  )
    return refusal('Captured work subject or code repository differs from its accepted UW')
  const prefixes = resolveAcceptedSpecPrefixes(mandate.value, histories, replay, inspection, historical)
  if (!prefixes.ok) return { ok: false, diagnostics: prefixes.evidence }
  let extraSources: readonly ExternalRecordRef[] = []
  const operands = inputs.manifest.operands
  if (operands?.action === 'assess-spec') {
    const sources = capturedAssessmentExtraSources(
      operands.exactInputs,
      inputs.manifest.acceptedSources,
      histories,
      replay,
      inspection,
      historical,
    )
    if (sources === null) return refusal('Captured assessment child sources differ from authenticated authority')
    extraSources = sources
  }
  const matches = prefixes.prefixes.filter((prefix) =>
    matchesCapturedPrefix(prefix, effective, inputs.manifest.acceptedSources, histories, extraSources),
  )
  const prefix = matches[0]
  if (matches.length !== 1 || prefix === undefined)
    return refusal('Captured accepted metadata prefix is absent or ambiguous')
  const resolved = authenticateCapturedEffective(prefix, effective, histories, replay, inspection, historical)
  if (!resolved.ok) return resolved
  const sources = authenticateCapturedSources(inputs, histories)
  if (!sources.ok) return sources
  return { ok: true, value: { mandate: mandate.value, prefix } }
}

function authenticateCapturedEffective(
  prefix: AcceptedOwnSpec,
  effective: Extract<ActionInputs['manifest']['spec'], { kind: 'accepted' }>['effective'],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<void> {
  const step = prefix.chain.at(-1)
  if (step === undefined || !acceptedMetadataOwner(step, histories).ok)
    return refusal('Captured metadata owner is unavailable')
  const resolved = resolveSpecEffective({
    mode: 'historical',
    own: prefix.ref,
    versionVector: effective.versionVector,
    histories,
    assessmentReplay: replay,
    inspection,
    historical,
  })
  if (!resolved.ok)
    return { ok: false, diagnostics: resolved.diagnostics.map(({ code, message }) => diagnostic(code, message)) }
  if (canonicalValueDigest(resolved.value) !== canonicalValueDigest(effective))
    return refusal('Captured effective Spec differs from the authenticated vector')
  return { ok: true, value: undefined }
}
