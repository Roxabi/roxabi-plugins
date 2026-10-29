import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { hostActionBinding } from '../omp/review-runtime/action-registry.ts'
import { fixtureUwOperations, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { createSynthesisBatch } from './review-runner-outcomes.ts'
import type { CurrentActionFacts, ReviewActionBatch, UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { actionOperationMethods } from './uw-action-operations.ts'

const baseline = standaloneReviewInputs()
const bytes = Buffer.from('installed plugin fixture')
const roots: string[] = []

function batch(): ReviewActionBatch {
  const request: UwActionRequest = {
    actionId: 'panel-a',
    purpose: 'review',
    subject: baseline.manifest.subject,
    code: baseline.manifest.code,
    stageSources: [],
    expandedContext: [],
  }
  const chunks = [
    { index: 0, delta: [], diff: 'first patch', files: [], digest: 'first digest' },
    { index: 1, delta: [], diff: 'second patch', files: [], digest: 'second digest' },
  ]
  return {
    actions: [
      { request, projection: { taskName: 'spec', assignedChunk: null, contextWindow: 100_000, chunks } },
      {
        request: { ...request, actionId: 'panel-b' },
        projection: { taskName: 'panel-1-tester', assignedChunk: 1, contextWindow: 100_000, chunks },
      },
    ],
  }
}

function fixture(
  driftOnConfirmation = false,
  divergentRole = false,
  batchResult: 'ordered' | 'reversed' | 'missing' | 'duplicate' = 'ordered',
) {
  const root = mkdtempSync(join(tmpdir(), 'review-batch-'))
  roots.push(root)
  let generation = 0
  const batchReads: string[][] = []
  const singleReads: { actionId: string; fingerprint?: string }[] = []
  const facts = (request: UwActionRequest): CurrentActionFacts => ({
    spec: baseline.manifest.spec,
    subject: request.subject,
    acceptedSources: [],
    deliveryData: [],
    currentOutputs: [],
    configuration: {
      ...baseline.manifest.configuration,
      digest: (generation !== 0 || (divergentRole && request.actionId === 'panel-b') ? 'b' : 'a').repeat(64),
    },
  })
  const ports: UwActionPorts = {
    readCurrentActionFacts: async (request, fingerprint) => {
      singleReads.push({ actionId: request.actionId, fingerprint })
      return { ok: true, value: facts(request) }
    },
    readCurrentActionFactsBatch: async (requests) => {
      batchReads.push(requests.map((request) => request.actionId))
      if (driftOnConfirmation && batchReads.length === 2) generation++
      const entries = requests.map((request) => ({ actionId: request.actionId, facts: facts(request) }))
      if (batchResult === 'reversed') entries.reverse()
      if (batchResult === 'missing') entries.pop()
      if (batchResult === 'duplicate' && entries[0] !== undefined && entries[1] !== undefined) entries[1] = entries[0]
      return { ok: true, value: entries }
    },
    readRecord: async () => ({ ok: true, value: {} }),
    readRecords: async (refs) => ({ ok: true, value: refs.map(() => ({})) }),
    readPinnedFile: async () => ({ ok: true, value: bytes }),
    readCodeDiff: async () => ({ ok: true, value: Buffer.from('whole diff') }),
    repositoryReferences: async () => ({ ok: true, value: [] }),
    plugin: {
      resolveInstalledPluginPin: async () => ({
        ok: true,
        value: {
          name: 'omp-build',
          version: baseline.manifest.plugin.version,
          repository: baseline.manifest.plugin.repository,
          commit: baseline.manifest.plugin.commit,
          root: baseline.manifest.plugin.root,
        },
      }),
      readInstalledFile: async () => ({ ok: true, value: bytes }),
    },
    snapshots: {
      create: async ({ actionId, files }) => {
        const directory = join(root, `${actionId}-${generation}`)
        for (const file of files) {
          const path = join(directory, file.path)
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, file.bytes)
        }
        return { ok: true, value: { indexPath: join(directory, 'index.md'), location: 'local' } }
      },
    },
  }
  return {
    operations: actionOperationMethods({ actions: ports }),
    batchReads,
    singleReads,
    drift: () => {
      generation++
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('batch seals distinct role handles and their assigned projections', async () => {
  const { operations, batchReads } = fixture()
  const prepared = await operations.prepareReviewActions(batch())
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  expect(batchReads).toEqual([
    ['panel-a', 'panel-b'],
    ['panel-a', 'panel-b'],
  ])
  expect(prepared.value).toHaveLength(2)
  const [first, second] = prepared.value
  if (first === undefined || second === undefined) throw new Error('batch did not return both actions')
  expect(first.snapshot).not.toBe(second.snapshot)
  expect(first.snapshot.actionId).toBe('panel-a')
  expect(second.snapshot.actionId).toBe('panel-b')
  expect(first.snapshot.indexPath).not.toBe(second.snapshot.indexPath)
  expect(first.inputs.fingerprint).toBe(second.inputs.fingerprint)
  for (const [action, role, chunk] of [
    [first, 'spec', null],
    [second, 'panel-1-tester', 1],
  ] as const) {
    const directory = dirname(action.snapshot.indexPath)
    const assignment = JSON.parse(readFileSync(join(directory, 'review/assignment.json'), 'utf8'))
    expect(assignment.taskName).toBe(role)
    expect(assignment.assignedChunk).toBe(chunk)
    expect(readFileSync(join(directory, 'review/chunks/1.patch'), 'utf8')).toBe('second patch')
    if (chunk === null) expect(readFileSync(join(directory, 'review/chunks/0.patch'), 'utf8')).toBe('first patch')
    else expect(existsSync(join(directory, 'review/chunks/0.patch'))).toBe(false)
    expect(readFileSync(join(directory, 'review/digests/0.md'), 'utf8')).toBe('first digest')
    expect(readFileSync(join(directory, 'review/digests/1.md'), 'utf8')).toBe('second digest')
    expect((await operations.verifyAction(action.snapshot)).ok).toBe(true)
  }
})

test('tampering with one sealed dossier does not invalidate its sibling', async () => {
  const { operations } = fixture()
  const prepared = await operations.prepareReviewActions(batch())
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  const [first, second] = prepared.value
  if (first === undefined || second === undefined) throw new Error('batch did not return both actions')
  writeFileSync(join(dirname(first.snapshot.indexPath), 'review/chunks/0.patch'), 'tampered')
  expect((await operations.verifyAction(first.snapshot)).ok).toBe(false)
  expect((await operations.verifyAction(second.snapshot)).ok).toBe(true)
})

test('registered bindings reject mutation of a returned action input without changing its sibling', async () => {
  const { operations } = fixture()
  const prepared = await operations.prepareReviewActions(batch())
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  const [first, second] = prepared.value
  if (first === undefined || second === undefined) throw new Error('batch did not return both actions')
  expect(hostActionBinding(first.snapshot, first.inputs)).not.toBeNull()
  expect(hostActionBinding(second.snapshot, second.inputs)).not.toBeNull()
  first.inputs.manifest.configuration.serialized = 'mutated after sealing'
  expect(hostActionBinding(first.snapshot, first.inputs)).toBeNull()
  expect(hostActionBinding(second.snapshot, second.inputs)).not.toBeNull()
})

test('one invalid role projection refuses the entire batch', async () => {
  const { operations } = fixture()
  const input = batch()
  const second = input.actions[1]
  const first = input.actions[0]
  if (first === undefined || second === undefined) throw new Error('batch fixture requires two actions')
  const result = await operations.prepareReviewActions({
    actions: [
      first,
      { ...second, projection: { ...second.projection, taskName: 'panel-99-tester', assignedChunk: 99 } },
    ],
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'action-input-missing')).toBe(true)
})

test('facts specific to one action cannot be replaced by another action’s facts', async () => {
  const { operations, batchReads } = fixture(false, true)
  const result = await operations.prepareReviewActions(batch())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'review-input-changed')).toBe(true)
  expect(batchReads[0]).toEqual(['panel-a', 'panel-b'])
})

test.each(['missing', 'duplicate', 'reversed'] as const)('refuses %s action identities in a fact cut', async (mode) => {
  const { operations } = fixture(false, false, mode)
  const result = await operations.prepareReviewActions(batch())
  expect(result.ok).toBe(false)
})

test('refuses different stage sources even when the common manifest would be unchanged', async () => {
  const { operations } = fixture()
  const input = batch()
  const [first, second] = input.actions
  if (first === undefined || second === undefined) throw new Error('batch fixture requires two actions')
  const ref = {
    source: 'record' as const,
    record: {
      scope: { repository: 'acme/app', target: 'acme/app#42' },
      kind: 'action-receipt' as const,
      recordId: 'stage',
    },
    selector: '/payload',
    digest: 'd'.repeat(64),
  }
  const result = await operations.prepareReviewActions({
    actions: [first, { ...second, request: { ...second.request, stageSources: [ref] } }],
  })
  expect(result.ok).toBe(false)
})

test('the next gate rereads current facts and refuses drift after the batch', async () => {
  const { operations, batchReads, singleReads, drift } = fixture()
  const input = batch()
  const prepared = await operations.prepareReviewActions(input)
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  const first = prepared.value[0]
  const request = input.actions[0]?.request
  if (first === undefined || request === undefined) throw new Error('batch fixture requires a first action')
  drift()
  const replay = await operations.replayActionInputs({ reviewed: first.inputs, request })
  expect(replay.ok).toBe(false)
  if (!replay.ok) expect(replay.diagnostics.some((diagnostic) => diagnostic.code === 'review-input-changed')).toBe(true)
  expect(batchReads).toHaveLength(2)
  expect(singleReads).toContainEqual({ actionId: 'panel-a', fingerprint: first.inputs.fingerprint })
})

test('the synthesis gate rejects facts that drift after the initial batch', async () => {
  const { operations, singleReads, drift } = fixture()
  const input = batch()
  const prepared = await operations.prepareReviewActions(input)
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  const spec = prepared.value[0]
  const projection = input.actions[0]?.projection
  if (spec === undefined || projection === undefined) throw new Error('batch fixture requires a first action')
  drift()
  const args = {
    review: {
      actions: { spec },
      operations: { ...fixtureUwOperations(), ...operations },
      chunks: projection.chunks,
      contextWindow: projection.contextWindow,
    },
    rootAttemptId: 'root',
    scope: { repository: 'acme/app', target: 'acme/app#42' },
    sourceContributions: [{ contributionId: 'contribution', payload: {} }],
    sourceContributionIds: new Set(['contribution']),
    knownSlots: new Map(),
    identity: {},
  } as unknown as Parameters<typeof createSynthesisBatch>[0]
  await expect(createSynthesisBatch(args)).rejects.toThrow('review-input-changed')
  expect(singleReads.map((read) => read.actionId)).toEqual(['root:synthesis', 'root:synthesis'])
  expect(singleReads[1]?.fingerprint).toBeDefined()
})

test('a later batch observes a fresh cut instead of retaining the initial facts', async () => {
  const { operations, batchReads, drift } = fixture()
  const input = batch()
  const first = await operations.prepareReviewActions(input)
  expect(first.ok).toBe(true)
  if (!first.ok) return
  drift()
  const next = await operations.prepareReviewActions(input)
  expect(next.ok).toBe(true)
  if (!next.ok) return
  expect(batchReads).toEqual([
    ['panel-a', 'panel-b'],
    ['panel-a', 'panel-b'],
    ['panel-a', 'panel-b'],
    ['panel-a', 'panel-b'],
  ])
  const [firstA, firstB] = first.value
  const [nextA, nextB] = next.value
  if (firstA === undefined || firstB === undefined || nextA === undefined || nextB === undefined)
    throw new Error('both batches must return two actions')
  expect(nextA.inputs.fingerprint).not.toBe(firstA.inputs.fingerprint)
  expect(nextB.inputs.fingerprint).not.toBe(firstB.inputs.fingerprint)
})

test('confirmation takes a fresh batch cut and refuses drift between cuts', async () => {
  const { operations, batchReads } = fixture(true)
  const result = await operations.prepareReviewActions(batch())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'review-input-changed')).toBe(true)
  expect(batchReads).toEqual([
    ['panel-a', 'panel-b'],
    ['panel-a', 'panel-b'],
  ])
})
