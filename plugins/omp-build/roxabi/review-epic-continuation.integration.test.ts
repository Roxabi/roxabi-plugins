import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { runNestedDeliveryScenario } from '../testing/nested-delivery-world.ts'
import { allocateReviewPanel } from './review-panel.ts'
import { CanonicalReviewRunner, type PreparedReviewInputs } from './review-runner.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'

type World = Parameters<NonNullable<Parameters<typeof runNestedDeliveryScenario>[1]>>[0]['world']
type Root = { scope: WorldScope; kind: 'review-attempt'; recordId: string }
type WorldScope = Parameters<World['operations']['readUw']>[0]
type Selection = { root: Root; fingerprint: string }

async function observeRoot(world: World, root: Root) {
  const { scope } = root
  const current = await world.operations.readUw(scope)
  const history = current.histories.find(
    (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
  )
  const rootOperation = history?.operations.find((operation) => operation.recordId === root.recordId)
  if (!rootOperation || rootOperation.parts.length === 0) throw new Error('Published root history unavailable')
  return rootOperation.parts.map((part) => {
    if (part.nativeId === null || part.updatedAt === null) throw new Error('Root comment metadata unavailable')
    return { ...part, nativeId: part.nativeId, updatedAt: part.updatedAt }
  })
}

async function rejectMismatchedRoot(world: World, root: Root, request: UwActionRequest, selected: Selection) {
  const { scope } = root
  const rejected = await world.operations.prepareAction(request, undefined, {
    ...selected,
    root: { ...root, scope: { repository: scope.repository, target: `${scope.repository}#43` } },
  })
  expect(rejected.ok).toBe(false)
}

async function rejectForeignRoot(
  world: World,
  root: Root,
  parts: Awaited<ReturnType<typeof observeRoot>>,
  request: UwActionRequest,
  selected: Selection,
) {
  const before = await world.operations.prepareAction(request, undefined, selected)
  expect(before.ok, JSON.stringify(before)).toBe(true)
  for (const part of parts) {
    const updatedAt = new Date(Date.parse(part.updatedAt) + 1000).toISOString()
    world.editComment(root.scope, part.nativeId, part.body, updatedAt, 'foreign')
  }
  const rejected = await world.operations.prepareAction(request, undefined, selected)
  expect(rejected.ok).toBe(false)
}

it('continues an authenticated Epic range through installed action preparation, but refuses foreign and mismatched roots', async () => {
  await runNestedDeliveryScenario('complete', async ({ world, git, target: scope, proof }) => {
    const operations = world.operations
    const code = proof.code
    const fileBytes = execFileSync('git', ['-C', git.cwd, 'show', `${code.head}:fixture.txt`])
    const subject = { kind: 'uw' as const, uw: scope, pullRequest: null, binding: null }
    const diff = new TextDecoder().decode(git.diff(code.base, code.head))
    const delta = execFileSync('git', ['-C', git.cwd, 'diff', '--name-only', code.base, code.head], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    expect(code.base).toBe(code.head)
    expect(delta).toEqual([])
    expect(delta).toEqual(diff.length === 0 ? [] : ['fixture.txt'])
    const chunks =
      diff.length === 0
        ? []
        : [
            {
              index: 0,
              delta,
              diff,
              files: [{ path: 'fixture.txt', text: fileBytes.toString('utf8'), deleted: false, binary: false }],
              digest: 'candidate',
            },
          ]
    const roster: PreparedReviewInputs['roster'] = {
      delta: chunks.flatMap((chunk) => chunk.delta),
      tier: 'S',
      chunks: chunks.length,
      axialAdr: false,
      stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
      config: { maxAgents: 5, axialOverride: 'default', overrides: {}, warnings: [] },
    }
    const range = `${code.base}..${code.head}`
    const config: PreparedReviewInputs['config'] = { canonicalClasses: [], chunker: 'chunker.py', digest: 'digest.py' }
    const panel = allocateReviewPanel({
      subject: { kind: 'epic-range', range },
      chunks,
      roster,
      config,
      commonContext: 'Review the assigned chunk.',
    })
    const actions: Record<string, PreparedUwAction> = {}
    for (const { name, assignedChunk } of [{ name: 'spec', assignedChunk: null }, ...panel.tasks]) {
      const request: UwActionRequest = {
        actionId: `epic-${name}`,
        purpose: 'review',
        subject,
        code,
        stageSources: [],
        expandedContext: [],
      }
      const prepared = await operations.prepareAction(request, {
        taskName: name,
        assignedChunk,
        contextWindow: 200_000,
        chunks,
      })
      if (!prepared.ok) throw new Error(`initial ${name}: ${JSON.stringify(prepared.diagnostics)}`)
      actions[name] = prepared.value
    }
    const initial = actions.spec
    if (!initial) throw new Error('missing spec action')
    expect(initial.inputs.manifest.subject).toEqual(subject)
    expect(initial.inputs.manifest.repositoryReferences).toContainEqual({
      source: 'git-file',
      repository: scope.repository,
      commit: code.head,
      path: 'fixture.txt',
      digest: createHash('sha256').update(fileBytes).digest('hex'),
    })
    const review: PreparedReviewInputs = {
      context: {
        ...scope,
        number: Number(scope.target.split('#')[1]),
        candidateGitSHA: code.head,
        input: initial.inputs.fingerprint,
        runId: 'epic-run',
        operationId: 'epic-op',
        subject: { kind: 'epic-range', range },
      },
      pr: { base: 'main', baseGitSHA: code.base },
      chunks,
      contextWindow: 200_000,
      roster,
      config,
      policy: { version: 'baseline' },
      semantic: { spec: 'spec', panel: 'panel', synthesis: 'synthesis' },
      observedEvidence: {
        reviewInput: null,
        candidate: { head: code.head, base: code.base },
        pullRequest: null,
        stack: { candidate: null, base: null },
        resolvedSpec: null,
      },
      inputSnapshot: initial.inputs,
      canonicalClasses: [],
      actions,
      operations,
      authorize: async () => ({ ok: true }),
    }
    const runner = new CanonicalReviewRunner(review, {
      cwd: world.cwd,
      gh: world.gh,
      readAuthor: 'operator',
      writerLogin: 'operator',
    })
    const batch = runner.initialBatch()
    const published = await runner.publishInventory(batch, () => true)
    expect(published, JSON.stringify(published)).toEqual({ ok: true })
    const root = { scope, kind: 'review-attempt' as const, recordId: batch.rootAttemptId }
    const selected = { root, fingerprint: initial.inputs.fingerprint }
    const synthesisRequest: UwActionRequest = {
      actionId: `${root.recordId}:synthesis`,
      purpose: 'review',
      subject,
      code,
      stageSources: [],
      expandedContext: [],
    }
    const admitted = await operations.prepareAction(synthesisRequest, undefined, selected)
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true)

    const rootParts = await observeRoot(world, root)
    await rejectMismatchedRoot(world, root, synthesisRequest, selected)

    const children: NativeChildResult[] = batch.batch.tasks.tasks.map((task) => {
      const structured: NativeChildResult['submissions'][number]['data'] =
        task.name === 'spec' ? { findings: [], specRows: [] } : { findings: [] }
      return {
        id: `child-${task.name}`,
        expectedId: task.name,
        submissions: [
          { attemptIndex: 0, data: structured, raw: { structuredOutput: { data: structured } }, partialText: null },
        ],
        proofEvidence: null,
        raw: { status: 'completed' },
        partialText: null,
        structured,
        usable: true,
        reason: null,
      }
    })
    const contributions = []
    for (const child of children) contributions.push(await runner.publishRawContribution(batch, child))
    const result: NativeBatchResult = { batch: batch.batch, children, raw: {}, complete: true }
    const next = await runner.completeStage(batch, result, contributions, () => true)
    expect(next?.stage).toBe('synthesis')
    expect(next?.rootAttemptId).toBe(root.recordId)
    expect(next?.batch.tasks.tasks[0]?.action.inputs.fingerprint).toBe(initial.inputs.fingerprint)
    await rejectForeignRoot(world, root, rootParts, synthesisRequest, selected)
  })
})
