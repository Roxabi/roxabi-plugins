import { causeHistoryReferences } from '../../engine/cause-disposition.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import type { UwCompletionObservation } from '../../engine/uw-completion-types.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { projectUwWaits } from '../../engine/uw-waits.ts'
import type { GitHubOptions } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph-reader.ts'
import { readComposedWorkflowHistory } from './history.ts'
import { createUwDeliveryFactReader } from './uw-delivery-facts.ts'
import { UwObservationCut } from './uw-observation-cut.ts'

type FramingReceiptPayload = Extract<
  NonNullable<DecodedHistory['operations'][number]['record']>,
  { kind: 'framing-receipt' }
>['payload']

/** Native issues a framing receipt names: intent members, claimed members, and result members. */
function receiptScopes(payload: FramingReceiptPayload): Scope[] {
  if (payload.phase === 'intent')
    return payload.proposal.members.flatMap((member) => (member.slot.kind === 'existing' ? [member.slot.uw] : []))
  if (payload.phase === 'member-claim') return [payload.scope]
  if (payload.phase === 'result') return payload.members.map((member) => member.scope)
  return []
}

function framingMemberScopes(history: DecodedHistory): Scope[] {
  return history.operations.flatMap((operation) => {
    const record = operation.status === 'complete' && operation.authority !== 'foreign' ? operation.record : null
    return record?.kind === 'framing-receipt' ? receiptScopes(record.payload) : []
  })
}

/**
 * One bounded observation; no fact here grants delivery or dependency authority.
 * Catalogue loading must consume retained histories read-only, including nested values.
 */
export async function readUwCompletionObservation(
  root: Scope,
  options: GitHubOptions,
  loadCatalogues: (histories: readonly DecodedHistory[]) => Promise<ReviewClassCatalogues>,
  additionalScopes: readonly Scope[] = [],
  additionalHistories: readonly DecodedHistory[] = [],
): Promise<UwCompletionObservation> {
  const collector = new UwObservationCollector(root, options, loadCatalogues, additionalScopes, additionalHistories)
  return collector.read()
}

class UwObservationCollector {
  private readonly cut: UwObservationCut
  private readonly graphSeen = new Set<string>()
  private readonly historySeen = new Set<string>()
  private readonly deliverySeen = new Map<string, number>()
  private readonly deliveryFailed = new Set<string>()
  private readonly pendingGraph: Map<string, Scope>
  private readonly evaluationRoots: Scope[]
  private readonly factReader: ReturnType<typeof createUwDeliveryFactReader>

  constructor(
    root: Scope,
    private readonly options: GitHubOptions,
    private readonly loadCatalogues: (histories: readonly DecodedHistory[]) => Promise<ReviewClassCatalogues>,
    additionalScopes: readonly Scope[],
    private readonly additionalHistories: readonly DecodedHistory[],
  ) {
    this.cut = new UwObservationCut(root)
    this.factReader = createUwDeliveryFactReader(options)
    this.pendingGraph = new Map([[scopeKey(root), root]])
    for (const scope of additionalScopes) this.pendingGraph.set(scopeKey(scope), scope)
    // Additional roots request facts; only actual native or canonical records establish edges.
    this.evaluationRoots = [...this.pendingGraph.values()]
  }

  async read(): Promise<UwCompletionObservation> {
    while (true) {
      await this.readGraphs()
      let progressed = await this.readHistories()
      if (!(await this.refreshCatalogues())) break
      const waits = projectUwWaits({
        graph: this.cut.graph(),
        histories: [...this.cut.histories.values()],
        catalogues: this.cut.catalogues,
        evaluationRoots: this.evaluationRoots,
      })
      this.requireGraphs(waits.requiredScopes)
      // Finish native and typed-history closure before requesting any completion dossier.
      if (this.pendingGraph.size > 0 || progressed) continue
      progressed = await this.readDeliveries(waits.deliveryScopes)
      if (this.pendingGraph.size === 0 && !progressed) break
    }
    await this.cut.readAncestry(this.factReader, this.deliveryFailed)
    return this.cut.finish(this.additionalHistories)
  }

  private async readGraphs(): Promise<void> {
    for (const [key, scope] of this.pendingGraph) {
      this.pendingGraph.delete(key)
      if (this.graphSeen.has(key) || this.cut.nodes.has(key)) continue
      this.graphSeen.add(key)
      try {
        const graph = await readUwGraph(scope, this.options)
        if (scopeKey(graph.root) !== key)
          this.cut.graphFailure(this.cut.issue(scope, 'graph-root-mismatch', 'Native graph returned a different root'))
        this.cut.addGraph(graph)
      } catch (error) {
        this.cut.graphFailure(this.cut.issue(scope, 'graph-unreadable', `Cannot read graph: ${String(error)}`))
      }
    }
  }

  private historyScopes(): Map<string, Scope> {
    const wanted = new Map<string, Scope>()
    for (const history of this.additionalHistories) wanted.set(scopeKey(history.source.scope), history.source.scope)
    for (const node of this.cut.nodes.values()) wanted.set(scopeKey(node.uw), node.uw)
    const records = [...this.cut.histories.values()].flatMap((history) =>
      history.operations.flatMap((operation) =>
        operation.status === 'complete' && operation.record !== null ? [operation.record] : [],
      ),
    )
    for (const ref of causeHistoryReferences(records)) wanted.set(scopeKey(ref.scope), ref.scope)
    return wanted
  }

  private async readHistories(): Promise<boolean> {
    let progressed = false
    for (const [key, scope] of this.historyScopes()) {
      if (this.historySeen.has(key) || this.cut.histories.has(key)) continue
      this.historySeen.add(key)
      progressed = true
      await this.readHistory(scope)
    }
    return progressed
  }

  private async readHistory(scope: Scope): Promise<void> {
    const observed = await readComposedWorkflowHistory([scope], this.options)
    for (const history of observed.histories) this.cut.addHistory(history)
    // Framing can bind disconnected members: canonical references establish which
    // native issues must be observed, but never manufacture relations between them.
    for (const history of observed.histories) this.requireGraphs(framingMemberScopes(history))
    if (!observed.ok)
      this.cut.diagnostics.push(
        ...observed.diagnostics.map((entry) => this.cut.issue(scope, entry.code, entry.message)),
      )
  }

  private async refreshCatalogues(): Promise<boolean> {
    try {
      this.cut.catalogues = await this.loadCatalogues([...this.cut.histories.values()])
      return true
    } catch (error) {
      this.cut.diagnostics.push(
        this.cut.issue(this.cut.root, 'catalogue-unreadable', `Cannot load review catalogues: ${String(error)}`),
      )
      return false
    }
  }

  private requireGraphs(scopes: readonly Scope[]): void {
    for (const scope of scopes) {
      const key = scopeKey(scope)
      if (!this.cut.nodes.has(key) && !this.graphSeen.has(key)) this.pendingGraph.set(key, scope)
    }
  }

  private async readDeliveries(scopes: readonly Scope[]): Promise<boolean> {
    let progressed = false
    for (const scope of scopes) {
      const key = scopeKey(scope)
      if (this.deliveryFailed.has(key)) continue
      // Histories stay value-stable and append-only in this cut; new scopes invalidate reads.
      const historyRevision = this.cut.histories.size
      if (this.deliverySeen.get(key) === historyRevision) continue
      this.deliverySeen.set(key, historyRevision)
      progressed = true
      await this.readDelivery(scope, key)
    }
    return progressed
  }

  private async readDelivery(scope: Scope, key: string): Promise<void> {
    try {
      const observed = await this.factReader.read(scope, [...this.cut.histories.values()])
      if (!observed.ok) {
        this.deliveryFailed.add(key)
        this.cut.diagnostics.push(
          ...observed.diagnostics.map((entry) => this.cut.issue(scope, entry.code, entry.message)),
        )
        this.cut.delivery.set(key, observed.partial.facts)
        for (const history of observed.partial.histories) this.cut.addHistory(history)
      } else {
        this.cut.delivery.set(key, observed.value.facts)
        for (const history of observed.value.histories) this.cut.addHistory(history)
      }
    } catch (error) {
      this.deliveryFailed.add(key)
      this.cut.diagnostics.push(
        this.cut.issue(scope, 'delivery-unreadable', `Cannot read delivery facts: ${String(error)}`),
      )
    }
  }
}
