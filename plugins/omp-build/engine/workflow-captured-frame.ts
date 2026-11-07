import { acceptedMetadataOwner } from './accepted-metadata-owner.ts'
import { canonicalValueDigest, selectorAdmitted, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { recordRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import { resolveAcceptedSpecPrefixes } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'
import { resolveCapturedWorkMandate } from './workflow-pr-binding.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

function matchesCapturedPrefix(
  prefix: AcceptedOwnSpec,
  effective: Extract<ActionInputs['manifest']['spec'], { kind: 'accepted' }>['effective'],
  pins: ActionInputs['manifest']['acceptedSources'],
  histories: readonly DecodedHistory[],
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
  const expected = [...prefix.sourceRefs, ...vector.map((ref) => ref.sourceAccepted)]
  const keys = new Set(expected.map((ref) => canonicalValueDigest(ref)))
  if (
    pins.length !== keys.size ||
    new Set(pins.map((pin) => canonicalValueDigest(pin.record))).size !== keys.size ||
    pins.some((pin) => pin.selector !== '/payload' || !keys.has(canonicalValueDigest(pin.record)))
  )
    return false
  return pins.every((pin) => recordRefDiagnostics('captured accepted source', pin, histories).length === 0)
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
): Result<{ mandate: MandateRecord; prefix: AcceptedOwnSpec }> {
  if (
    !validateActionInputs(inputs).ok ||
    inputs.manifest.spec.kind !== 'accepted' ||
    inputs.manifest.subject.kind !== 'uw'
  )
    return refusal('Captured work lacks valid accepted UW inputs')
  const mandate = resolveCapturedWorkMandate(inputs, histories)
  if (!mandate.ok) return mandate
  const authenticatedMandate = authenticateCapturedMandate(inputs, mandate.value, mandateRef)
  if (!authenticatedMandate.ok) return authenticatedMandate
  const effective = inputs.manifest.spec.effective
  if (
    !equalScope(effective.own.uw, inputs.manifest.subject.uw) ||
    inputs.manifest.code.repository !== inputs.manifest.subject.uw.repository
  )
    return refusal('Captured work subject or code repository differs from its accepted UW')
  const prefixes = resolveAcceptedSpecPrefixes(mandate.value, histories, replay)
  if (!prefixes.ok) return { ok: false, diagnostics: prefixes.evidence }
  const matches = prefixes.prefixes.filter((prefix) =>
    matchesCapturedPrefix(prefix, effective, inputs.manifest.acceptedSources, histories),
  )
  const prefix = matches[0]
  if (matches.length !== 1 || prefix === undefined)
    return refusal('Captured accepted metadata prefix is absent or ambiguous')
  const step = prefix.chain.at(-1)
  if (step === undefined || !acceptedMetadataOwner(step, histories).ok)
    return refusal('Captured metadata owner is unavailable')
  const resolved = resolveSpecEffective({
    mode: 'historical',
    own: prefix.ref,
    versionVector: effective.versionVector,
    histories,
    assessmentReplay: replay,
  })
  if (!resolved.ok)
    return { ok: false, diagnostics: resolved.diagnostics.map(({ code, message }) => diagnostic(code, message)) }
  if (canonicalValueDigest(resolved.value) !== canonicalValueDigest(effective))
    return refusal('Captured effective Spec differs from the authenticated vector')
  const sources = authenticateCapturedSources(inputs, histories)
  if (!sources.ok) return sources
  return { ok: true, value: { mandate: mandate.value, prefix } }
}
