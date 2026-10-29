import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { decodeHistory, buildRecord as frameRecord } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../../engine/uw-spec-schema.ts'
import { confirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon.ts'
import { createProductionActionPorts } from '../../roxabi/uw-input-readers.ts'
import { freshReviewInputs, standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { criterionImplementationRecords, criterionReviewGraph } from '../../testing/criterion-approval.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { assembleActionInputs } from '../../testing/review-input-assembly.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { CHECKOUT_HEADS, createGateGit, WORKTREE } from './review-record-git-fixture.js'
import { createGateGh } from './review-record-github-fixture.js'
import { INSTALLED_PLUGIN, TOOLING_COMMIT } from './review-record-pin.js'
import { confirmedReviewSemanticContext as observedReviewSemanticContext } from './workflow-review-input.js'
export const REPOSITORY = 'acme/app'
export const ISSUE = 42
export const ISSUE_SCOPE = { repository: REPOSITORY, target: `${REPOSITORY}#${ISSUE}` }
export const PR = 7
export const SCOPE = { repository: REPOSITORY, target: `${REPOSITORY}#${PR}` }
export const AUTHOR = 'omp-bot'
export const HEADS = CHECKOUT_HEADS
export { WORKTREE }

const { featureMandate, historyFrom, ownSpecFromSnapshot, workflowBinding } = roxabiWorkflowFixtures()

function nativeFeatureSpec(criterion) {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  const body = renderIssueSpecBody(canonical.value)
  const parsed = parseIssueSpecBody({
    uw: ISSUE_SCOPE,
    raw: rawSource(ISSUE_SCOPE.target, body, '2026-10-21T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('review record fixture Spec is not conformant')
  return { body, ownSpec: ownSpecFromSnapshot(ISSUE_SCOPE, parsed.snapshot) }
}

const NATIVE_SPEC = nativeFeatureSpec('Save keeps the selected region')
export const SPEC = NATIVE_SPEC.body

function reviewInputsForPullRequest(inputs, head = HEADS[0]) {
  const manifest = {
    ...inputs.manifest,
    code: { ...inputs.manifest.code, head, referenceCommit: head },
    subject: { kind: 'standalone-pr', pullRequest: SCOPE },
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

const STANDALONE_INPUTS = reviewInputsForPullRequest(standaloneReviewInputs())
const DISTINCT_INPUTS = reviewInputsForPullRequest(freshReviewInputs())

function boundInputs(input, inputs) {
  if (inputs) return inputs
  if (input === null) return null
  if (input === STANDALONE_INPUTS.fingerprint) return STANDALONE_INPUTS
  if (input === DISTINCT_INPUTS.fingerprint) return DISTINCT_INPUTS
  throw new Error('review fixture input is not a bound action-input fingerprint')
}

function reviewPayload(record, input, inputs) {
  if (record.kind !== 'review-attempt' && record.kind !== 'review') return record.payload
  const payload = { ...record.payload, input: inputs ? inputs.fingerprint : input }
  if (record.kind === 'review-attempt' && 'inputSnapshot' in record.payload) {
    const snapshot = inputs ?? reviewInputsForPullRequest(STANDALONE_INPUTS, record.payload.candidateGitSHA)
    payload.inputSnapshot = snapshot
    payload.actionInputDigest = snapshot.fingerprint
  }
  return payload
}

function reviewSet(index, { head, verdict, input = null, inputs = null }) {
  const bound = boundInputs(input, inputs)
  const graph = reviewGraph({
    prefix: `review-${index}`,
    head,
    empty: false,
    label: verdict === 'Request changes' ? 'issue(blocking)' : 'praise',
  })
  return graph.records.map((record) => {
    const built = frameRecord({ ...record, ...SCOPE, payload: reviewPayload(record, input, bound) })
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

export function noProducerInput(_head, _pr = PR) {
  const semantic = confirmedReviewSemanticContext({
    mode: 'standalone',
    binding: null,
    acceptedSpec: null,
    currentSpec: null,
    effectiveConfig: null,
    additionalRequirements: [],
  })
  if ('ok' in semantic) throw new Error(semantic.error)
  return STANDALONE_INPUTS.fingerprint
}

export function distinctReviewInput() {
  return DISTINCT_INPUTS.fingerprint
}

function mandateRecord(head) {
  return featureMandate(ISSUE_SCOPE, {
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    branch: 'feat/save',
    base: 'main',
    lineageHead: head,
    ownSpec: NATIVE_SPEC.ownSpec,
  })
}

async function linkedInput(head, issue, bindingHistory) {
  const { gh } = gateGh(bindingHistory, { head, armed: true, issueHistory: issue })
  const semantic = await observedReviewSemanticContext(WORKTREE, PR, gh, 'main', AUTHOR)
  if (semantic.ok === false) throw new Error(semantic.error)
  return assembleActionInputs(
    {
      actionId: `review-${PR}`,
      purpose: 'review',
      subject: { kind: 'uw', uw: ISSUE_SCOPE, pullRequest: SCOPE, binding: null },
      code: { repository: REPOSITORY, base: HEADS[0], head, referenceCommit: head },
      stageSources: [],
      expandedContext: [],
    },
    createProductionActionPorts({
      cwd: WORKTREE,
      gh,
      pluginPin: { repository: 'Roxabi/roxabi-plugins', commit: TOOLING_COMMIT, installedRoot: INSTALLED_PLUGIN },
    }),
  )
}

/** Approving review bound to issue 42, shipped config, and the empty-PR canon. */
export async function linkedApproval(head = HEADS[0]) {
  const mandate = mandateRecord(head)
  const issueRecords = criterionImplementationRecords(mandate, head)
  const issue = historyFrom(issueRecords, AUTHOR)
  const binding = workflowBinding(SCOPE, mandate, 'feat/save', 'main')
  const framedBinding = historyFrom([binding], AUTHOR, AUTHOR, [issue])
  const inputs = await linkedInput(head, issue, framedBinding)
  const reviews = criterionReviewGraph({
    mandate,
    inputs,
    head,
    issueRecords,
    scope: SCOPE,
    projection: roxabiRecordFixtures().projection,
    prefix: 'review-1',
    author: AUTHOR,
  })
  const comments = [...framedBinding.source.comments, ...reviews.comments].map((comment, index) => ({
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
    input: inputs.fingerprint,
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
