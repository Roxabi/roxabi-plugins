import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import type { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlanAt } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Scope } from '../record-values.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import type { UwGraphObservation } from '../uw-graph.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import type { MandateRecord } from '../workflow-control.ts'

type ChildReviewInput = {
  mandate: MandateRecord
  i: number
  repository: string
  scopes: readonly Scope[]
  heads: readonly string[]
  bases: readonly string[]
  merges: readonly string[]
  git: { baseTrees: readonly string[]; trees: readonly string[] }
  context: DecodedHistory[]
  graph: Extract<UwGraphObservation, { status: 'complete' }>
  projection: ReturnType<typeof roxabiRecordFixtures>['projection']
  workflow: ReturnType<typeof roxabiWorkflowFixtures>
}

export async function childReview(input: ChildReviewInput) {
  const { mandate, i, repository, scopes, heads, bases, merges, git, context, graph, projection, workflow } = input
  const uw = scopes[i]
  const head = heads[i]
  const base = bases[i]
  const merge = merges[i]
  const baseTree = git.baseTrees[i]
  const tree = git.trees[i]
  if (!uw || !head || !base || !merge || !baseTree || !tree) throw new Error(`Missing declared child facts ${i}`)
  const previousBase = bases[i - 1]
  const previousHead = heads[i - 1]
  if (i > 0 && (!previousBase || !previousHead)) throw new Error(`Missing prior child facts ${i}`)
  const baseParents = previousBase && previousHead ? [previousBase, previousHead] : []
  const pullRequest = { repository, target: `${repository}#${301 + i}` }
  const branch = `feature/child-${i}`
  const binding = workflow.workflowBinding(pullRequest, mandate, branch, 'main')
  const accepted = resolveAcceptedSpec(mandate, context)
  if (!accepted.ok) throw new Error('Child mandate is not accepted')
  const effective = resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories: context, graph })
  if (!effective.ok) throw new Error(`Child vector is not current: ${JSON.stringify(effective.diagnostics)}`)
  const otherHistories = context.filter((history) => history.source.scope.target !== uw.target)
  const planned = workflow.historyFrom(
    eligiblePlanAt(mandate, base, context, effective.value),
    'operator',
    'operator',
    otherHistories,
  )
  const produced = await nativeImplementationWorld({
    graph,
    histories: [planned, ...otherHistories],
    scope: uw,
    mandate,
    startHead: base,
    head,
    branch,
    author: 'operator',
    baseTip: base,
    remoteTipBefore: base,
    remoteTipAfter: head,
    pullRequestsBefore: [],
    pullRequestsAfter: [],
    comparisons: [],
    commits: [
      {
        sha: base,
        parents: baseParents,
        tree: baseTree,
        subject: i === 0 ? 'fixture base' : `merge child ${i}`,
        paths: ['fixture.txt'],
        config: null,
      },
      {
        sha: head,
        parents: [base],
        tree,
        subject: `feat: implement fixture (#${201 + i})`,
        paths: ['fixture.txt'],
        config: null,
      },
    ],
    command: 'bun test fixture-c1.test.ts',
    output: 'PASS C1 fixture scenario',
  })
  const records = produced.records
  const origin = produced.history
  const implementation = records.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    !implementation.payload.structured ||
    implementation.payload.structured.outcome === 'missing-context'
  )
    throw new Error('Missing child implementation capture')
  const declaration = implementation.payload.structured.criteria[0]
  if (!declaration) throw new Error('Missing child declaration')
  const seed = acceptedActionInputs(mandate, 'review', effective.value)
  const manifest = {
    ...seed.manifest,
    subject: {
      kind: 'uw' as const,
      uw,
      pullRequest,
      binding: {
        source: 'record' as const,
        record: { scope: pullRequest, kind: 'workflow-binding' as const, recordId: binding.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(binding.payload),
      },
    },
    code: { repository, base, head, referenceCommit: head },
    deliveryData: [
      {
        source: 'record' as const,
        role: 'implementation' as const,
        record: { scope: uw, kind: 'action-receipt' as const, recordId: implementation.recordId },
        selector: '/payload/structured/criteria/0',
        digest: canonicalValueDigest(declaration),
      },
    ],
  }
  const inputs = { ...seed, manifest, fingerprint: actionInputDigest(manifest) }
  const review = criterionReviewGraph({
    mandate,
    inputs,
    head,
    issueRecords: records,
    issueHistory: origin,
    scope: pullRequest,
    pullHistory: workflow.historyFrom([binding], 'operator', 'operator', [origin, ...otherHistories]),
    projection,
    graph,
    prefix: `sibling-${i}`,
    author: 'operator',
    verdict: 'Approve (clean)',
    contextHistories: otherHistories,
  })
  return { uw, pullRequest, branch, binding, review, head, base, merge }
}
