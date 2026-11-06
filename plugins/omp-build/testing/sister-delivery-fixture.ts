import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeComment } from '../adapters/__tests__/github-workflow-support.ts'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../adapters/github/transport.ts'
import { parseIssueSpecBody, rawSource } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { prepareUwAction, replayUwActionInputs } from '../roxabi/uw-action-inputs.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { criterionReviewGraph, encodeCriterionRecords } from './criterion-approval.ts'
import type { installedMultiSisterFixture } from './multi-sister-installed-fixture.ts'
import { nativeActionFixturePorts } from './native-action-ports.ts'
import { produceNativeImplementation } from './native-implementation-producer.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { eligiblePlanAt } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

function sisterSpecification(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-27T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Created sister does not have a conformant native Spec')
  const criterion = parsed.snapshot.spec.criteria[0]
  if (!criterion) throw new Error('Created sister has no accepted criterion')
  return { parsed, criterion }
}

/** Frame and deliver the actually created sibling in the same native comment and GitHub world. */
export async function deliverCreatedSister(world: Awaited<ReturnType<typeof installedMultiSisterFixture>>) {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-sister-delivery-'))
  const artifactsDir = mkdtempSync(join(tmpdir(), 'omp-sister-artifacts-'))
  try {
    return await deliverInWorld(world, cwd, artifactsDir)
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function deliverInWorld(
  world: Awaited<ReturnType<typeof installedMultiSisterFixture>>,
  cwd: string,
  artifactsDir: string,
) {
  const scope = { repository: 'acme/app', target: 'acme/app#43' }
  const pull = { repository: scope.repository, target: 'acme/app#45' }
  const issue = world.issues.get(43)
  const list = world.comments.get(43)
  if (!issue || !list) throw new Error('The actual sister must exist before delivery')
  const { parsed, criterion } = sisterSpecification(scope, issue.body)
  const workflow = roxabiWorkflowFixtures()
  const base = world.declaredBase,
    originalHead = world.declaredHead,
    head = 'c'.repeat(40),
    merge = 'd'.repeat(40)
  const tree = '9'.repeat(40),
    baseTree = '8'.repeat(40)
  const originalCommits = world.originalCommits ?? [
    { sha: base, parents: [], tree: baseTree, subject: 'fixture base', paths: ['fixture.txt'], config: null },
    {
      sha: originalHead,
      parents: [base],
      tree,
      subject: 'original change (#42)',
      paths: ['fixture.txt'],
      config: null,
    },
  ]
  const commits = [
    ...originalCommits,
    { sha: head, parents: [base], tree, subject: 'feat: sister change (#43)', paths: ['fixture.txt'], config: null },
    { sha: merge, parents: [base, head], tree, subject: 'merge sister change', paths: ['fixture.txt'], config: null },
  ]
  const comparisons = [
    { base, head: base, status: 'identical' as const, commits: [] },
    { base: head, head, status: 'identical' as const, commits: [] },
    { base: merge, head: merge, status: 'identical' as const, commits: [] },
    { base, head, status: 'ahead' as const, commits: [head] },
    { base: head, head: merge, status: 'ahead' as const, commits: [merge] },
    { base, head: merge, status: 'ahead' as const, commits: [head, merge] },
    { base, head: originalHead, status: 'ahead' as const, commits: [originalHead] },
    { base: originalHead, head: originalHead, status: 'identical' as const, commits: [] },
  ]
  const gitWorld = world.declareDelivery(
    { commits, comparisons },
    {
      branch: 'feat/43-sister',
      base: 'main',
      baseTip: base,
      head: base,
      remoteTip: base,
    },
  )
  const prior = await readGitHubHistory(scope, { cwd, gh: world.gh, readAuthor: 'automation' })
  if (!prior.complete) throw new Error('Created sister identity history is unreadable')
  const projection = roxabiRecordFixtures().projection
  const identityRead = await world.operations.readUw(scope)
  if (!identityRead.identity.ok || identityRead.identity.value.head?.kind !== 'spec-identity')
    throw new Error('Created sister native identity allocation is unavailable')
  const ownSpec = {
    ...workflow.ownSpecFromSnapshot(scope, parsed.snapshot),
    identityAllocations: [{ ...identityRead.identity.value.head, kind: 'spec-identity' as const }],
  }
  const mandate = workflow.featureMandate(scope, {
    recordId: 'sister-mandate-43',
    body: issue.body,
    ownSpec,
    branch: 'feat/43-sister',
  })
  const identityExternal = identityRead.histories.filter((history) => history.source.scope.target !== scope.target)
  const framed = encodeCriterionRecords(
    [mandate],
    scope,
    projection,
    'automation',
    identityExternal,
    decodeHistory(prior),
  )
  list.push(...framed.comments.map((comment, index) => nativeComment(10000 + index, comment.body)))
  const acceptedRead = await world.operations.readUw(scope)
  if (acceptedRead.accepted.status !== 'accepted') throw new Error('Created sister mandate was not accepted')
  const effective = resolveSpecEffective({
    mode: 'current',
    own: acceptedRead.accepted.value.ref,
    histories: acceptedRead.histories,
    graph: acceptedRead.graph,
  })
  if (!effective.ok) throw new Error(`Sister current vector unavailable: ${JSON.stringify(effective.diagnostics)}`)
  const planOutput = {
    steps: [
      {
        id: 'sister-delivery',
        change: 'Deliver the created sister obligation',
        doneWhen: criterion.statement,
        criterionIds: [criterion.id],
        evidence: 'The captured sister test verifies the obligation',
        paths: ['fixture.txt'],
      },
    ],
    resolutions: [],
  }
  const plan = eligiblePlanAt(mandate, base, acceptedRead.histories, effective.value, planOutput)
  const initial = encodeCriterionRecords(
    plan.filter((record) => record.kind !== 'mandate'),
    scope,
    projection,
    'automation',
    identityExternal,
    framed.history,
  )
  list.push(...initial.comments.map((comment, index) => nativeComment(11000 + index, comment.body)))
  const planStart = plan.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'plan' && record.payload.phase === 'start',
  )
  if (planStart?.kind !== 'action-receipt') throw new Error('Canonical sister plan lacks START')
  const ports = nativeActionFixturePorts({
    cwd,
    artifactsDir,
    gh: world.gh,
    git: gitWorld.git,
    author: 'automation',
    plugin: planStart.payload.inputs.manifest.plugin,
    commits: new Map(commits.map((commit) => [commit.sha, commit])),
    diffs: new Map(),
    repositoryFiles: new Map(),
  })
  const operations = {
    ...world.operations,
    prepareAction: (
      request: Parameters<typeof world.operations.prepareAction>[0],
      projectionArg?: Parameters<typeof world.operations.prepareAction>[1],
      review?: Parameters<typeof world.operations.prepareAction>[2],
    ) => prepareUwAction(request, ports, projectionArg, review),
    replayActionInputs: (request: Parameters<typeof world.operations.replayActionInputs>[0]) =>
      replayUwActionInputs(request, ports),
  }
  const before = await operations.readUw(scope)
  const produced = await produceNativeImplementation({
    cwd,
    gh: world.gh,
    git: gitWorld.git,
    operations,
    read: before,
    scope,
    mandate,
    parents: [],
    startHead: base,
    command: 'bun test sister-delivery.test.ts',
    output: 'PASS sister delivery',
    advance() {
      gitWorld.checkout({ branch: 'feat/43-sister', base: 'main', baseTip: base, head, remoteTip: head })
      return { head, tree }
    },
  })
  if (!produced.declaration) throw new Error('Admitted sister implementation lacks a criterion declaration')
  const binding = workflow.workflowBinding(pull, mandate, 'feat/43-sister', 'main')
  gitWorld.observePullRequest({
    scope: pull,
    branch: 'feat/43-sister',
    base: 'main',
    head,
    baseTip: base,
    state: 'OPEN',
    mergeCommit: null,
    author: 'automation',
  })
  const current = await operations.readUw(scope)
  if (current.accepted.status !== 'accepted') throw new Error('Sister accepted vector disappeared after implementation')
  const currentEffective = resolveSpecEffective({
    mode: 'current',
    own: current.accepted.value.ref,
    histories: current.histories,
    graph: current.graph,
  })
  if (!currentEffective.ok)
    throw new Error(`Sister review vector unavailable: ${JSON.stringify(currentEffective.diagnostics)}`)
  const seed = acceptedActionInputs(mandate, 'review', currentEffective.value)
  const manifest = {
    ...seed.manifest,
    subject: {
      kind: 'uw' as const,
      uw: scope,
      pullRequest: pull,
      binding: {
        source: 'record' as const,
        record: { scope: pull, kind: 'workflow-binding' as const, recordId: binding.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(binding.payload),
      },
    },
    code: { ...seed.manifest.code, base, head, referenceCommit: head },
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope, recordId: mandate.recordId, kind: 'mandate' as const },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
    deliveryData: [
      {
        source: 'record' as const,
        role: 'implementation' as const,
        record: { scope, recordId: produced.receipt.recordId, kind: 'action-receipt' as const },
        selector: '/payload/structured/criteria/0',
        digest: canonicalValueDigest(produced.declaration),
      },
    ],
  }
  const inputs = { ...seed, manifest, fingerprint: actionInputDigest(manifest) }
  const external = current.histories.filter(
    (history) => history.source.scope.target !== scope.target && history.source.scope.target !== pull.target,
  )
  const pullHistory = workflow.historyFrom([binding], 'automation', 'automation', [produced.history, ...external])
  const pullComments = world.comments.get(45)
  if (!pullComments) throw new Error('Declared sister pull request history is missing')
  pullComments.push(...pullHistory.source.comments.map((comment, index) => nativeComment(20000 + index, comment.body)))
  const review = criterionReviewGraph({
    mandate,
    inputs,
    head,
    issueRecords: recordsOf(produced.history),
    issueHistory: produced.history,
    scope: pull,
    pullHistory,
    projection,
    graph: current.graph,
    contextHistories: external,
    author: 'automation',
    prefix: 'sister-delivery',
  })
  list.push(...review.issueComments.map((comment, index) => nativeComment(30000 + index, comment.body)))
  pullComments.push(...review.comments.map((comment, index) => nativeComment(40000 + index, comment.body)))
  gitWorld.observePullRequest({
    scope: pull,
    branch: 'feat/43-sister',
    base: 'main',
    head,
    baseTip: base,
    state: 'MERGED',
    mergeCommit: merge,
    author: 'automation',
  })
  return { scope, pull, produced, operations }
}
