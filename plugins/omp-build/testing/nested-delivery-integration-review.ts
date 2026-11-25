import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { type MandateRecord, recordsOf } from '../engine/workflow-control.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { criterionDispositionRecords } from './criterion-dispositions.ts'
import type { IntegrationContext } from './nested-delivery-integration.ts'
import type { AdmittedIntegration } from './nested-delivery-integration-admission.ts'
import { integrationReviewRecords } from './nested-delivery-integration-review-graph.ts'
import type { integrationVerdict } from './nested-delivery-integration-verdict.ts'
import { historicalIntegrationReviewInputs } from './parent-integration-producer.ts'
import { epicReviewGraph } from './record-graphs.ts'

type Graph = ReturnType<typeof epicReviewGraph>

function reviewGraph(scope: Scope, head: string, inputs: ActionInputs) {
  return epicReviewGraph({
    scope,
    head,
    range: `${inputs.manifest.code.base}..${head}`,
    inputs,
    empty: true,
    prefix: `nested-${scope.target}`,
  })
}

function reviewPrefix(
  scope: Scope,
  admitted: AdmittedIntegration,
  graph: Graph,
  row: ReturnType<typeof integrationVerdict>,
) {
  const { decision, records } = integrationReviewRecords(graph, scope, row, admitted)
  const external = admitted.observation.histories.filter((item) => item.source.scope.target !== scope.target)
  const projection = { catalogues: admitted.after.catalogues, acceptedPolicy: null }
  const prefix = encodeCriterionRecords(records, scope, projection, 'operator', external, admitted.parentHistory)
  const bound = recordsOf(prefix.history).find((record) => record.recordId === decision.recordId)
  if (bound?.kind !== 'decision') throw new Error('Review decision unavailable')
  return { external, projection, prefix, bound }
}

type Prefix = ReturnType<typeof reviewPrefix>

function assessReview(admitted: AdmittedIntegration, inputs: ActionInputs, state: Prefix) {
  return criterionDispositionRecords(
    inputs,
    state.bound,
    [state.prefix.history, ...state.external],
    admitted.after.catalogues,
    admitted.observation.graph,
  )
}

function reviewDispositions(scope: Scope, admitted: AdmittedIntegration, inputs: ActionInputs, state: Prefix) {
  const assessed = assessReview(admitted, inputs, state)
  const dispositions = encodeCriterionRecords(
    assessed.dispositions,
    scope,
    state.projection,
    'operator',
    state.external,
    state.prefix.history,
  )
  return { assessed, dispositions }
}
function sealReview(scope: Scope, graph: Graph, state: Prefix, result: ReturnType<typeof reviewDispositions>) {
  const causeDispositionRefs = result.assessed.dispositions.map((item) => ({
    scope,
    kind: 'cause-disposition' as const,
    recordId: item.recordId,
  }))
  const final = { ...graph.review, payload: { ...graph.review.payload, causeDispositionRefs } }
  return encodeCriterionRecords(
    [final],
    scope,
    state.projection,
    'operator',
    state.external,
    result.dispositions.history,
  )
}

export async function publishIntegrationReview(
  context: IntegrationContext,
  scope: Scope,
  head: string,
  mandate: MandateRecord,
  admitted: AdmittedIntegration,
  row: ReturnType<typeof integrationVerdict>,
) {
  const inputs = historicalIntegrationReviewInputs(admitted.after, mandate, admitted.ref, admitted.output)
  const graph = reviewGraph(scope, head, inputs)
  const state = reviewPrefix(scope, admitted, graph, row)
  const result = reviewDispositions(scope, admitted, inputs, state)
  const sealed = sealReview(scope, graph, state, result)
  await context.post(scope, [...state.prefix.comments, ...result.dispositions.comments, ...sealed.comments])
  return inputs
}
