import { canonicalValueDigest } from './action-input.ts'
import type { RecordInputRef } from './action-input-schema.ts'
import { recordRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { IntegrationOutput } from './uw-integration-schema.ts'
import { resolveAcceptedSpecPrefixes } from './workflow-accepted-spec.ts'
import type { CapturedInvocation } from './workflow-captured-inventory.ts'
import { bindExternalRef, historyFor, mandatesOf } from './workflow-control.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

function fail(message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic('unconfirmed', message)] }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalValueDigest(left) === canonicalValueDigest(right)
}

function inspectChildSources(
  child: IntegrationOutput['children'][number],
  histories: readonly DecodedHistory[],
  childPins: Map<string, RecordInputRef>,
): Result<void> {
  for (const source of child.sources) {
    const owner = historyFor(source.scope, histories)
    if (owner === null) return fail('Captured child proof source history is unavailable')
    const bound = bindExternalRef(source, owner)
    if (!bound.ok) return bound
    const pin: RecordInputRef = {
      source: 'record',
      record: source,
      selector: '/payload',
      digest: canonicalValueDigest(bound.value.payload),
    }
    const diagnostics = recordRefDiagnostics('captured child completion source', pin, histories)
    if (diagnostics.length) return { ok: false, diagnostics }
    childPins.set(canonicalValueDigest(pin), pin)
  }
  return { ok: true, value: undefined }
}

function inspectChild(
  child: IntegrationOutput['children'][number],
  prefix: CapturedInvocation['frame']['prefix'],
  histories: readonly DecodedHistory[],
  childPins: Map<string, RecordInputRef>,
  replay?: AssessmentReplayContext,
): Result<void> {
  const commitment = prefix.children.find((entry) => equalScope(entry.scope, child.spec.uw))
  if (
    commitment === undefined ||
    commitment.specVersion !== child.spec.version ||
    child.code.repository !== child.spec.uw.repository ||
    !child.sources.some((source) => sameRef(source, child.spec.sourceAccepted))
  )
    return fail('Captured integration child differs from its accepted commitment')
  const history = historyFor(child.spec.uw, histories)
  if (history === null) return fail('Captured integration child history is unavailable')
  let accepted = false
  for (const mandate of mandatesOf(history)) {
    const prefixes = resolveAcceptedSpecPrefixes(mandate, histories, replay)
    if (!prefixes.ok) return { ok: false, diagnostics: prefixes.evidence }
    if (
      prefixes.prefixes.some(
        (state) =>
          sameOwnSpecRef(state.ref, child.spec) &&
          state.tier === commitment.tier &&
          same(state.snapshot, commitment.snapshot),
      )
    )
      accepted = true
  }
  if (!accepted) return fail('Captured integration child has no authenticated accepted OwnSpec prefix')
  return inspectChildSources(child, histories, childPins)
}

export function inspectIntegrationSources(
  item: CapturedInvocation,
  output: IntegrationOutput,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  const prefix = item.frame.prefix
  if (
    prefix.children.length === 0 ||
    prefix.coverage === null ||
    !same(prefix.coverage, output.coverage) ||
    prefix.children.length !== output.children.length
  )
    return fail('Captured integration does not conserve its accepted children and coverage')
  const scopes = new Set<string>()
  const childPins = new Map<string, RecordInputRef>()
  for (const child of output.children) {
    const key = canonicalValueDigest(child.spec.uw)
    if (scopes.has(key)) return fail('Captured integration repeats a child')
    scopes.add(key)
    const result = inspectChild(child, prefix, histories, childPins, replay)
    if (!result.ok) return result
  }
  const acceptedPins = new Set(
    item.result.payload.inputs.manifest.acceptedSources.map((pin) => canonicalValueDigest(pin)),
  )
  const expected = new Set([...childPins.keys()].filter((key) => !acceptedPins.has(key)))
  const stages = item.result.payload.inputs.stageSources
  if (
    stages.length !== expected.size ||
    new Set(stages.map((pin) => canonicalValueDigest(pin))).size !== expected.size ||
    stages.some((pin) => !expected.has(canonicalValueDigest(pin)))
  )
    return fail('Captured integration stage sources do not conserve all child proof sources')
  return { ok: true, value: undefined }
}
