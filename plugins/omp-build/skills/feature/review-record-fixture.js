import { decodeHistory, buildRecord as frameRecord } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { createReviewDeliveryNative } from './review-record-delivery-gh.js'
import { CHECKOUT_HEADS, createGateGit, WORKTREE } from './review-record-git-fixture.js'
import { createGateGh } from './review-record-github-fixture.js'
import { nativeFeatureSpec } from './review-record-native-fixture.js'

export const REPOSITORY = 'acme/app'
export const ISSUE = 42
export const PR = 7
export const SCOPE = { repository: REPOSITORY, target: `${REPOSITORY}#${PR}` }
export const AUTHOR = 'omp-bot'
export const HEADS = CHECKOUT_HEADS
export { WORKTREE }

export const SPEC = nativeFeatureSpec('Save keeps the selected region')

/** The embedded manifest predates the historical review comments; never capture live inputs here. */
function historicalReviewInputs(head) {
  const inputs = standaloneReviewInputs(SCOPE, head)
  const manifest = { ...inputs.manifest, code: { ...inputs.manifest.code, referenceCommit: head } }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

function reviewSet(index, { head, verdict }) {
  const graph = reviewGraph({
    prefix: `review-${index}`,
    head,
    scope: SCOPE,
    inputs: historicalReviewInputs(head),
    empty: false,
    label: verdict === 'Request changes' ? 'issue(blocking)' : 'praise',
  })
  return graph.records.map((record) => {
    const payload =
      record.kind === 'review-attempt' || record.kind === 'review' ? { ...record.payload, input: null } : record.payload
    const built = frameRecord({ ...record, ...SCOPE, payload })
    if (!built.ok) throw new Error(built.diagnostics.map((diagnostic) => `${diagnostic.message}`).join('; '))
    return built.value
  })
}

function framed(record) {
  const parsed = frameRecord(record)
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  const data = Buffer.from(JSON.stringify(parsed.value)).toString('base64url')
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${record.recordId} operationId=${record.operationId} part=1/1 data=${data} -->\n`
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
  {
    head = HEADS[0],
    armed = true,
    issueHistory = null,
    authorizationVariables,
    authorizationVariablesForbidden = false,
  } = {},
) {
  const calls = []
  const state = { head, label: armed, auto: armed }
  const fixture = {
    repository: REPOSITORY,
    issue: ISSUE,
    pr: PR,
    author: AUTHOR,
    spec: SPEC,
    initialAuthorization: armed,
    authorizationVariables,
    authorizationVariablesForbidden,
  }
  return {
    gh: createGateGh({
      history,
      issueHistory,
      state,
      calls,
      fixture,
      historyPage,
      native: createReviewDeliveryNative(fixture),
    }),
    git: createGateGit({ state, heads: HEADS }),
    state,
    calls,
  }
}
