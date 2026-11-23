import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { decodeHistory, encodeRecord } from '../../adapters/github/history-codec.ts'
import { actionInputDigest, canonicalValueDigest } from '../../engine/action-input.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import {
  arrangeReviewFixture,
  nativeFeatureSpec,
  REVIEW_BRANCH,
  REVIEW_SCOPE,
} from '../../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { appendSimIssueComments, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const REPLAY = path.resolve(import.meta.dirname, 'feature-operand-replay-runner.ts')
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('cold replays the owned expanded assessment after an authenticated missing-context result, but not alongside another pending assessment', () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const head = box.sha[REVIEW_BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const accepted = nativeFeatureSpec(REVIEW_SCOPE, 'preserves the region')
  const proposed = nativeFeatureSpec(REVIEW_SCOPE, 'preserves the region and its timezone')
  const workflow = roxabiWorkflowFixtures()
  const mandate = workflow.featureMandate(REVIEW_SCOPE, {
    branch: REVIEW_BRANCH,
    body: accepted.body,
    ownSpec: accepted.ownSpec,
    lineageHead: head,
    tier: 'F-lite',
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.body = proposed.body
    issue.comments.push(...workflow.framedBodies([mandate], 'operator').map((body) => ({ author: 'operator', body })))
  })
  const authoredComments = () => readSim(box).issues['42']?.comments.map(({ author, body }) => ({ author, body }))
  const commentsBeforePreparation = authoredComments()
  const run = spawnSync(BUN, [REPLAY, cwd, JSON.stringify({ uw: REVIEW_SCOPE, head }), 'prepare'], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`assessment preparation failed: ${run.stderr}\n${run.stdout}`)
  expect(authoredComments()).toEqual(commentsBeforePreparation)
  const action = JSON.parse(run.stdout) as {
    start: CanonicalRecord
    inputs: ActionInputs
    snapshot: { indexPath: string }
  }
  expect(action.snapshot).toMatchObject({ indexPath: expect.stringContaining('index.md') })
  expect(action.inputs.manifest.operands).toMatchObject({
    action: 'assess-spec',
    exactInputs: {
      accepted: { snapshot: { spec: { criteria: [{ statement: 'preserves the region' }] } } },
      proposed: { snapshot: { spec: { criteria: [{ statement: 'preserves the region and its timezone' }] } } },
    },
  })
  const history = () =>
    decodeHistory({
      scope: REVIEW_SCOPE,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
        locator: `acme/app#42:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  const publish = (record: CanonicalRecord) => {
    const encoded = encodeRecord(record, history().source, null)
    if (!encoded.ok) throw new Error('assessment receipt encoding invalid')
    appendSimIssueComments(box, '42', encoded.value, 'operator', '2026-10-22T12:00:00Z')
  }
  publish(action.start)
  const start = history().operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'assess-spec' &&
      operation.record.payload.phase === 'start',
  )?.record
  if (start?.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
    throw new Error('assessment start missing')
  const negative = buildRecord({
    version: 1,
    repository: start.repository,
    target: start.target,
    recordId: 'assessment-context-negative',
    runId: start.runId,
    operationId: 'assessment-context-negative-operation',
    kind: 'action-receipt',
    payload: {
      ...start.payload,
      phase: 'result',
      start: { scope: REVIEW_SCOPE, recordId: start.recordId, kind: 'action-receipt' },
      native: { completion: 'completed', strict: 'valid', raw: null },
      structured: {
        outcome: 'missing-context',
        missing: [
          {
            locator: { kind: 'file-request', repository: 'acme/app', path: 'src/save.ts', revisionHint: null },
            reason: 'Need the implementation context',
            targets: [],
          },
        ],
      },
      admission: null,
      diagnostics: [],
    },
  })
  if (!negative.ok) throw new Error('assessment negative invalid')
  publish(negative.value)
  const manifest = {
    ...action.inputs.manifest,
    expandedContext: [
      ...action.inputs.manifest.expandedContext,
      {
        source: 'record' as const,
        record: { scope: REVIEW_SCOPE, recordId: negative.value.recordId, kind: 'action-receipt' as const },
        selector: '/payload',
        digest: canonicalValueDigest(negative.value.payload),
      },
      {
        source: 'git-file' as const,
        repository: REVIEW_SCOPE.repository,
        commit: head,
        path: 'src/save.ts',
        digest: createHash('sha256').update('export const save = true\n').digest('hex'),
      },
    ],
  }
  const expanded: ActionInputs = { ...action.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const successor = buildRecord({
    ...start,
    recordId: 'expanded-assessment-start',
    operationId: 'expanded-assessment-start-operation',
    payload: { ...start.payload, actionId: 'expanded-assessment-action', inputs: expanded },
  })
  if (!successor.ok) throw new Error('expanded assessment start invalid')
  publish(successor.value)
  rmSync(path.dirname(action.snapshot.indexPath), { recursive: true, force: true })
  const requestFile = path.join(box.root, 'expanded-assessment-request.json')
  writeFileSync(
    requestFile,
    JSON.stringify({
      reviewed: expanded,
      request: {
        actionId: 'expanded-assessment-action',
        purpose: manifest.purpose,
        subject: manifest.subject,
        code: manifest.code,
        stageSources: expanded.stageSources,
        expandedContext: manifest.expandedContext,
        operands: manifest.operands,
      },
    }),
  )
  const replay = () => {
    const before = structuredClone(readSim(box).issues['42']?.comments ?? [])
    const child = spawnSync(BUN, [REPLAY, cwd, requestFile], {
      cwd,
      env: box.env,
      encoding: 'utf8',
    })
    if (child.status !== 0) throw new Error(`replay failed: ${child.stderr}\n${child.stdout}`)
    expect(readSim(box).issues['42']?.comments).toEqual(before)
    return JSON.parse(child.stdout) as { ok: boolean }
  }
  expect(replay(), 'owned expanded assessment').toMatchObject({ ok: true })
  const other = buildRecord({
    ...start,
    recordId: 'another-assessment-start',
    operationId: 'another-assessment-start-operation',
    payload: { ...start.payload, actionId: 'another-assessment-action' },
  })
  if (!other.ok) throw new Error('other assessment start invalid')
  publish(other.value)
  expect(replay(), 'unrelated pending assessment').toMatchObject({ ok: false })
})
