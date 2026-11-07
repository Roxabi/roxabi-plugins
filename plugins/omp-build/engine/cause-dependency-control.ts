import { canonicalValueDigest } from './action-input.ts'
import type { PinnedFileRef } from './action-input-schema.ts'
import { resolveAdjudicationSources } from './cause-adjudication-sources.ts'
import type { CauseDependencyAdjustmentProposal } from './cause-dependency-adjustment-schema.ts'
import type { Ref } from './cause-disposition.ts'
import { resolveCauseSisterReceipt } from './cause-reports.ts'
import type { ObservationRef } from './criterion-evidence-schema.ts'
import { citedOperationIntegrity, observationRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { CauseWaitResolution } from './uw-completion-types.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'
import { resolveAcceptedSpecAt } from './workflow-accepted-spec.ts'
import { bindExternalRef, historyFor, recordsOf } from './workflow-control.ts'

type Control = Extract<CanonicalRecord, { kind: 'operator-control' }> & {
  payload: Extract<
    Extract<CanonicalRecord, { kind: 'operator-control' }>['payload'],
    { control: 'adjust-cause-dependency' }
  >
}
export function causeDependencyControlDigest(payload: Control['payload']): string {
  return canonicalValueDigest(payload.proposal)
}

/** Reconstruct only the expressly authorized blocker delta; every other native fact is sealed. */
export function causeAdjustmentExpectedEffect(
  proposal: CauseDependencyAdjustmentProposal,
  target: Scope,
): NativeIssueObservation | null {
  const { before, nativeEffect, change } = proposal
  const scopeOf = (ref: NativeIssueObservation['issue']): Scope => ({
    repository: ref.repository,
    target: `${ref.repository}#${ref.number}`,
  })
  const key = (scope: Scope) => `${scope.repository}\0${scope.target}`
  const parse = (scope: Scope) => {
    const prefix = `${scope.repository}#`
    const suffix = scope.target.startsWith(prefix) ? scope.target.slice(prefix.length) : ''
    const number = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : NaN
    return Number.isSafeInteger(number) && number > 0 ? { repository: scope.repository, number } : null
  }
  if (
    !equalScope(scopeOf(before.issue), proposal.origin) ||
    nativeObservationDigest(before) !== proposal.nativeObservationDigest
  )
    return null
  const blockers = new Map(before.blockers.map((ref) => [key(scopeOf(ref)), ref]))
  if (blockers.size !== before.blockers.length) return null
  if (nativeEffect.kind === 'update-blockers') {
    const remove = new Set(nativeEffect.remove.map(key))
    const add = new Set(nativeEffect.add.map(key))
    if (
      remove.size + add.size === 0 ||
      remove.size !== nativeEffect.remove.length ||
      add.size !== nativeEffect.add.length ||
      nativeEffect.remove.some((scope) => !equalScope(scope, target) || !blockers.has(key(scope))) ||
      nativeEffect.add.some(
        (scope) =>
          change.kind !== 'replace' ||
          !equalScope(scope, change.blocker) ||
          blockers.has(key(scope)) ||
          parse(scope) === null,
      ) ||
      [...remove].some((value) => add.has(value))
    )
      return null
    for (const scope of nativeEffect.remove) blockers.delete(key(scope))
    for (const scope of nativeEffect.add) {
      const ref = parse(scope)
      if (ref === null) return null
      blockers.set(key(scope), ref)
    }
  }
  return { ...before, blockers: [...blockers.values()] }
}

/** File citations must come from an authenticated producer capture, never caller-supplied pins. */
export function causeAdjustmentReferencesValid(
  references: readonly ObservationRef[],
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  histories: readonly DecodedHistory[],
): boolean {
  let pins: PinnedFileRef[] = []
  if (references.some((ref) => ref.source === 'git-file')) {
    const effective = resolveSpecEffective({
      mode: 'historical',
      own: disposition.payload.origin,
      versionVector: disposition.payload.basis.versionVector,
      histories,
    })
    if (!effective.ok) return false
    const sources = resolveAdjudicationSources({
      pending: disposition,
      histories,
      context: { original: disposition.payload.origin.uw, effective: effective.value },
    })
    if (!sources.ok) return false
    pins = sources.value.flatMap((entry) => [
      ...entry.manifest.repositoryReferences,
      ...entry.manifest.plugin.files,
      ...entry.manifest.expandedContext.filter((item): item is PinnedFileRef => item.source === 'git-file'),
    ])
  }
  return (
    new Set(references.map(canonicalValueDigest)).size === references.length &&
    references.every((ref) => observationRefDiagnostics('cause-adjustment', ref, histories, pins).length === 0)
  )
}
/** Authenticate the complete control chain; native edges remain independent obligations. */
export function resolveCauseDependencyControl(input: {
  origin: Scope
  disposition: Ref<'cause-disposition'>
  receipt: Ref<'debt-receipt'>
  target: Scope
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  catalogues: ReviewClassCatalogues
}): CauseWaitResolution {
  const base = { origin: input.origin, disposition: input.disposition, receipt: input.receipt }
  const held = (message: string): CauseWaitResolution => ({
    ...base,
    state: 'held',
    diagnostics: [
      {
        code: 'cause-dependency-control-unconfirmed',
        message,
        location: { kind: 'record', ref: input.receipt },
        related: [],
      },
    ],
  })
  const history = historyFor(input.origin, input.histories)
  if (!history?.source.complete || input.graph.status !== 'complete')
    return held('Complete origin history and graph are required')
  if (
    history.operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'operator-control' || operation.claimedKinds.includes('operator-control')) &&
        (operation.status !== 'complete' || operation.record === null),
    )
  )
    return held('An incomplete or invalid expected-author operator-control claim prevents control resolution')
  const disposition = bindExternalRef(input.disposition, history)
  const receipt = bindExternalRef(input.receipt, history)
  if (
    !disposition.ok ||
    !receipt.ok ||
    disposition.value.kind !== 'cause-disposition' ||
    receipt.value.kind !== 'debt-receipt'
  )
    return held('Disposition and receipt must both be authenticated in the origin history')
  const sister = resolveCauseSisterReceipt({ disposition: disposition.value, histories: input.histories })
  if (
    !sister.ok ||
    sister.value === null ||
    sister.value.recordId !== receipt.value.recordId ||
    !equalScope(sister.value.payload.sister, input.target) ||
    !sameRef(receipt.value.payload.disposition, input.disposition)
  )
    return held('The receipt is not the authenticated sister effect of this disposition')
  const controls = recordsOf(history).filter(
    (record): record is Control =>
      record.kind === 'operator-control' &&
      record.payload.control === 'adjust-cause-dependency' &&
      sameRef(record.payload.proposal.disposition, input.disposition) &&
      sameRef(record.payload.proposal.receipt, input.receipt),
  )
  if (controls.length === 0) return { ...base, state: 'required', target: input.target, control: null }
  return resolveControlChain(input, history, disposition.value, controls, base, held)
}

function resolveControlChain(
  input: Parameters<typeof resolveCauseDependencyControl>[0],
  history: DecodedHistory,
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  controls: Control[],
  base: { origin: Scope; disposition: Ref<'cause-disposition'>; receipt: Ref<'debt-receipt'> },
  held: (message: string) => CauseWaitResolution,
): CauseWaitResolution {
  const used = new Set<string>()
  let predecessor: Ref<'debt-receipt'> | Ref<'operator-control'> = input.receipt
  let target = input.target
  let last: Ref<'operator-control'> | null = null
  let withdrawn = false
  while (true) {
    const next = controls.filter((item) => sameRef(item.payload.proposal.predecessor, predecessor))
    if (next.length > 1) return held('Competing dependency controls share a predecessor')
    const control = next[0]
    if (control === undefined) break
    if (used.has(control.recordId)) return held('Dependency control chain contains a cycle')
    used.add(control.recordId)
    const ref: Ref<'operator-control'> = { scope: input.origin, kind: 'operator-control', recordId: control.recordId }
    const bound = bindExternalRef(ref, history)
    const payload = control.payload
    const proposal = payload.proposal
    const mandate = bindExternalRef(proposal.mandate, history)
    const historical = resolveSpecEffective({
      mode: 'historical',
      own: proposal.accepted,
      versionVector: proposal.versionVector,
      histories: input.histories,
    })
    const expected = causeAdjustmentExpectedEffect(proposal, target)
    const histories = new Set(proposal.histories.map((entry) => `${entry.scope.repository}\0${entry.scope.target}`))
    const nodes = new Set(proposal.nativeGraph.rows.map((entry) => `${entry.uw.repository}\0${entry.uw.target}`))
    const originNative = proposal.nativeGraph.rows.filter((entry) => equalScope(entry.uw, input.origin))
    if (
      !bound.ok ||
      citedOperationIntegrity(history, control.recordId) !== null ||
      !mandate.ok ||
      mandate.value.kind !== 'mandate' ||
      !equalScope(proposal.mandate.scope, input.origin) ||
      !resolveAcceptedSpecAt(mandate.value, input.histories, proposal.accepted).ok ||
      !equalScope(proposal.origin, input.origin) ||
      !equalScope(proposal.accepted.uw, input.origin) ||
      !historical.ok ||
      proposal.controlId !== control.recordId ||
      proposal.operationId !== control.operationId ||
      payload.confirmation.operationId !== control.operationId ||
      payload.confirmation.proposalDigest !== payload.proposalDigest ||
      causeDependencyControlDigest(payload) !== payload.proposalDigest ||
      histories.size !== proposal.histories.length ||
      !histories.has(`${input.origin.repository}\0${input.origin.target}`) ||
      !equalScope(proposal.nativeGraph.root, input.origin) ||
      nodes.size !== proposal.nativeGraph.rows.length ||
      originNative.length !== 1 ||
      originNative[0]?.digest !== proposal.nativeObservationDigest ||
      !causeAdjustmentReferencesValid(proposal.references, disposition, input.histories) ||
      expected === null ||
      nativeObservationDigest(expected) !== nativeObservationDigest(payload.execution.observed)
    )
      return held(
        'Dependency control lacks authenticated historical authority, confirmation, references or exact native effect',
      )
    withdrawn = proposal.change.kind === 'withdraw'
    if (proposal.change.kind === 'replace') target = proposal.change.blocker
    predecessor = ref
    last = ref
  }
  if (used.size !== controls.length || last === null)
    return held('Dependency control does not continue the unique receipt chain')
  return withdrawn
    ? { ...base, state: 'withdrawn', control: last }
    : { ...base, state: 'required', target, control: last }
}
