import { execFileSync } from 'node:child_process'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import {
  catalogueForAction,
  createReviewClassCatalogues,
  reviewClassCatalogueRef,
} from '../engine/review-class-catalogue.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { fixtureReviewCatalogueReads } from './action-input-fixtures.ts'
import { criterionReviewGraph } from './criterion-approval.ts'
import { type ReviewGateFixture, readState, writeState } from './review-gate-fixture.ts'
import { AUTOMATION, PR_EDITED, SCOPE } from './review-gate-gh.ts'
import { roxabiRecordFixtures } from './roxabi-presets.ts'

const ISSUE_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export type CriterionFixture = { mandate: MandateRecord; issueRecords: CanonicalRecord[] }
export type BoundCriterionFixture = CriterionFixture & { pullHistory: DecodedHistory; fixture: ReviewGateFixture }

export function boundReviewBodies(
  criterion: BoundCriterionFixture,
  inputs: ActionInputs,
  head: string,
  prefix: string,
  verdict: 'Approve' | 'Request changes',
): string[] {
  const { fixture, ...details } = criterion
  const state = readState(fixture)
  const issue = state.issues['42']
  if (!issue) throw new Error('review fixture origin issue is missing')
  const issueHistory = decodeHistory({
    scope: ISSUE_SCOPE,
    expectedAuthor: AUTOMATION,
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: issue.comments.map((comment) => ({
      locator: `${ISSUE_SCOPE.target}:comment:${comment.id}`,
      nativeId: String(comment.id),
      body: comment.body,
      author: comment.user.login,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
  })
  const ref = reviewClassCatalogueRef(inputs)
  if (!ref.ok) throw new Error(`Cannot select fixture catalogue: ${JSON.stringify(ref.diagnostics)}`)
  if (ref.value.repository !== 'Roxabi/roxabi-plugins' || ref.value.commit !== fixture.pin)
    throw new Error('Fixture action catalogue does not belong to the committed tooling checkout')
  const bytes = execFileSync('git', ['-C', fixture.tools, 'show', `${ref.value.commit}:${ref.value.path}`], {
    env: fixture.env,
  })
  const catalogues = createReviewClassCatalogues([
    ...fixtureReviewCatalogueReads(),
    { ref: ref.value, contents: { ok: true, value: bytes } },
  ])
  const catalogue = catalogueForAction(inputs, catalogues)
  if (!catalogue.ok) throw new Error(`Cannot load fixture catalogue: ${JSON.stringify(catalogue.diagnostics)}`)
  const review = criterionReviewGraph({
    ...details,
    issueHistory,
    inputs,
    head,
    scope: SCOPE,
    prefix,
    verdict,
    author: AUTOMATION,
    projection: { ...roxabiRecordFixtures().projection, catalogues },
  })
  for (const comment of review.issueComments) {
    issue.comments.push({
      id: ++state.nextCommentId,
      body: comment.body,
      user: { login: AUTOMATION },
      created_at: PR_EDITED,
      updated_at: PR_EDITED,
    })
  }
  writeState(fixture, state)
  return review.comments.map((comment) => comment.body)
}
