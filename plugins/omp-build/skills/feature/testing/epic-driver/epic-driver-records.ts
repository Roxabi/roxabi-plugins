import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type CanonicalRecord,
  canonicalSpec,
  decodeHistory,
  type History,
  type Json,
  renderIssueSpecBody,
} from '../../../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../../../engine/action-input.ts'
import { buildRecord } from '../../../../engine/record-construction.ts'
import type { Scope } from '../../../../engine/record-values.ts'
import { resolveSpecEffective } from '../../../../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../../../../engine/workflow-accepted-spec.ts'
import { acceptedActionInputs } from '../../../../testing/action-input-fixtures.ts'
import { committedFixturePlugin, committedFixtureProjection } from '../../../../testing/committed-plugin-fixture.ts'
import { encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { criterionDispositionRecords, graphFromSimulatedIssues } from '../../../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { epicReviewGraph } from '../../../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { blockingReviewRecords } from './epic-driver-blocking-review.ts'
import { readEpicFixtureIssues } from './epic-driver-native-graph.ts'
import { type EpicParentWorld, prepareEpicParentReview } from './epic-driver-parent-review.ts'
import { git, sandboxOf } from './epic-driver-sandbox.ts'

const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { framedBodies } = roxabiWorkflowFixtures()

export const RUN = 'run00001'
export const ME = 'operator'

export type Comment = { body: string; author: string }
export function strictSpecBody(statement: string): string {
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(`fixture Spec rejected: ${canonical.diagnostics.map((d) => d.code).join(',')}`)
  return renderIssueSpecBody(canonical.value, { complexity: 1 })
}

export function recordHistory(issue: number, comments: Comment[] = []): History {
  return {
    scope: { repository: 'o/r', target: `o/r#${issue}` },
    expectedAuthor: ME,
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `o/r#${issue}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: '2026-10-21T10:00:00Z',
    })),
    diagnostics: [],
  }
}
export function framedRecords(issue: number, records: CanonicalRecord[]): Comment[] {
  if (records.some((record) => record.repository !== 'o/r' || record.target !== `o/r#${issue}`))
    throw new Error(`fixture record does not belong to o/r#${issue}`)
  return framedBodies(records, ME, [], TEST_PROJECTION_CONFIG).map((body) => ({ body, author: ME }))
}

export function epicEvent(
  issue: number,
  id: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
): CanonicalRecord {
  return {
    version: 1,
    recordId: id,
    runId: RUN,
    operationId: `op-${id}`,
    inputs,
    repository: 'o/r',
    target: `o/r#${issue}`,
    kind: 'epic-event',
    payload,
  }
}

export function issueComments(issue: number): Comment[] {
  const raw = JSON.parse(readFileSync(path.join(sandboxOf().state, `comments-${issue}.json`), 'utf8')) as {
    body: string
    user: { login: string }
  }[]
  return raw.map((comment) => ({ body: comment.body, author: comment.user.login }))
}

/** Read the exact unpaginated native responses installed by serveEpic. */
export function epicFixtureGraph(root: Scope) {
  if (root.repository !== 'o/r') throw new Error('Unexpected epic fixture repository')
  const { issues, parentClaims } = readEpicFixtureIssues(root, sandboxOf().state)
  const graph = graphFromSimulatedIssues(root, issues)
  for (const node of graph.nodes) {
    const number = Number(node.uw.target.slice(node.uw.target.lastIndexOf('#') + 1))
    const parent =
      node.parent === null ? null : Number(node.parent.target.slice(node.parent.target.lastIndexOf('#') + 1))
    if (parentClaims.get(number) !== parent) throw new Error(`Native parent conflict at #${number}`)
  }
  return graph
}

export function eventPayloads(issue: number): Record<string, unknown>[] {
  return decodeHistory(recordHistory(issue, issueComments(issue))).operations.flatMap((operation) =>
    operation.record?.kind === 'epic-event' ? [operation.record.payload as Record<string, unknown>] : [],
  )
}
export function pullReviewInputs(number: number, head: string) {
  const mandate = decodeHistory(recordHistory(2, issueComments(2)))
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate')
  const binding = decodeHistory(recordHistory(number, issueComments(number)))
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'workflow-binding')
  if (mandate?.kind !== 'mandate' || binding?.kind !== 'workflow-binding')
    throw new Error('bound PR review fixture needs its accepted mandate and binding')
  const nativeGraph = epicFixtureGraph({ repository: mandate.repository, target: mandate.target })
  const histories = nativeGraph.nodes.map((node) => {
    const issue = Number(node.uw.target.slice(node.uw.target.lastIndexOf('#') + 1))
    return decodeHistory(recordHistory(issue, issueComments(issue)))
  })
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) throw new Error(`Cannot resolve child accepted Spec: ${accepted.reason}`)
  const effective = resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories, graph: nativeGraph })
  if (!effective.ok) throw new Error(`Cannot resolve child effective Spec: ${JSON.stringify(effective.diagnostics)}`)
  const base = acceptedActionInputs(mandate, 'review', effective.value)
  const reference = (record: typeof mandate | typeof binding) => ({
    source: 'record' as const,
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: record.kind,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  })
  const baseCommit = git(sandboxOf().epic, 'rev-parse', 'refs/remotes/origin/main')
  const manifest = {
    ...base.manifest,
    subject: {
      kind: 'uw' as const,
      uw: { repository: mandate.repository, target: mandate.target },
      pullRequest: { repository: binding.repository, target: binding.target },
      binding: reference(binding),
    },
    acceptedSources: [reference(mandate)],
    code: { repository: 'o/r', base: baseCommit, head, referenceCommit: head },
    plugin: committedFixturePlugin(
      import.meta.dirname,
      base.manifest.plugin,
      git(import.meta.dirname, 'rev-parse', 'HEAD'),
    ),
  }
  return { ...base, manifest, fingerprint: actionInputDigest(manifest) }
}

export async function epicDecisionHistory(
  blocking: boolean,
  criteriaSatisfied: boolean,
  world: EpicParentWorld,
): Promise<{ comments: Comment[]; range: string }> {
  const prepared = await prepareEpicParentReview(world)
  const { mandate, inputs, head, range } = prepared
  const projection = committedFixtureProjection(import.meta.dirname, inputs)
  const options = { mandate, inputs, head, range, prefix: `epic-${head.slice(0, 8)}`, blocking }
  const criterion =
    blocking || criteriaSatisfied
      ? criterionEpicReviewGraph({
          ...options,
          issueRecords: prepared.issueRecords,
          coverageReferences: prepared.coverageReferences,
        })
      : null
  const graph =
    criterion ??
    epicReviewGraph({
      prefix: options.prefix,
      head,
      range,
      inputs,
      scope: { repository: 'o/r', target: 'o/r#1' },
      empty: true,
    })
  const root = graph.root
  const records = blocking ? blockingReviewRecords(criterion) : graph.records
  const parentHistory = prepared.history
  const nativeGraph = prepared.observation.graph
  const otherHistories = prepared.observation.histories.filter(
    (item) =>
      item.source.scope.repository !== parentHistory.source.scope.repository ||
      item.source.scope.target !== parentHistory.source.scope.target,
  )
  const encoded = encodeCriterionRecords(
    records,
    parentHistory.source.scope,
    projection,
    ME,
    otherHistories,
    parentHistory,
  )
  const prefix = encoded.comments.map((comment) => ({ body: comment.body, author: ME }))
  const before = encoded.history
  const decision = before.operations
    .map((operation) => operation.record)
    .find((record) => record?.kind === 'decision' && record.recordId === graph.decision.recordId)
  if (decision?.kind !== 'decision') throw new Error('Fixture epic decision was not authenticated')
  const { dispositions } = criterionDispositionRecords(
    criterion?.inputs ?? inputs,
    decision,
    [before, ...otherHistories],
    projection.catalogues,
    nativeGraph,
  )
  const dispositionIds = dispositions.map((record) => record.recordId)
  const event = epicEvent(
    1,
    `${root.recordId}-event`,
    {
      event: 'epic-review',
      run: RUN,
      decisionId: decision.recordId,
      inventoryIds: [root.recordId, graph.synthesis.recordId],
      dispositionIds,
      range,
    },
    [decision.recordId, root.recordId, graph.synthesis.recordId],
  )
  const dispositionRecords = encodeCriterionRecords(
    dispositions,
    before.source.scope,
    projection,
    ME,
    otherHistories,
    before,
  )
  const review =
    criterion !== null && !blocking && criteriaSatisfied
      ? buildRecord({
          ...criterion.review,
          payload: {
            ...criterion.review.payload,
            causeDispositionRefs: dispositions.map((record) => ({
              scope: before.source.scope,
              kind: 'cause-disposition' as const,
              recordId: record.recordId,
            })),
          },
        })
      : null
  if (review !== null && (!review.ok || review.value.kind !== 'review')) throw new Error('Invalid final Epic review')
  const final = encodeCriterionRecords(
    [...(review?.ok ? [review.value] : []), event],
    before.source.scope,
    projection,
    ME,
    otherHistories,
    dispositionRecords.history,
  )
  return {
    range,
    comments: [...prefix, ...dispositionRecords.comments, ...final.comments].map((comment) => ({
      body: comment.body,
      author: ME,
    })),
  }
}

export { childNode, prNode } from './epic-driver-nodes.ts'
export { serveComments, serveEpic, servePr } from './epic-driver-serve.ts'
