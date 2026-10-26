import { decodeHistory, buildRecord as frameRecord } from '../../dist/contracts.js'
import { specDigest } from '../../engine/record-digests.ts'
import { confirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { hashReviewInput } from './review-input.ts'
import { createGateGit } from './review-record-git-fixture.js'
import { createGateGh } from './review-record-github-fixture.js'

export const REPOSITORY = 'acme/app'
export const ISSUE = 42
export const ISSUE_SCOPE = { repository: REPOSITORY, target: `${REPOSITORY}#${ISSUE}` }
export const SPEC = '## Acceptance\n- [ ] Save keeps the selected region'
export const PR = 7
export const SCOPE = { repository: REPOSITORY, target: `${REPOSITORY}#${PR}` }
export const AUTHOR = 'omp-bot'
export const HEADS = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)]
const { featureMandate, historyFrom, workflowBinding } = roxabiWorkflowFixtures()

function reviewSet(index, { head, verdict, input = null }) {
  const graph = reviewGraph({
    prefix: `review-${index}`,
    head,
    empty: false,
    label: verdict === 'Request changes' ? 'issue(blocking)' : 'praise',
  })
  return graph.records.map((record) => {
    const payload =
      record.kind === 'review-attempt' || record.kind === 'review' ? { ...record.payload, input } : record.payload
    const built = frameRecord({ ...record, ...SCOPE, payload })
    if (!built.ok) throw new Error(built.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return built.value
  })
}

function framed(record) {
  const parsed = frameRecord(record)
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  const data = Buffer.from(JSON.stringify(parsed.value)).toString('base64url')
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${record.recordId} operationId=${record.operationId} part=1/1 data=${data} -->\n`
}

/** No-producer canon: empty PR body, no tracker, null producer parts. */
export function noProducerInput(head, pr = PR) {
  const semantic = confirmedReviewSemanticContext({
    mode: 'standalone',
    binding: null,
    acceptedSpec: null,
    currentSpec: null,
    effectiveConfig: null,
    additionalRequirements: [],
  })
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput(REPOSITORY, { pr, candidate: head }, { body: '', lastEditedAt: null }, semantic)
}

function mandateRecord(head) {
  return featureMandate(ISSUE_SCOPE, {
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    branch: 'feat/save',
    base: 'main',
    lineageHead: head,
  })
}

function linkedInput(head, mandate, binding) {
  const config = mandate.payload.config
  const digest = specDigest(SPEC)
  const semantic = confirmedReviewSemanticContext({
    mode: 'bound',
    binding: { recordId: binding.recordId, scope: ISSUE_SCOPE },
    acceptedSpec: {
      reference: ISSUE_SCOPE.target,
      body: SPEC,
      digest,
      chain: [{ kind: 'mandate', recordId: mandate.recordId, scope: ISSUE_SCOPE, specDigest: digest }],
      sourceRefs: [{ scope: ISSUE_SCOPE, recordId: mandate.recordId, kind: 'mandate' }],
    },
    additionalRequirements: [],
    effectiveConfig: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      serialized: JSON.stringify({
        productVersion: config.productVersion,
        version: config.version,
        digest: config.digest,
        additionalRequirements: [],
      }),
    },
  })
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput(REPOSITORY, { pr: PR, candidate: head }, { body: '', lastEditedAt: null }, semantic)
}

/** Approving review bound to issue 42, shipped config, and the empty-PR canon. */
export function linkedApproval(head = HEADS[0]) {
  const mandate = mandateRecord(head)
  const issue = historyFrom([mandate], AUTHOR)
  const binding = workflowBinding(SCOPE, mandate, 'feat/save', 'main')
  const framedBinding = historyFrom([binding], AUTHOR, AUTHOR, [issue])
  const input = linkedInput(head, mandate, binding)
  const reviews = reviewSet(1, { head, verdict: 'Approve (clean)', input })
  const comments = [
    ...framedBinding.source.comments,
    ...reviews.map((record, index) => ({
      locator: `${SCOPE.target}:comment:${index + 2}`,
      nativeId: String(index + 2),
      body: framed(record),
      author: AUTHOR,
      createdAt: `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}Z`,
      updatedAt: `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}Z`,
    })),
  ].map((comment, index) => ({
    ...comment,
    locator: `${SCOPE.target}:comment:${index + 1}`,
    nativeId: String(index + 1),
  }))
  return {
    pr: decodeHistory({
      scope: SCOPE,
      expectedAuthor: AUTHOR,
      complete: true,
      diagnostics: [],
      comments,
    }),
    issue,
    input,
  }
}

export function reviewHistory(specs) {
  const records = specs.flatMap((spec, index) => reviewSet(index + 1, spec))
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: AUTHOR,
    complete: true,
    diagnostics: [],
    comments: records.map((record, index) => ({
      locator: `${SCOPE.target}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: framed(record),
      author: AUTHOR,
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    })),
  })
}

export function historyPage(history) {
  return JSON.stringify(
    history.source.comments.map((comment) => ({
      id: Number(comment.nativeId),
      user: { login: comment.author },
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
  )
}

/** Stateful common-adapter/GitHub boundary for workflow gate tests. */
export function gateGh(
  history,
  { head = HEADS[0], armed = true, moveHeadAfterInputRead = null, issueHistory = null } = {},
) {
  const calls = []
  const state = { head, label: armed, auto: armed }
  const fixture = {
    repository: REPOSITORY,
    issue: ISSUE,
    pr: PR,
    author: AUTHOR,
    spec: SPEC,
    heads: HEADS,
  }
  return {
    gh: createGateGh({ history, issueHistory, state, calls, fixture, historyPage }),
    git: createGateGit({ state, moveHeadAfterInputRead, heads: HEADS }),
    state,
    calls,
  }
}
