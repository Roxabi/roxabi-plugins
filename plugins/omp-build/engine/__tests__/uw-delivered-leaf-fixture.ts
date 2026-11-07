import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlanAt } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { Verdict } from '../record-values.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import type { UwGraphObservation } from '../uw-graph.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { leafNativeFacts } from './uw-leaf-native-facts.ts'
/** A declared GitHub world; every record is encoded and decoded by the native fixture transport. */
export async function buildDeliveredLeaf(verdict: Verdict = 'Approve (clean)', number = 42, inherited = false) {
  const uw = { repository: 'acme/app', target: `acme/app#${number}` }
  const pullRequest = { repository: uw.repository, target: `acme/app#${number + 100}` }
  const workflow = roxabiWorkflowFixtures()
  const date = '2026-10-27T12:00:00.000Z'
  function frameNativeGraph() {
    const nativeContent = canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save keeps the selected region' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    })
    const parentContent = canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Deliver the epic' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    })
    if (!nativeContent.ok || !parentContent.ok) throw new Error('Invalid declared fixture Spec')
    const body = renderIssueSpecBody(nativeContent.value, { complexity: 1 })
    const parentBody = renderIssueSpecBody(parentContent.value, { complexity: 1 })
    const parsedChild = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, date) })
    if (parsedChild.status !== 'conformant') throw new Error('Invalid declared child issue')
    const childSpec = workflow.ownSpecFromSnapshot(uw, parsedChild.snapshot)
    const parentScope = { repository: uw.repository, target: `acme/app#${number + 1000}` }
    const parsedParent = parseIssueSpecBody({ uw: parentScope, raw: rawSource(parentScope.target, parentBody, date) })
    if (parsedParent.status !== 'conformant') throw new Error('Invalid declared parent issue')
    const parent = inherited
      ? workflow.epicMandate(
          parentScope,
          [
            {
              scope: uw,
              snapshot: childSpec.snapshot,
              specVersion: childSpec.version,
              tier: 'S',
            },
          ],
          {
            recordId: `parent-mandate-${number}`,
            body: parentBody,
            ownSpec: workflow.ownSpecFromSnapshot(parentScope, parsedParent.snapshot),
          },
        )
      : null
    const mandate = workflow.featureMandate(uw, {
      branch: 'feat/42-save',
      recordId: `mandate-${number}`,
      body,
      ownSpec: childSpec,
      ...(parent === null
        ? {}
        : {
            parent: workflow.mandateRef(parent),
            inheritedOwnSpecRefs: [
              { uw: parentScope, version: parent.payload.ownSpec.version, sourceAccepted: workflow.mandateRef(parent) },
            ],
          }),
    })
    const graph: Extract<UwGraphObservation, { status: 'complete' }> = {
      status: 'complete',
      root: uw,
      observedAt: date,
      nodes: [
        {
          uw,
          title: 'Deliver C1',
          raw: rawSource(uw.target, body, date),
          updatedAt: date,
          labels: ['size:S'],
          wayfinderLabels: [],
          parent: parent === null ? null : parentScope,
          children: [],
          blockers: [],
          native: { state: 'OPEN', stateReason: null },
        },
        ...(parent === null
          ? []
          : [
              {
                uw: parentScope,
                title: 'Parent',
                raw: rawSource(parentScope.target, parentBody, date),
                updatedAt: date,
                labels: ['size:S'],
                wayfinderLabels: [],
                parent: null,
                children: [uw],
                blockers: [],
                native: { state: 'OPEN' as const, stateReason: null },
              },
            ]),
      ],
    }
    return { mandate, graph, parent, parentScope }
  }
  const { mandate, graph, parent, parentScope } = frameNativeGraph()
  const binding = workflow.workflowBinding(pullRequest, mandate, 'feat/42-save', 'main')
  const parentHistories = parent === null ? [] : [workflow.historyFrom([parent])]
  const mandateHistory = workflow.historyFrom([mandate], 'operator', 'operator', parentHistories)
  const acceptedBefore = resolveAcceptedSpec(mandate, [mandateHistory, ...parentHistories])
  if (!acceptedBefore.ok) throw new Error('Expected accepted child fixture')
  const effectiveBefore = resolveSpecEffective({
    mode: 'current',
    own: acceptedBefore.spec.ref,
    histories: [mandateHistory, ...parentHistories],
    graph,
  })
  if (!effectiveBefore.ok)
    throw new Error(`Expected current child fixture vector: ${JSON.stringify(effectiveBefore.diagnostics)}`)
  const baseInputs = acceptedActionInputs(mandate, 'review', effectiveBefore.value)
  const seed =
    parent === null
      ? acceptedPullRequestReviewGraph({ mandate, binding }).inputs
      : {
          ...baseInputs,
          manifest: {
            ...baseInputs.manifest,
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
          },
        }
  const base = 'a'.repeat(40)
  const head = '1'.repeat(40)
  const planned = workflow.historyFrom(
    eligiblePlanAt(mandate, base, [mandateHistory, ...parentHistories], effectiveBefore.value),
    'operator',
    'operator',
    parentHistories,
  )
  const produced = await nativeImplementationWorld({
    graph,
    histories: [planned, ...parentHistories],
    scope: uw,
    mandate,
    startHead: base,
    head,
    branch: 'feat/42-save',
    author: 'operator',
    baseTip: base,
    remoteTipBefore: base,
    remoteTipAfter: head,
    pullRequestsBefore: [],
    pullRequestsAfter: [],
    comparisons: [],
    commits: [
      { sha: base, parents: [], tree: '8'.repeat(40), subject: 'fixture base', paths: ['fixture.txt'], config: null },
      {
        sha: head,
        parents: [base],
        tree: '9'.repeat(40),
        subject: `feat: implement fixture (#${number})`,
        paths: ['fixture.txt'],
        config: null,
      },
    ],
    command: 'bun test fixture-c1.test.ts',
    output: 'PASS C1 fixture scenario',
  })
  const issueRecords = produced.records
  const origin = produced.history
  const implementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    implementation.payload.structured === null
  )
    throw new Error('Expected captured implementation result')
  const declaration = implementation.payload.structured.criteria[0]
  if (!declaration) throw new Error('Expected criterion declaration')
  const manifest = {
    ...seed.manifest,
    code: { ...seed.manifest.code, base, head, referenceCommit: head },
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope: uw, recordId: mandate.recordId, kind: 'mandate' as const },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
    deliveryData: [
      {
        source: 'record' as const,
        role: 'implementation' as const,
        record: { scope: uw, recordId: implementation.recordId, kind: 'action-receipt' as const },
        selector: '/payload/structured/criteria/0',
        digest: canonicalValueDigest(declaration),
      },
    ],
  }
  const inputs = { ...seed, manifest, fingerprint: actionInputDigest(manifest) }
  const projection = roxabiRecordFixtures().projection
  const review = criterionReviewGraph({
    mandate,
    inputs,
    head,
    issueRecords,
    issueHistory: origin,
    scope: pullRequest,
    pullHistory: workflow.historyFrom([binding], 'operator', 'operator', [origin, ...parentHistories]),
    projection,
    graph,
    prefix: `delivery-${number}`,
    author: 'operator',
    verdict,
    contextHistories: parentHistories,
  })
  const merge = 'f'.repeat(40)
  const reader = leafNativeFacts(uw, number, base, head, merge)
  const histories = [review.issueHistory, review.history, ...parentHistories]
  const read = await reader.read(uw, histories)
  if (!read.ok) throw new Error(`Native fixture facts unavailable: ${JSON.stringify(read.diagnostics)}`)
  const observation: Extract<UwCompletionObservation, { status: 'complete' }> = {
    status: 'complete',
    root: uw,
    graph,
    histories,
    catalogues: projection.catalogues,
    delivery: [read.value.facts],
  }
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) throw new Error('Expected accepted fixture Spec')
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.spec.ref,
    histories,
    graph: observation.graph,
  })
  if (!effective.ok) throw new Error('Expected effective fixture Spec')
  return {
    observation,
    uw,
    pullRequest,
    mandate,
    binding,
    implementation,
    declaration,
    inputs,
    review,
    accepted: accepted.spec,
    effective: effective.value,
    base,
    head,
    merge,
    parent,
    parentScope,
  }
}
