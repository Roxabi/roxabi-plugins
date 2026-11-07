import type { Scope } from '../engine/record-values.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { criterionDispositionRecords } from './criterion-dispositions.ts'
import type { IntegrationContext } from './nested-delivery-integration.ts'
import type { AdmittedIntegration } from './nested-delivery-integration-admission.ts'
import { integrationReviewRecords } from './nested-delivery-integration-review-graph.ts'
import type { integrationVerdict } from './nested-delivery-integration-verdict.ts'
import { epicReviewGraph } from './record-graphs.ts'

async function prepareReview(context: IntegrationContext, scope: Scope, head: string, admitted: AdmittedIntegration) {
  const prepared = await context.world.operations.prepareAction({
    actionId: `nested-${scope.target}-root`,
    purpose: 'review',
    subject: admitted.integrated.payload.inputs.manifest.subject,
    code: { ...admitted.code, referenceCommit: head },
    stageSources: [],
    expandedContext: [],
  })
  if (!prepared.ok) throw new Error(`Fresh nested review preparation refused: ${JSON.stringify(prepared.diagnostics)}`)
  return prepared.value.inputs
}

type ReviewInputs = Awaited<ReturnType<typeof prepareReview>>
type Graph = ReturnType<typeof epicReviewGraph>

function reviewGraph(scope: Scope, head: string, inputs: ReviewInputs) {
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

function assessReview(admitted: AdmittedIntegration, inputs: ReviewInputs, state: Prefix) {
  return criterionDispositionRecords(
    inputs,
    state.bound,
    [state.prefix.history, ...state.external],
    admitted.after.catalogues,
    admitted.observation.graph,
  )
}

function reviewDispositions(scope: Scope, admitted: AdmittedIntegration, inputs: ReviewInputs, state: Prefix) {
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
  admitted: AdmittedIntegration,
  row: ReturnType<typeof integrationVerdict>,
) {
  const inputs = await prepareReview(context, scope, head, admitted)
  const graph = reviewGraph(scope, head, inputs)
  const state = reviewPrefix(scope, admitted, graph, row)
  const result = reviewDispositions(scope, admitted, inputs, state)
  const sealed = sealReview(scope, graph, state, result)
  await context.post(scope, [...state.prefix.comments, ...result.dispositions.comments, ...sealed.comments])
  return inputs
}
