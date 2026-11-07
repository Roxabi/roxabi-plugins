import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { createReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import type { ObservedCommit, UwCompletionObservation, UwDeliveryFacts } from '../../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import { scopeKey, type UwGraphObservation, type UwNativeNode } from '../../engine/uw-graph.ts'
import type { createUwDeliveryFactReader } from './uw-delivery-facts.ts'

/** Retained facts for one observation; neither graph nor history membership grants authority. */
export class UwObservationCut {
  readonly nodes = new Map<string, UwNativeNode>()
  readonly histories = new Map<string, DecodedHistory>()
  readonly delivery = new Map<string, UwDeliveryFacts>()
  readonly diagnostics: UwDiagnostic[] = []
  private readonly graphDiagnostics: UwDiagnostic[] = []
  private observedAt: string | null = null
  catalogues = createReviewClassCatalogues([])

  constructor(readonly root: Scope) {}

  issue(scope: Scope, code: string, message: string): UwDiagnostic {
    return {
      code,
      message,
      location: { kind: 'native', uw: scope, connection: 'state' },
      related: [],
    }
  }

  graphFailure(entry: UwDiagnostic): void {
    this.graphDiagnostics.push(entry)
    this.diagnostics.push(entry)
  }

  addHistory(entry: DecodedHistory): void {
    const key = scopeKey(entry.source.scope)
    const previous = this.histories.get(key)
    if (previous && previous !== entry && JSON.stringify(previous) !== JSON.stringify(entry))
      this.diagnostics.push(
        this.issue(
          entry.source.scope,
          'conflicting-history',
          `Conflicting history for ${entry.source.scope.repository} ${entry.source.scope.target}`,
        ),
      )
    else if (!previous) this.histories.set(key, entry)
  }

  addGraph(graph: UwGraphObservation): void {
    if (this.observedAt === null) this.observedAt = graph.observedAt
    if (graph.status === 'incomplete') {
      if (graph.diagnostics.length) {
        for (const entry of graph.diagnostics) this.graphFailure(entry)
      } else this.graphFailure(this.issue(graph.root, 'graph-incomplete', 'Native graph is incomplete'))
    }
    for (const node of graph.nodes) this.addNode(node)
  }

  private addNode(node: UwNativeNode): void {
    const key = scopeKey(node.uw)
    const previous = this.nodes.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(node))
      this.graphFailure(
        this.issue(
          node.uw,
          'conflicting-native-observation',
          `Conflicting native observation for ${node.uw.repository} ${node.uw.target}`,
        ),
      )
    else if (!previous) this.nodes.set(key, node)
  }

  graph(): UwGraphObservation {
    const root = this.root
    const nodes = [...this.nodes.values()]
    const observedAt = this.observedAt
    return this.graphDiagnostics.length || observedAt === null
      ? { status: 'incomplete', root, nodes, observedAt, diagnostics: this.graphDiagnostics }
      : { status: 'complete', root, nodes, observedAt }
  }

  // These comparisons observe physical ancestry only; they never select a delivery.
  async readAncestry(
    factReader: ReturnType<typeof createUwDeliveryFactReader>,
    deliveryFailed: ReadonlySet<string>,
  ): Promise<void> {
    for (const parent of this.nodes.values()) {
      const key = scopeKey(parent.uw)
      const facts = this.delivery.get(key)
      if (facts === undefined || deliveryFailed.has(key) || facts.integrations.length === 0) continue
      const ancestors = this.childAncestors(parent)
      await this.readParentAncestry(parent.uw, key, facts, ancestors, factReader)
    }
  }

  private childAncestors(parent: UwNativeNode): ObservedCommit['code'][] {
    const ancestors: ObservedCommit['code'][] = []
    for (const child of parent.children) {
      const childFacts = this.delivery.get(scopeKey(child))
      if (childFacts === undefined || child.repository !== parent.uw.repository) continue
      this.appendChildAncestors(ancestors, parent.uw, childFacts)
    }
    return ancestors
  }

  private appendChildAncestors(ancestors: ObservedCommit['code'][], parent: Scope, childFacts: UwDeliveryFacts): void {
    for (const pull of childFacts.pullRequests)
      if (pull.state === 'MERGED' && pull.mergeCommit !== null && pull.pullRequest.repository === parent.repository)
        ancestors.push({ repository: parent.repository, commit: pull.mergeCommit })
    for (const integration of childFacts.integrations)
      if (integration.code.repository === parent.repository)
        ancestors.push({ repository: parent.repository, commit: integration.code.head })
  }

  private async readParentAncestry(
    parent: Scope,
    key: string,
    facts: UwDeliveryFacts,
    ancestors: readonly ObservedCommit['code'][],
    factReader: ReturnType<typeof createUwDeliveryFactReader>,
  ): Promise<void> {
    for (const integration of facts.integrations) {
      if (ancestors.length === 0) continue
      const observed = await factReader.readAncestry({
        uw: parent,
        head: { repository: integration.code.repository, commit: integration.code.head },
        ancestors,
      })
      const extra = observed.ok ? observed.value : observed.partial
      const known: Set<string> = new Set(facts.commits.map((commit) => commit.code.commit))
      const added: ObservedCommit[] = extra.filter((commit) => !known.has(commit.code.commit))
      if (added.length) {
        facts = { ...facts, commits: [...facts.commits, ...added] }
        this.delivery.set(key, facts)
      }
      if (!observed.ok) {
        this.diagnostics.push(...observed.diagnostics.map((entry) => this.issue(parent, entry.code, entry.message)))
        break
      }
    }
  }

  finish(additionalHistories: readonly DecodedHistory[]): UwCompletionObservation {
    this.verifySelectedHistories(additionalHistories)
    const root = this.root
    const facts = {
      root,
      histories: [...this.histories.values()],
      catalogues: this.catalogues,
      delivery: [...this.delivery.values()],
    }
    if (this.diagnostics.length || this.observedAt === null) {
      if (!this.diagnostics.length)
        this.diagnostics.push(this.issue(root, 'graph-incomplete', 'Native graph has no observation time'))
      return {
        ...facts,
        status: 'incomplete',
        graph: this.graph(),
        diagnostics: this.diagnostics as [UwDiagnostic, ...UwDiagnostic[]],
      }
    }
    return {
      ...facts,
      status: 'complete',
      graph: { status: 'complete', root, nodes: [...this.nodes.values()], observedAt: this.observedAt },
    }
  }

  private verifySelectedHistories(additionalHistories: readonly DecodedHistory[]): void {
    for (const expected of additionalHistories) {
      const observed = this.histories.get(scopeKey(expected.source.scope))
      if (!expected.source.complete || observed === undefined || JSON.stringify(expected) !== JSON.stringify(observed))
        this.diagnostics.push(
          this.issue(expected.source.scope, 'conflicting-history', 'Selected history changed during joint observation'),
        )
    }
  }
}
