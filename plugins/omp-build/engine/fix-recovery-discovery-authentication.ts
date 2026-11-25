import { canonicalValueDigest } from './action-input.ts'
import type { FixRecoveryDiscoveryInput, HistoricalDiscoveryInput } from './fix-recovery-discovery.ts'
import { asOpenedRef, type OwnerPair } from './fix-recovery-discovery-records.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveSpecEffective, resolveSpecEffectiveAtGraph } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { bindingMatchesMandate, usesLegacyBindingFormat } from './workflow-binding-format.ts'
import {
  bindExternalRef,
  type MandateRecord,
  type WorkflowBindingRecord,
  workflowOperationProblem,
} from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import { isHistoricalContinuationControl } from './workflow-pause.ts'
import { confirmedAccountedMandate } from './workflow-pr-binding.ts'
import { resolveBindingChain } from './workflow-pr-binding-chain.ts'

const refuse = (message: string) => diagnostic('unconfirmed', message)
type DiscoveryInput = FixRecoveryDiscoveryInput | HistoricalDiscoveryInput
type OwnerCommon = OwnerPair['opened']['payload']['common']

function authenticateAnchors(pair: OwnerPair, home: DecodedHistory): Diagnostic | null {
  for (const operation of home.operations) {
    if (
      operation.authority === 'foreign' ||
      operation.record === null ||
      (operation.record.kind !== 'mandate' && operation.record.kind !== 'operator-control') ||
      isHistoricalContinuationControl(operation.record)
    )
      continue
    const record = operation.record
    if (!bindExternalRef({ kind: record.kind, scope: home.source.scope, recordId: record.recordId }, home).ok)
      return refuse('Recorded mandate or control source is not authenticated')
  }
  for (const anchor of [pair.opened, pair.settled]) {
    const bound = bindExternalRef(asOpenedRef(anchor), home)
    if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(anchor))
      return refuse('Owner lifecycle anchor is not uniquely authenticated')
  }
  return null
}

function authenticateBindingRecord(
  binding: WorkflowBindingRecord,
  common: OwnerCommon,
  pr: DecodedHistory,
  histories: readonly DecodedHistory[],
): Diagnostic | null {
  const bound = bindExternalRef({ kind: 'workflow-binding', scope: common.pullRequest, recordId: binding.recordId }, pr)
  const mandateHome = histories.find((history) => equalScope(history.source.scope, binding.payload.mandate.scope))
  if (!bound.ok || mandateHome === undefined || workflowOperationProblem(mandateHome) !== null)
    return refuse('Binding or its mandate history is not authenticated')
  const boundMandate = bindExternalRef(binding.payload.mandate, mandateHome)
  const bindingMandate = confirmedAccountedMandate(mandateHome, binding.payload.mandate)
  if (!boundMandate.ok || bindingMandate === null) return refuse('Binding mandate is not authenticated')
  if (
    !usesLegacyBindingFormat(bindingMandate) &&
    !bindingMatchesMandate(bindingMandate, binding.payload.branch, binding.payload.base)
  )
    return refuse('Recorded binding branch or base differs from its mandate')
  return null
}

function authenticateBinding(
  common: OwnerCommon,
  pr: DecodedHistory,
  histories: readonly DecodedHistory[],
): Diagnostic | null {
  const bindingClaims = pr.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.kind === 'workflow-binding' ||
        operation.claimedKinds.includes('workflow-binding') ||
        operation.record?.kind === 'workflow-binding'),
  )
  const bindings: WorkflowBindingRecord[] = []
  for (const operation of bindingClaims) {
    if (
      operation.status !== 'complete' ||
      operation.authority !== 'accounted' ||
      operation.record?.kind !== 'workflow-binding'
    )
      return refuse('A recorded binding claim is incomplete or unaccounted')
    const binding = operation.record
    const problem = authenticateBindingRecord(binding, common, pr, histories)
    if (problem !== null) return problem
    bindings.push(binding)
  }
  if (bindings.length === 0) return refuse('No authenticated recorded binding')
  const chain = resolveBindingChain(bindings, histories)
  if (
    chain.status !== 'bound' ||
    chain.binding.recordId !== common.binding.recordId ||
    !sameRef(chain.binding.payload.mandate, common.mandate)
  )
    return refuse('Recorded binding is not the unique current association')
  return null
}

function authenticateSpec(
  input: DiscoveryInput,
  common: OwnerCommon,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): Diagnostic | null {
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) return refuse('Latest accepted Spec chain cannot be authenticated')
  const effective =
    'accepted' in input
      ? resolveSpecEffectiveAtGraph(
          { mode: 'historical', own: accepted.spec.ref, histories, versionVector: input.accepted.versionVector },
          input.graph,
        )
      : resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories, graph: input.graph })
  if (!effective.ok) return refuse('Current effective Spec cannot be authenticated from the native graph')
  for (const ref of [
    ...accepted.spec.sourceRefs,
    ...effective.value.versionVector.map((entry) => entry.sourceAccepted),
  ]) {
    const source = histories.find((history) => equalScope(history.source.scope, ref.scope))
    if (source === undefined || !bindExternalRef(ref, source).ok)
      return refuse('An accepted Spec source is missing or no longer immutable')
  }
  const digest = canonicalValueDigest(effective.value)
  if (digest !== common.acceptedDigest || digest !== canonicalValueDigest(common.accepted))
    return refuse('Current effective Spec does not match the opening')
  if ('accepted' in input && digest !== canonicalValueDigest(input.accepted))
    return refuse('Historical effective Spec does not match the recorded observation')
  return null
}

function mandateAuthorityProblem(current: MandateRecord, histories: readonly DecodedHistory[]): Diagnostic | null {
  const home = histories.find((history) => equalScope(history.source.scope, current))
  if (home === undefined || !home.source.complete || workflowOperationProblem(home) !== null)
    return refuse('Mandate authority history is missing or incomplete')
  for (const operation of home.operations) {
    if (
      operation.authority === 'foreign' ||
      operation.record?.kind !== 'operator-control' ||
      isHistoricalContinuationControl(operation.record)
    )
      continue
    if (
      !bindExternalRef(
        { kind: 'operator-control', scope: home.source.scope, recordId: operation.record.recordId },
        home,
      ).ok
    )
      return refuse('Mandate control source is not authenticated')
  }
  return null
}

function authenticateParentMandate(
  parent: NonNullable<MandateRecord['payload']['parent']>,
  histories: readonly DecodedHistory[],
): { mandate: MandateRecord } | { problem: Diagnostic } {
  const parentHome = histories.find((history) => equalScope(history.source.scope, parent.scope))
  if (parentHome === undefined || !parentHome.source.complete || workflowOperationProblem(parentHome) !== null)
    return { problem: refuse('Parent mandate authority history is missing or incomplete') }
  const bound = bindExternalRef(parent, parentHome)
  const selected = selectedMandate(parentHome)
  if (
    !bound.ok ||
    bound.value.kind !== 'mandate' ||
    'status' in selected ||
    selected.recordId !== parent.recordId ||
    canonicalValueDigest(bound.value) !== canonicalValueDigest(selected)
  )
    return { problem: refuse('Parent mandate authority is not authenticated') }
  return { mandate: selected }
}

function authenticateMandateAuthority(mandate: MandateRecord, histories: readonly DecodedHistory[]): Diagnostic | null {
  const seen = new Set<string>()
  let current = mandate
  while (true) {
    const key = `${current.repository}\0${current.target}\0${current.recordId}`
    if (seen.has(key)) return refuse('Mandate parent chain cycles')
    seen.add(key)
    const problem = mandateAuthorityProblem(current, histories)
    if (problem !== null) return problem
    const parent = current.payload.parent
    if (parent === null) return null
    const result = authenticateParentMandate(parent, histories)
    if ('problem' in result) return result.problem
    current = result.mandate
  }
}

export function authenticateSourceBasis(
  input: DiscoveryInput,
  pair: OwnerPair,
  histories: readonly DecodedHistory[],
): Diagnostic | null {
  const common = pair.opened.payload.common
  if (
    common.host.admission.destinationDigest !==
    canonicalValueDigest([
      common.destination.authority,
      common.destination.publicationRepository,
      common.destination.destinationRef,
    ])
  )
    return refuse('Owner admission descriptor does not bind its destination')
  if (!equalScope(input.uw, common.uw)) return refuse('Opening belongs to another UW')
  const home = histories.find((history) => equalScope(history.source.scope, common.uw))
  const pr = histories.find((history) => equalScope(history.source.scope, common.pullRequest))
  if (home === undefined || pr === undefined || !home.source.complete || !pr.source.complete)
    return refuse('Required UW or pull request history is missing or incomplete')
  if (workflowOperationProblem(home) !== null || workflowOperationProblem(pr) !== null)
    return refuse('Recorded workflow authority contains an unresolved claim')
  const anchorProblem = authenticateAnchors(pair, home)
  if (anchorProblem !== null) return anchorProblem
  const selected = selectedMandate(home)
  if (
    'status' in selected ||
    selected.recordId !== common.mandate.recordId ||
    !equalScope(selected, common.mandate.scope)
  )
    return refuse('Recorded mandate has changed or is ambiguous')
  const mandateBound = bindExternalRef(common.mandate, home)
  const mandate = confirmedAccountedMandate(home, common.mandate)
  if (
    !mandateBound.ok ||
    mandate === null ||
    canonicalValueDigest(mandateBound.value) !== canonicalValueDigest(selected)
  )
    return refuse('Current recorded mandate is not an authenticated accounted source')
  const config = mandate.payload.config
  if (
    common.configuration.version !== config.version ||
    common.configuration.digest !== config.digest ||
    common.configuration.serialized !== JSON.stringify(config.effective)
  )
    return refuse('Opening configuration does not match its recorded mandate')
  const bindingProblem = authenticateBinding(common, pr, histories)
  if (bindingProblem !== null) return bindingProblem
  const specProblem = authenticateSpec(input, common, mandate, histories)
  if (specProblem !== null) return specProblem
  return authenticateMandateAuthority(mandate, histories)
}
