import { readCauseDispositionHeads, resolveCauseSisterReceipt } from '../../engine/cause-disposition.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import { sameScope, scopeKey, type UwGraphObservation } from '../../engine/uw-graph.ts'

function collectMissingSisters(
  scope: Scope,
  histories: readonly DecodedHistory[],
  nodes: ReadonlySet<string>,
  catalogues: ReviewClassCatalogues,
  needed: Map<string, Scope>,
): void {
  const heads = readCauseDispositionHeads({ uw: scope, histories, catalogues })
  if (!heads.ok) return
  for (const disposition of heads.value) {
    const outcome = disposition.payload.outcome
    if (outcome.state !== 'final' || outcome.disposition !== 'sister-blocking') continue
    const receipt = resolveCauseSisterReceipt({ disposition, histories })
    if (!receipt.ok || receipt.value === null) continue
    const sister = receipt.value.payload.sister
    if (!nodes.has(scopeKey(sister))) needed.set(scopeKey(sister), sister)
  }
}

function missingSisters(
  graph: UwGraphObservation,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Map<string, Scope> {
  const nodes = new Set(graph.nodes.map((node) => scopeKey(node.uw)))
  const needed = new Map<string, Scope>()
  for (const node of graph.nodes) collectMissingSisters(node.uw, histories, nodes, catalogues, needed)
  return needed
}

/** Enrich only from authenticated blocking-sister receipts, never from unrelated history. */
export async function observeCauseSisters(
  graph: UwGraphObservation,
  histories: readonly DecodedHistory[],
  read: (scope: Scope) => Promise<UwGraphObservation>,
  catalogues: ReviewClassCatalogues,
): Promise<UwGraphObservation> {
  const nodes = new Map(graph.nodes.map((node) => [scopeKey(node.uw), node]))
  const needed = missingSisters(graph, histories, catalogues)
  const diagnostics = graph.status === 'incomplete' ? [...graph.diagnostics] : []
  let incomplete = graph.status === 'incomplete'
  for (const scope of needed.values()) {
    const observed = await read(scope)
    if (observed.status === 'incomplete') {
      incomplete = true
      diagnostics.push(...observed.diagnostics)
    }
    if (!sameScope(observed.root, scope)) incomplete = true
    for (const node of observed.nodes) {
      const key = scopeKey(node.uw)
      const previous = nodes.get(key)
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(node)) incomplete = true
      else nodes.set(key, node)
    }
  }
  const base = { root: graph.root, nodes: [...nodes.values()] }
  if (incomplete || graph.status === 'incomplete')
    return { ...base, status: 'incomplete', observedAt: graph.observedAt, diagnostics }
  return { ...base, status: 'complete', observedAt: graph.observedAt }
}
