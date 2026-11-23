import { decodeHistory } from '../adapters/github/history-codec.ts'
import { REVIEW_BRANCH as BRANCH, REVIEW_SCOPE as SCOPE } from './feature-review-fixture.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

export const PULL_SCOPE = { repository: 'acme/app', target: 'acme/app#7' }

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
