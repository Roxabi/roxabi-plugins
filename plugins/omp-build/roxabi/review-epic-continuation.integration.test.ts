import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../adapters/github-native/uw-spec.ts'
import type { NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { committedFixtureRecords } from '../testing/committed-plugin-fixture.ts'
import { criterionImplementationRecords } from '../testing/criterion-accepted-plan.ts'
import { nativeFeatureSpec } from '../testing/review-gate-arrangement.ts'
import {
  cleanupReviewGateFixture,
  type ReviewGateFixture,
  readState,
  setupReviewGateFixture,
  writeState,
} from '../testing/review-gate-fixture.ts'
import { AUTOMATION, PR_EDITED } from '../testing/review-gate-gh.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { allocateReviewPanel } from './review-panel.ts'
import { CanonicalReviewRunner, type PreparedReviewInputs } from './review-runner.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import { createInstalledUwOperations } from './uw-installed-operations.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }

afterEach(cleanupReviewGateFixture)

// The gate's real pinned-object ingress is reused; issue comments are written to
// the issue's own native history rather than the gate fixture's PR-only store.
function issueGh(fixture: ReviewGateFixture) {
  return async (_cwd: string, args: string[]): Promise<string> => {
    const endpoint = args.find((arg) => arg.startsWith('repos/acme/app/issues/42/comments'))
    if (endpoint && args.includes('POST')) {
      const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
      if (body === undefined) throw new Error('missing native comment body')
      const state = readState(fixture)
      const issue = state.issues['42']
      if (!issue) throw new Error('missing epic issue')
      const comment = {
        id: state.nextCommentId++,
        body,
        user: { login: AUTOMATION },
        created_at: PR_EDITED,
        updated_at: PR_EDITED,
      }
      issue.comments.push(comment)
      writeState(fixture, state)
      return JSON.stringify(comment)
    }
    const target =
      args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
        ? ['repo', 'view', scope.repository, ...args.slice(2)]
        : args
    const result = spawnSync('gh', target, { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
    return String(result.stdout).trim()
  }
}

it('continues an authenticated Epic range through installed action preparation, but refuses foreign and mismatched roots', async () => {
  const fixture = setupReviewGateFixture()
  const gh = issueGh(fixture)
  const spec = nativeFeatureSpec('Save keeps the selected region')
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, spec, PR_EDITED) })
  if (parsed.status !== 'conformant') throw new Error('epic fixture spec is not conformant')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.epicMandate(scope, [], {
    body: spec,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, parsed.snapshot),
  })
  const records = committedFixtureRecords(
    fixture.tools,
    [mandate, ...criterionImplementationRecords(mandate, fixture.head)],
    fixture.pin,
  )
  const state = readState(fixture)
  state.issues['42'] = {
    body: spec,
    updatedAt: PR_EDITED,
    state: 'OPEN',
    labels: [{ name: 'size:S' }],
    comments: fixtures.historyFrom(records, AUTOMATION).source.comments.map((comment, index) => ({
      id: 4200 + index,
      body: comment.body,
      user: { login: AUTOMATION },
      created_at: PR_EDITED,
      updated_at: PR_EDITED,
    })),
  }
  state.nextCommentId = 5000
  writeState(fixture, state)
  const operations = await createInstalledUwOperations({
    cwd: fixture.candidate,
    gh,
    readAuthor: AUTOMATION,
    artifactsDir: path.join(fixture.root, 'artifacts'),
    pluginPin: {
      repository: 'Roxabi/roxabi-plugins',
      commit: fixture.pin,
      installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
    },
    operator: {
      async executeConfirmed() {
        throw new Error('unexpected operator write')
      },
    },
  })
  const code = { repository: scope.repository, base: fixture.base, head: fixture.head, referenceCommit: fixture.head }
  const subject = { kind: 'uw' as const, uw: scope, pullRequest: null, binding: null }
  const chunks = [
    {
      index: 0,
      delta: ['candidate.txt'],
      diff: 'candidate',
      files: [{ path: 'candidate.txt', text: 'candidate\n', deleted: false, binary: false }],
      digest: 'candidate',
    },
  ]
  const roster: PreparedReviewInputs['roster'] = {
    delta: ['candidate.txt'],
    tier: 'S',
    chunks: 1,
    claims: [],
    pricedClaimOk: false,
    specDraft: false,
    axialAdr: false,
    stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
    config: { maxAgents: 5, axialOverride: 'default', overrides: {}, warnings: [] },
  }
  const config: PreparedReviewInputs['config'] = { canonicalClasses: [], chunker: 'chunker.py', digest: 'digest.py' }
  const panel = allocateReviewPanel({ chunks, roster, config, commonContext: 'Review the assigned chunk.' })
  const actions: Record<string, PreparedUwAction> = {}
  for (const name of ['spec', ...panel.tasks.map((task) => task.name)]) {
    const assignedChunk = name === 'spec' ? null : Number(/^panel-(\d+)-/.exec(name)?.[1])
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
  const range = `${fixture.base}..${fixture.head}`
  const review: PreparedReviewInputs = {
    context: {
      ...scope,
      number: 42,
      candidateGitSHA: fixture.head,
      input: initial.inputs.fingerprint,
      runId: 'epic-run',
      operationId: 'epic-op',
      subject: { kind: 'epic-range', range },
    },
    pr: { base: 'main', baseGitSHA: fixture.base },
    chunks,
    contextWindow: 200_000,
    roster,
    config,
    policy: { version: 'baseline' },
    semantic: { spec: 'spec', panel: 'panel', synthesis: 'synthesis' },
    observedEvidence: {
      reviewInput: null,
      candidate: { head: fixture.head, base: fixture.base },
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
    cwd: fixture.candidate,
    gh,
    readAuthor: AUTOMATION,
    writerLogin: AUTOMATION,
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

  const original = readState(fixture)
  const foreign = structuredClone(original)
  for (const comment of foreign.issues['42'].comments)
    if (comment.body.includes(`id=${root.recordId} `)) comment.user.login = 'foreign'
  writeState(fixture, foreign)
  const rejectedForeign = await operations.prepareAction(synthesisRequest, undefined, selected)
  expect(rejectedForeign.ok).toBe(false)
  writeState(fixture, original)
  const rejectedMismatch = await operations.prepareAction(synthesisRequest, undefined, {
    ...selected,
    root: { ...root, scope: { repository: scope.repository, target: 'acme/app#43' } },
  })
  expect(rejectedMismatch.ok).toBe(false)

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
})
