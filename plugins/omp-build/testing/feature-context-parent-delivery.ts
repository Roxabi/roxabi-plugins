import { execFileSync } from 'node:child_process'
import { parseIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { historyFor } from '../engine/workflow-control.ts'
import { selectedMandate } from '../engine/workflow-mandate-admission.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { criterionReviewGraph } from './criterion-approval.ts'
import { createParentChildCommits } from './feature-context-parent-commits.ts'
import { createChildHistoryAppender } from './feature-context-parent-history.ts'
import { persistParentReviews } from './feature-context-parent-persistence.ts'
import { nativeImplementationWorld } from './native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'
import { eligiblePlanAt } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

const repository = 'acme/app'
const parentScope = { repository, target: `${repository}#200` }
const scopes = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))

function priorParents(i: number, bases: readonly string[], heads: readonly string[]): string[] {
  const previousBase = bases[i - 1]
  const previousHead = heads[i - 1]
  if (i !== 0 && (!previousBase || !previousHead)) throw new Error('Previous child delivery facts missing')
  return previousBase && previousHead ? [previousBase, previousHead] : []
}

function childEffective(mandate: MandateRecord, context: readonly DecodedHistory[], graph: UwGraphObservation) {
  const accepted = resolveAcceptedSpec(mandate, context)
  if (!accepted.ok) throw new Error('Child mandate not accepted')
  const effective = resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories: context, graph })
  if (!effective.ok) throw new Error(`Child effective spec unavailable: ${JSON.stringify(effective.diagnostics)}`)
  return effective
}

/** Deliver three fictional child reviews against the real selected parent and accepted material revision. */
export async function deliverParentChildren({
  box,
  checkout,
  env,
  child201Version,
}: {
  box: Box
  checkout: string
  env: NodeJS.ProcessEnv
  child201Version?: string
}) {
  const gh = async (cwd: string, args: string[]) =>
    execFileSync('gh', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const operator = {
    async executeConfirmed(): Promise<never> {
      throw new Error('Child fixture does not confirm operator operations')
    },
  }
  const operations = await createInstalledUwOperations({ cwd: checkout, gh, operator, readAuthor: 'operator' })
  const read = await operations.readUw(parentScope)
  if (read.accepted.status !== 'accepted' || read.graph.status !== 'complete')
    throw new Error('Parent accepted material or graph unavailable')
  const acceptedParent = read.accepted.value
  const graph = read.graph
  if (child201Version !== undefined) {
    const child = acceptedParent.children.find(
      (item) => item.scope.target === scopes[0]?.target && item.scope.repository === repository,
    )
    const node = graph.nodes.find((item) => item.uw.target === scopes[0]?.target && item.uw.repository === repository)
    if (!child || child.specVersion !== child201Version || !node)
      throw new Error('Parent has not accepted the requested child version')
    const parsed = parseIssueSpecBody({ uw: node.uw, raw: node.raw })
    if (parsed.status !== 'conformant' || parsed.snapshot.spec.version !== child201Version)
      throw new Error('Native child proposal does not match the accepted version')
  }
  const history = historyFor(parentScope, read.histories)
  if (!history) throw new Error('Parent history unavailable')
  const parent = selectedMandate(history)
  if (!('kind' in parent) || parent.kind !== 'mandate') throw new Error('Parent mandate unavailable')
  const workflow = roxabiWorkflowFixtures()
  const projection = roxabiRecordFixtures().projection
  const { heads, merges, bases, branches } = createParentChildCommits(box, checkout, graph, child201Version)
  const mandates = scopes.map((scope, i) => {
    const node = graph.nodes.find((item) => item.uw.target === scope.target)
    const branch = branches[i]
    if (!node || !branch) throw new Error('Child graph or branch missing')
    const parsed = parseIssueSpecBody({ uw: scope, raw: node.raw })
    if (parsed.status !== 'conformant') throw new Error('Child specification invalid')
    return workflow.featureMandate(scope, {
      body: node.raw.body,
      ownSpec: workflow.ownSpecFromSnapshot(scope, parsed.snapshot),
      recordId: `child-mandate-${i}`,
      branch,
      parent: workflow.mandateRef(parent),
      inheritedOwnSpecRefs: [acceptedParent.ref],
    })
  })
  const appendRecords = createChildHistoryAppender(read.histories)
  const mandateHistories = mandates.map((mandate) => {
    const original = historyFor({ repository: mandate.repository, target: mandate.target }, read.histories)
    if (original === null) throw new Error('Original child history unavailable')
    return appendRecords(original, [mandate], [history])
  })
  const context = [history, ...mandateHistories]
  async function makeReview(mandate: (typeof mandates)[number], i: number) {
    const uw = scopes[i],
      head = heads[i],
      base = bases[i],
      merge = merges[i],
      branch = branches[i]
    if (!uw || !head || !base || !merge || !branch) throw new Error('Child delivery facts missing')
    const parents = priorParents(i, bases, heads)
    const pullRequest = { repository, target: `${repository}#${301 + i}` }
    const binding = workflow.workflowBinding(pullRequest, mandate, branch, 'main')
    const effective = childEffective(mandate, context, graph)
    const others = context.filter((item) => item.source.scope.target !== uw.target)
    const originalChild = historyFor(uw, mandateHistories)
    if (originalChild === null) throw new Error('Child mandate history unavailable')
    const planned = appendRecords(originalChild, eligiblePlanAt(mandate, base, context, effective.value), others)
    const tree = (commit: string) => git(box, checkout, ['rev-parse', `${commit}^{tree}`])
    const produced = await nativeImplementationWorld({
      graph,
      histories: [planned, ...others],
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
          parents,
          tree: tree(base),
          subject: i === 0 ? 'fixture base' : `merge child ${200 + i}`,
          paths: ['fixture.txt'],
          config: null,
        },
        {
          sha: head,
          parents: [base],
          tree: tree(head),
          subject: `feat: implement fixture (#${201 + i})`,
          paths: ['fixture.txt'],
          config: null,
        },
      ],
      command: 'bun test fixture-c1.test.ts',
      output: 'PASS C1 fixture scenario',
    })
    const implementation = produced.records.find(
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
      throw new Error('Child implementation unavailable')
    const declaration = implementation.payload.structured.criteria[0]
    if (!declaration) throw new Error('Child criterion unavailable')
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
      issueRecords: produced.records,
      issueHistory: produced.history,
      scope: pullRequest,
      pullHistory: workflow.historyFrom([binding], 'operator', 'operator', [produced.history, ...others]),
      projection,
      graph,
      prefix: `sibling-${i}`,
      author: 'operator',
      verdict: 'Approve (clean)',
      contextHistories: others,
    })
    return { uw, pullRequest, branch, binding, review, head, base, merge }
  }
  const [first, second, third] = mandates
  if (!first || !second || !third) throw new Error('Three child mandates required')
  const reviews = [await makeReview(first, 0), await makeReview(second, 1), await makeReview(third, 2)]
  await persistParentReviews(box, checkout, gh, reviews)
  const thirdMerge = merges[2]
  if (!thirdMerge) throw new Error('Third merge missing')
  const parentCheckout = {
    cwd: checkout,
    checkout: (commit: string) => {
      git(box, checkout, ['checkout', '-q', '--detach', commit])
    },
    tree: (commit: string) => git(box, checkout, ['rev-parse', `${commit}^{tree}`]),
    observe: () => {
      const branchName = git(box, checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const remote = git(box, checkout, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0]
      if (!remote) throw new Error('Published main is unavailable')
      return {
        branch: branchName === 'HEAD' ? null : branchName,
        head: git(box, checkout, ['rev-parse', 'HEAD']),
        base: 'main',
        baseTip: git(box, checkout, ['rev-parse', 'refs/remotes/origin/main']),
        remoteTip: remote,
      }
    },
  }
  return { reviews, thirdMerge, parentHead: thirdMerge, parentCheckout, parent, parentScope, operations }
}
