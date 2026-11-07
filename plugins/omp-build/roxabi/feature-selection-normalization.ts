import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import type { NormalizationProposalRequest, UwRead } from './uw-contract.ts'
import { markSuccessorNormalization } from './uw-normalization-internal.ts'

function needsInitialSpec(control: FeatureControl, selection: FeatureAuthority['selection']): boolean {
  if (selection.status !== 'refused') return false
  if (selection.reason === 'missing') return control === 'select' || control === 'continue'
  return control === 'new' && (selection.reason === 'abandoned' || selection.reason === 'revoked')
}

export function selectionNormalization(
  control: FeatureControl,
  authority: Pick<FeatureAuthority, 'scope' | 'selection'>,
  read: UwRead | null,
): ContinueFeatureResult | null {
  const held = read?.admission.aggregate
  if (held?.status === 'held') return { kind: 'blocked', reason: held.code, diagnostics: held.diagnostics }
  if (!needsInitialSpec(control, authority.selection)) return null
  if (read === null) return { kind: 'blocked', reason: 'uw-read-required' }
  if (control !== 'new') return initialFramingSelection(authority.scope, read)
  return successorNormalization(authority.scope, read)
}

function initialFramingSelection(scope: FeatureAuthority['scope'], read: UwRead): ContinueFeatureResult | null {
  const aggregate = read.admission.aggregate
  if (!read.identity.ok)
    return { kind: 'blocked', reason: 'uw-identities-unconfirmed', diagnostics: read.identity.diagnostics }
  if (read.graph.status !== 'complete')
    return { kind: 'blocked', reason: 'graph-incomplete', diagnostics: read.graph.diagnostics }
  if (!read.graph.nodes.some((node) => node.uw.repository === scope.repository && node.uw.target === scope.target))
    return { kind: 'blocked', reason: 'graph-root-missing' }
  if (read.parsed.status !== 'conformant') return { kind: 'framing', source: { kind: 'issue', uw: scope } }
  const diagnostics = read.admission.framed.diagnostics
  if (diagnostics.length === 0) return null
  const incomplete: Record<string, true> = { 'criteria-missing': true, 'open-question': true, 'tier-missing': true }
  const problem = diagnostics.find((entry) => incomplete[entry.code] !== true)
  if (problem !== undefined) return { kind: 'blocked', reason: problem.code, diagnostics }
  if (aggregate?.status === 'none') return { kind: 'framing', source: { kind: 'issue', uw: scope } }
  return { kind: 'blocked', reason: diagnostics[0].code, diagnostics }
}

function successorNormalization(scope: FeatureAuthority['scope'], read: UwRead): ContinueFeatureResult | null {
  const root = read.graph.nodes.find(
    (node) => node.uw.repository === scope.repository && node.uw.target === scope.target,
  )
  if (root === undefined) return { kind: 'blocked', reason: 'graph-root-missing' }
  if (read.parsed.status === 'conformant') return null
  const request: NormalizationProposalRequest = {
    uw: scope,
    title: root.title,
    parsed: read.parsed,
    graph: read.graph,
    writes: {
      labels: { add: [], remove: [] },
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
  }
  markSuccessorNormalization(request, read)
  return { kind: 'normalization', request }
}
