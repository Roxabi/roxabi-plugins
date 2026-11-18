import type { Gh } from '../adapters/github/types.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const repository = 'acme/app'
const date = '2026-10-27T12:00:00Z'

type Review = {
  branch: string
  head: string
  base: string
  merge: string
  review: { issueHistory: DecodedHistory; history: DecodedHistory }
}

export async function persistParentReviews(box: Box, checkout: string, gh: Gh, reviews: readonly Review[]) {
  writeSim(box, (state) => {
    for (const [i, item] of reviews.entries()) {
      if (!state.issues[String(201 + i)]) throw new Error('Child issue missing')
      state.prs[String(301 + i)] = {
        number: 301 + i,
        body: `Closes #${201 + i}`,
        state: 'MERGED',
        headRefName: item.branch,
        headRefOid: item.head,
        baseRefName: 'main',
        isCrossRepository: false,
        labels: [],
        autoMerge: null,
        closes: [201 + i],
        mergedAt: date,
        mergeCommit: { oid: item.merge, parents: [item.base, item.head] },
        baseRecord: { at: `main@${item.head}`, oid: item.base },
        comments: [],
      }
      for (const sha of [item.base, item.head, item.merge])
        state.checks[sha] = [
          { name: 'fixture-ci', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'fixture', startedAt: date },
        ]
    }
  })
  for (const [i, item] of reviews.entries()) {
    const issue = readSim(box).issues[String(201 + i)]
    if (!issue) throw new Error('Child issue missing')
    const existing = new Set(issue.comments.map((comment) => comment.body))
    for (const comment of item.review.issueHistory.source.comments) {
      if (!existing.has(comment.body))
        await gh(checkout, [
          'api',
          '--method',
          'POST',
          `repos/${repository}/issues/${201 + i}/comments`,
          '-f',
          `body=${comment.body}`,
        ])
    }
    for (const comment of item.review.history.source.comments)
      await gh(checkout, [
        'api',
        '--method',
        'POST',
        `repos/${repository}/issues/${301 + i}/comments`,
        '-f',
        `body=${comment.body}`,
      ])
  }
}
