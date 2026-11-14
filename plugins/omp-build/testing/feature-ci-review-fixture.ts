import { execFileSync, spawnSync } from 'node:child_process'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { criterionReviewGraph } from './criterion-approval.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { REVIEW_BRANCH as BRANCH, REVIEW_SCOPE as SCOPE } from './feature-review-fixture.ts'
import { roxabiRecordFixtures } from './roxabi-presets.ts'
import { readSim, WORKFLOW, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
export const PULL_SCOPE = { repository: 'acme/app', target: 'acme/app#7' }
const { projection } = roxabiRecordFixtures()

export function featureMandate(box: Box) {
  const comments = readSim(box).issues['42']?.comments ?? []
  const history = decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  const record = history.operations.find((operation) => operation.record?.kind === 'mandate')?.record
  if (record?.kind !== 'mandate') throw new Error('feature-mandate-missing')
  return { record, history }
}

export function pullHistory(box: Box) {
  const comments = readSim(box).prs['7']?.comments ?? []
  return decodeHistory({
    scope: PULL_SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
}

export function captureReviewInput(box: Box, cwd: string, head: string): ActionInputs {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: 7, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`capture review input failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as { ok?: unknown; inputs?: ActionInputs }
  if (captured.ok !== true || captured.inputs === undefined) throw new Error(`review input unavailable: ${run.stdout}`)
  return captured.inputs
}

export function appendApprovedReview(box: Box, cwd: string): void {
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  const inputs = captureReviewInput(box, cwd, head)
  const { record: mandate, history } = featureMandate(box)
  const issueRecords = history.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const review = criterionReviewGraph({
    mandate,
    issueRecords,
    pullHistory: pullHistory(box),
    issueHistory: history,
    scope: PULL_SCOPE,
    head,
    inputs,
    projection,
    graph: graphFromSimulatedIssues(SCOPE, Object.values(readSim(box).issues)),
    contextHistories: [],
    author: 'operator',
    verdict: 'Approve (clean)',
    prefix: 'feature-ci-handoff',
  })
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (pull === undefined) throw new Error('feature-pull-missing')
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature-issue-missing')
    issue.comments.push(...review.issueComments.map(({ body }) => ({ author: 'operator', body })))
    pull.comments.push(
      ...review.comments.map(({ body }) => ({
        author: 'operator',
        body,
        createdAt: '2026-10-22T11:00:00Z',
        updatedAt: '2026-10-22T11:00:00Z',
      })),
    )
  })
}

export function setFailedCi(box: Box): void {
  const head = box.sha[BRANCH]
  if (head === undefined) throw new Error('feature-head-missing')
  writeSim(box, (state) => {
    state.checks[head] = [
      Object.assign(
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'ci',
          startedAt: '2026-10-22T12:00:00Z',
        },
        { id: 'check-run-1' },
      ),
      Object.assign(
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'status',
          startedAt: '2026-10-22T12:00:00Z',
        },
        { kind: 'status-context', context: 'ci', id: 'status-1' },
      ),
    ]
  })
}
