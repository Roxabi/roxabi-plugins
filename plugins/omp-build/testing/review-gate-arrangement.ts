import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../engine/uw-spec-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { createProductionActionPorts } from '../roxabi/uw-input-readers.ts'
import { confirmedReviewSemanticContext } from '../skills/feature/workflow-review-input.js'
import { freshReviewInputs, standaloneReviewInputs } from './action-input-fixtures.ts'
import { criterionImplementationRecords, criterionReviewGraph } from './criterion-approval.ts'
import { git, type ReviewGateFixture, readState, writeState } from './review-gate-fixture.ts'
import { AUTOMATION, type IssueState, PR_EDITED, PR_TEXT, SCOPE, type StoredComment } from './review-gate-gh.ts'
import { assembleActionInputs } from './review-input-assembly.ts'
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
const { encodedAdmissionReviewGraph, projection } = roxabiRecordFixtures()
const { framedBodies, historyFrom, ownSpecFromSnapshot, workflowBinding } = roxabiWorkflowFixtures()
type CriterionFixture = { mandate: MandateRecord; issueRecords: CanonicalRecord[] }
const fixtureCriteria = new WeakMap<ReviewGateFixture, CriterionFixture>()
const inputCriteria = new WeakMap<ActionInputs, CriterionFixture>()

export { SPEC }

function standaloneForHead(inputs: ActionInputs, head: string): ActionInputs {
  const manifest = {
    ...inputs.manifest,
    code: { ...inputs.manifest.code, head, referenceCommit: head },
    subject: { kind: 'standalone-pr' as const, pullRequest: SCOPE },
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

export function freshStandaloneReviewInputs(head: string): ActionInputs {
  return standaloneForHead(freshReviewInputs(), head)
}

type PublishedInput = string | ActionInputs | null

export function reviewBodies(
  head: string,
  prefix: string,
  input: PublishedInput = null,
  verdict: 'Approve' | 'Request changes' = 'Approve',
): string[] {
  if (input !== null && typeof input !== 'string') {
    const criterion = inputCriteria.get(input)
    if (criterion !== undefined) {
      return criterionReviewGraph({
        ...criterion,
        inputs: input,
        head,
        scope: SCOPE,
        prefix,
        verdict,
        author: AUTOMATION,
        projection,
      }).comments.map((comment) => comment.body)
    }
  }
  const bound =
    input === null
      ? { digest: null, inputs: standaloneForHead(standaloneReviewInputs(), head) }
      : typeof input === 'string'
        ? { digest: input, inputs: undefined }
        : { digest: input.fingerprint, inputs: input }
  return encodedAdmissionReviewGraph({
    scope: SCOPE,
    head,
    input: bound.digest,
    inputs: bound.inputs,
    prefix,
    verdict,
  }).comments.map((comment) => comment.body)
}

export function cleanReview(head: string, prefix: string, input: PublishedInput = null): string[] {
  return reviewBodies(head, prefix, input)
}

export function approvals(head: string, input: PublishedInput = null): string[] {
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
  const issueRecords = criterionImplementationRecords(mandate, fixture.head)
  fixtureCriteria.set(fixture, { mandate, issueRecords })
  const binding = workflowBinding(SCOPE, mandate, 'feat/7-fixture', 'main')
  const state = readState(fixture)
  const issue: IssueState = {
    body: spec,
    updatedAt: PR_EDITED,
    state: 'OPEN',
    labels: [{ name: 'size:S' }],
    comments: historyFrom(issueRecords, AUTOMATION).source.comments.map((comment, index) =>
      stored(comment.body, 4200 + index),
    ),
  }
  state.prBody = PR_TEXT
  state.prEditedAt = PR_EDITED
  state.issues['42'] = issue
  const mandateHistory = historyFrom(issueRecords, AUTOMATION)
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

export async function boundInput(fixture: ReviewGateFixture): Promise<ActionInputs> {
  const inputs = await assembleActionInputs(
    {
      actionId: 'review-7',
      purpose: 'review',
      subject: {
        kind: 'uw',
        uw: { repository: 'acme/app', target: 'acme/app#42' },
        pullRequest: { repository: 'acme/app', target: 'acme/app#7' },
        binding: null,
      },
      code: { repository: 'acme/app', base: fixture.base, head: fixture.head, referenceCommit: fixture.head },
      stageSources: [],
      expandedContext: [],
    },
    createProductionActionPorts({
      cwd: fixture.candidate,
      gh: gateGh(fixture),
      pluginPin: {
        repository: 'Roxabi/roxabi-plugins',
        commit: fixture.pin,
        installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
      },
    }),
  )
  const criterion = fixtureCriteria.get(fixture)
  if (criterion === undefined) throw new Error('review gate fixture has no criterion history')
  inputCriteria.set(inputs, criterion)
  return inputs
}

export async function standaloneNoProducerInput(fixture: ReviewGateFixture): Promise<ActionInputs> {
  const state = readState(fixture)
  state.comments = state.comments.filter((comment) => recordKind(comment.body) !== 'workflow-binding')
  for (const issue of Object.values(state.issues))
    issue.comments = issue.comments.filter((comment) => recordKind(comment.body) !== 'mandate')
  writeState(fixture, state)
  const semantic = await reviewSemanticContext(fixture)
  if ('ok' in semantic) throw new Error(semantic.error)
  if (semantic.mode !== 'standalone')
    throw new Error('standalone no-producer input requires an absent workflow-binding')
  return assembleActionInputs(
    {
      actionId: 'review-7',
      purpose: 'review',
      subject: { kind: 'standalone-pr', pullRequest: { repository: 'acme/app', target: 'acme/app#7' } },
      code: { repository: 'acme/app', base: fixture.base, head: fixture.head, referenceCommit: fixture.head },
      stageSources: [],
      expandedContext: [],
    },
    createProductionActionPorts({
      cwd: fixture.candidate,
      gh: gateGh(fixture),
      pluginPin: {
        repository: 'Roxabi/roxabi-plugins',
        commit: fixture.pin,
        installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
      },
    }),
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
