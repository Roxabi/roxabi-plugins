import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { seedMandate } from '../testing/review-gate-arrangement.ts'
import {
  cleanupReviewGateFixture,
  type ReviewGateFixture,
  setupReviewGateFixture,
} from '../testing/review-gate-fixture.ts'
import { AUTOMATION } from '../testing/review-gate-gh.ts'
import { readProductionActionFactsBatch } from './uw-action-batch-facts.ts'
import type { ReviewActionBatch, UwActionRequest } from './uw-action-contract.ts'
import { prepareReviewActions } from './uw-action-review-batch.ts'
import { createProductionActionPorts } from './uw-input-readers.ts'

const repository = 'acme/app'
const uw = { repository, target: 'acme/app#42' }
const pullRequest = { repository, target: 'acme/app#7' }

afterEach(cleanupReviewGateFixture)

function nativeGh(fixture: ReviewGateFixture, calls: string[][]) {
  return async (_cwd: string, args: string[]) => {
    calls.push([...args])
    const target =
      args[0] === 'pr'
        ? [...args, '--repo', repository]
        : args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
          ? ['repo', 'view', repository, ...args.slice(2)]
          : args
    const result = spawnSync('gh', target, { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
    return String(result.stdout).trim()
  }
}

function request(fixture: ReviewGateFixture): UwActionRequest {
  return {
    actionId: 'native-spec',
    purpose: 'review',
    subject: { kind: 'uw', uw, pullRequest, binding: null },
    code: { repository, base: fixture.base, head: fixture.head, referenceCommit: fixture.head },
    stageSources: [],
    expandedContext: [],
  }
}

function batch(first: UwActionRequest): ReviewActionBatch {
  const chunks = [{ index: 0, delta: [], diff: 'native patch', files: [], digest: 'native digest' }]
  return {
    actions: [
      { request: first, projection: { taskName: 'spec', assignedChunk: null, contextWindow: 100_000, chunks } },
      {
        request: { ...first, actionId: 'native-panel' },
        projection: { taskName: 'panel-0-tester', assignedChunk: 0, contextWindow: 100_000, chunks },
      },
    ],
  }
}

it('observes genuine UW and PR histories and produces complete facts for each review role', async () => {
  const fixture = setupReviewGateFixture()
  await seedMandate(fixture)
  const calls: string[][] = []
  const gh = nativeGh(fixture, calls)
  const first = request(fixture)
  const second = { ...first, actionId: 'native-panel' }
  const result = await readProductionActionFactsBatch([first, second], {
    cwd: fixture.candidate,
    gh,
    readAuthor: AUTOMATION,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  expect(result.value.map((entry) => entry.actionId)).toEqual(['native-spec', 'native-panel'])
  const [spec, panel] = result.value
  if (!spec || !panel) throw new Error('missing review role facts')
  expect(spec.facts).toEqual(panel.facts)
  expect(spec.facts.spec.kind).toBe('accepted')
  expect(spec.facts.acceptedSources.length).toBeGreaterThan(0)
  expect(spec.facts.subject).toMatchObject({ kind: 'uw', uw, pullRequest })
  expect(calls.some((args) => args.some((arg) => arg.includes('/issues/42/comments')))).toBe(true)
  expect(calls.some((args) => args.some((arg) => arg.includes('/issues/7/comments')))).toBe(true)

  const options = {
    cwd: fixture.candidate,
    gh,
    readAuthor: AUTOMATION,
    artifactsDir: path.join(fixture.root, 'artifacts'),
    pluginPin: {
      repository: 'Roxabi/roxabi-plugins',
      commit: fixture.pin,
      installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
    },
  }
  const prepared = await prepareReviewActions(batch(first), createProductionActionPorts(options))
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics))
  const [firstRole, secondRole] = prepared.value
  if (!firstRole || !secondRole) throw new Error('missing prepared role')
  expect(firstRole.inputs).toEqual(secondRole.inputs)
  expect(firstRole.snapshot.actionId).toBe('native-spec')
  expect(secondRole.snapshot.actionId).toBe('native-panel')
  expect(firstRole.snapshot.id).not.toBe(secondRole.snapshot.id)
})

it('refuses heterogeneous native review requests before treating them as a shared cut', async () => {
  const fixture = setupReviewGateFixture()
  await seedMandate(fixture)
  const calls: string[][] = []
  const first = request(fixture)
  const result = await readProductionActionFactsBatch(
    [
      first,
      {
        ...first,
        actionId: 'native-panel',
        expandedContext: [
          { source: 'git-file', repository, commit: fixture.head, path: 'candidate.txt', digest: '0'.repeat(64) },
        ],
      },
    ],
    { cwd: fixture.candidate, gh: nativeGh(fixture, calls), readAuthor: AUTOMATION },
  )
  expect(result.ok).toBe(false)
  expect(calls).toEqual([])
})

it('keeps ordinary standalone review independent of external histories and captured catalogues', async () => {
  const fixture = setupReviewGateFixture()
  const calls: string[][] = []
  const first: UwActionRequest = {
    ...request(fixture),
    subject: { kind: 'standalone-pr', pullRequest },
  }
  const result = await readProductionActionFactsBatch([first, { ...first, actionId: 'native-panel' }], {
    cwd: fixture.candidate,
    gh: nativeGh(fixture, calls),
    readAuthor: AUTOMATION,
  })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error('standalone native batch refused')
  expect(result.value).toHaveLength(2)
  expect(result.value[0]?.facts.spec).toEqual({ kind: 'absent', reason: 'standalone-review' })
  expect(result.value[1]?.facts).toEqual(result.value[0]?.facts)
  expect(calls.some((args) => args.some((arg) => arg.includes('/issues/42/comments')))).toBe(false)
  expect(calls.some((args) => args.some((arg) => arg.includes('/git/blobs/')))).toBe(false)
})
