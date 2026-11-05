import { decodeHistory } from '../../../../contracts.ts'
import type { ActionInputs } from '../../../../engine/action-input-schema.ts'
import { committedFixtureProjection } from '../../../../testing/committed-plugin-fixture.ts'
import { criterionPullHistory, criterionReviewGraph } from '../../../../testing/criterion-approval.ts'
import type { Comment } from './goal-scenario-domain.ts'
import { callWorkflow, gh, readSim, toolingFixture } from './goal-scenario-sandbox.ts'

export function nativeComments(issue: number, comments: Comment[]) {
  return comments.map((comment, index) => ({
    locator: `acme/app#${issue}:comment:${comment.id ?? index + 1}`,
    nativeId: String(comment.id ?? index + 1),
    body: comment.body,
    author: comment.author,
    createdAt: comment.createdAt ?? '2026-01-01T00:00:00Z',
    updatedAt: comment.updatedAt ?? comment.createdAt ?? '2026-01-01T00:00:00Z',
  }))
}

export function approve(pr: number, sha: string, cwd: string): void {
  const captured = callWorkflow<{
    ok: boolean
    input?: string | null
    inputs?: ActionInputs
    error?: string
  }>('captureReviewInput', cwd, { pr, head: sha })
  const inputs = captured.inputs
  if (
    !captured.ok ||
    typeof captured.input !== 'string' ||
    !/^[0-9a-f]{64}$/.test(captured.input) ||
    inputs === undefined ||
    inputs.fingerprint !== captured.input
  )
    throw new Error(`approve #${pr}: captureReviewInput failed ${JSON.stringify(captured)}`)
  const tooling = toolingFixture()
  if (inputs.manifest.plugin.commit !== tooling.commit)
    throw new Error(`approve #${pr}: captured tooling pin differs from the fixture checkout`)
  const subject = inputs.manifest.subject
  if (subject.kind !== 'uw') throw new Error(`approve #${pr}: expected UW review input`)
  const scope = subject.uw
  const number = Number(scope.target.split('#').at(-1))
  const issue = readSim().issues[String(number)]
  if (!issue) throw new Error(`approve #${pr}: missing issue ${scope.target}`)
  const history = decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: nativeComments(number, issue.comments),
    diagnostics: [],
  })
  const issueRecords = history.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const accepted = inputs.manifest.spec
  const mandate = issueRecords.find(
    (record) =>
      record.kind === 'mandate' &&
      accepted.kind === 'accepted' &&
      record.recordId === accepted.effective.own.sourceAccepted.recordId,
  )
  if (mandate?.kind !== 'mandate') throw new Error(`approve #${pr}: missing accepted mandate`)
  const pull = readSim().prs[String(pr)]
  if (!pull) throw new Error(`approve #${pr}: missing PR`)
  const pullHistory = criterionPullHistory({ repository: 'acme/app', target: `acme/app#${pr}` }, pull.comments)
  const review = criterionReviewGraph({
    mandate,
    issueRecords,
    issueHistory: history,
    pullHistory,
    scope: { repository: 'acme/app', target: `acme/app#${pr}` },
    head: sha,
    inputs,
    projection: committedFixtureProjection(tooling.cwd, inputs),
    prefix: `scenario-${pr}-${sha.slice(0, 8)}`,
    author: 'operator',
  })
  for (const comment of review.issueComments) {
    const result = gh(['issue', 'comment', String(number), '--body', comment.body])
    if (result.status !== 0) throw new Error(`approve origin #${number}: ${result.stderr}`)
  }
  for (const comment of review.comments) {
    const review = gh(['pr', 'comment', String(pr), '--body', comment.body])
    if (review.status !== 0) throw new Error(`approve #${pr}: ${review.stderr}`)
  }
}
