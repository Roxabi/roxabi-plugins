import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../engine/uw-spec-schema.ts'
import { hashReviewInput } from '../skills/feature/review-input.ts'
import { confirmedReviewSemanticContext } from '../skills/feature/workflow-review-input.js'
import { git, type ReviewGateFixture, readState, writeState } from './review-gate-fixture.ts'
import { AUTOMATION, type IssueState, PR_EDITED, PR_TEXT, SCOPE, type StoredComment } from './review-gate-gh.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'

const ISSUE_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export function nativeFeatureSpec(criterion: string): string {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  return renderIssueSpecBody(canonical.value)
}
const SPEC = nativeFeatureSpec('Save keeps the selected region')
const { encodedAdmissionReviewGraph } = roxabiRecordFixtures()
const { framedBodies, historyFrom, ownSpecFromSnapshot, workflowBinding } = roxabiWorkflowFixtures()

export { SPEC }

export function reviewBodies(
  head: string,
  prefix: string,
  input: string | null = null,
  verdict: 'Approve' | 'Request changes' = 'Approve',
): string[] {
  return encodedAdmissionReviewGraph({ scope: SCOPE, head, input, prefix, verdict }).comments.map(
    (comment) => comment.body,
  )
}

export function cleanReview(head: string, prefix: string, input: string | null = null): string[] {
  return reviewBodies(head, prefix, input)
}

export function approvals(head: string, input: string | null = null): string[] {
  return ['one', 'two', 'three'].flatMap((prefix) => cleanReview(head, prefix, input))
}

export function capturedCiFailure(reviewId = 'three-final') {
  return {
    ok: false as const,
    allowed: false as const,
    reason: 'ci-failed' as const,
    detail: { reviewId, detail: { reviews: 3, ci: 'red' as const } },
  }
}

export async function seedMandate(fixture: ReviewGateFixture, spec = SPEC): Promise<void> {
  const parsed = parseIssueSpecBody({ uw: ISSUE_SCOPE, raw: rawSource(ISSUE_SCOPE.target, spec, PR_EDITED) })
  if (parsed.status !== 'conformant') throw new Error('review gate fixture Spec is not conformant')
  const mandate = roxabiWorkflowFixtures().featureMandate(ISSUE_SCOPE, {
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    branch: 'feat/7-fixture',
    base: 'main',
    lineageHead: fixture.head,
    body: spec,
    ownSpec: ownSpecFromSnapshot(ISSUE_SCOPE, parsed.snapshot),
  })
  const binding = workflowBinding(SCOPE, mandate, 'feat/7-fixture', 'main')
  const state = readState(fixture)
  const issue: IssueState = {
    body: spec,
    updatedAt: PR_EDITED,
    state: 'OPEN',
    labels: [{ name: 'size:S' }],
    comments: historyFrom([mandate], AUTOMATION).source.comments.map((comment, index) =>
      stored(comment.body, 4200 + index),
    ),
  }
  state.prBody = PR_TEXT
  state.prEditedAt = PR_EDITED
  state.issues['42'] = issue
  const mandateHistory = historyFrom([mandate], AUTOMATION)
  const bindingBodies = framedBodies([binding], AUTOMATION, [mandateHistory])
  state.comments = [
    ...state.comments.filter((comment) => recordKind(comment.body) !== 'workflow-binding'),
    ...bindingBodies.map((body, index) => stored(body, 5000 + index)),
  ]
  state.nextCommentId = Math.max(state.nextCommentId, 5000 + bindingBodies.length)
  writeState(fixture, state)
}

export function setMandateIssue(
  fixture: ReviewGateFixture,
  patch: { state?: string; body?: string; updatedAt?: string | null },
): void {
  const state = readState(fixture)
  const issue = state.issues['42']
  if (!issue) throw new Error('mandate issue 42 is missing')
  if (patch.state !== undefined) issue.state = patch.state
  if (patch.body !== undefined) issue.body = patch.body
  if (patch.updatedAt !== undefined) issue.updatedAt = patch.updatedAt
  writeState(fixture, state)
}

export async function reviewSemanticContext(fixture: ReviewGateFixture) {
  return confirmedReviewSemanticContext(fixture.tools, 7, gateGh(fixture), 'main', AUTOMATION)
}

export async function boundInput(fixture: ReviewGateFixture): Promise<string> {
  const semantic = await reviewSemanticContext(fixture)
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput(
    'acme/app',
    { pr: 7, candidate: fixture.head },
    { body: PR_TEXT, lastEditedAt: PR_EDITED },
    semantic,
  )
}

export async function standaloneNoProducerInput(fixture: ReviewGateFixture): Promise<string> {
  const state = readState(fixture)
  state.comments = state.comments.filter((comment) => recordKind(comment.body) !== 'workflow-binding')
  for (const issue of Object.values(state.issues))
    issue.comments = issue.comments.filter((comment) => recordKind(comment.body) !== 'mandate')
  writeState(fixture, state)
  const semantic = await reviewSemanticContext(fixture)
  if ('ok' in semantic) throw new Error(semantic.error)
  if (semantic.mode !== 'standalone')
    throw new Error('standalone no-producer input requires an absent workflow-binding')
  return hashReviewInput(
    'acme/app',
    { pr: 7, candidate: fixture.head },
    { body: state.prBody, lastEditedAt: state.prEditedAt },
    semantic,
  )
}

export function advanceOriginNormativeStack(fixture: ReviewGateFixture, origin: string): string {
  const stage = path.join(fixture.root, 'origin-stage')
  git(fixture.root, ['clone', '-q', origin, stage])
  mkdirSync(path.join(stage, '.dev'), { recursive: true })
  writeFileSync(
    path.join(stage, '.dev/stack.yml'),
    'review:\n  additional_requirements:\n    - updated normative requirement\n',
  )
  git(stage, ['add', '.dev/stack.yml'])
  git(stage, ['commit', '-qm', 'advance origin/main normative stack'])
  git(stage, ['push', '-q', 'origin', 'HEAD:main'])
  return git(stage, ['rev-parse', 'HEAD'])
}

function gateGh(fixture: ReviewGateFixture) {
  return async (_cwd: string, args: string[]) => {
    const targetArgs =
      args[0] === 'pr'
        ? [...args, '--repo', SCOPE.repository]
        : args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
          ? ['repo', 'view', SCOPE.repository, ...args.slice(2)]
          : args
    const result = spawnSync('gh', targetArgs, { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
    return String(result.stdout).trim()
  }
}

function recordKind(body: string): string | null {
  const framed = /^<!-- omp-build-record v=1 kind=([a-z][a-z0-9-]*) /.exec(body)
  if (framed?.[1]) return framed[1]
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed) || typeof parsed.kind !== 'string') return null
    return parsed.kind
  } catch {
    return null
  }
}

function stored(body: string, id: number): StoredComment {
  return { id, body, user: { login: AUTOMATION }, created_at: PR_EDITED, updated_at: PR_EDITED }
}
