import { decodeHistory, buildRecord as frameRecord } from '../../dist/contracts.js'
import { specDigest } from '../../engine/record-digests.ts'
import { PROOF_PIN_PATHS } from '../../roxabi/workflow-config.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { hashReviewInput, proofSemanticContext } from './proof.ts'

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
  const semantic = proofSemanticContext({
    mode: 'standalone',
    binding: null,
    acceptedSpec: null,
    currentSpec: null,
    effectiveConfig: null,
    additionalRequirements: [],
  })
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput(REPOSITORY, { pr, candidate: head }, { body: '', lastEditedAt: null }, null, null, semantic)
}

function mandateRecord(head) {
  return featureMandate(ISSUE_SCOPE, {
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    branch: 'feat/save',
    base: 'main',
    lineageHead: head,
    proofPins: PROOF_PIN_PATHS.map((path) => ({ sourceCommit: HEADS[0], path, blob: null })),
  })
}

function linkedInput(head, mandate, binding) {
  const config = mandate.payload.config
  const digest = specDigest(SPEC)
  const semantic = proofSemanticContext({
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
  return hashReviewInput(
    REPOSITORY,
    { pr: PR, candidate: head },
    { body: '', lastEditedAt: null },
    null,
    null,
    semantic,
  )
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
      updatedAt: null,
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
      updatedAt: null,
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
  { head = HEADS[0], armed = true, moveHeadAfterProofRead = null, issueHistory = null } = {},
) {
  const calls = []
  const state = { head, label: armed, auto: armed }
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: REPOSITORY })
    if (args[0] === 'api' && args[1] === 'user') return `${AUTHOR}\n`
    if (args[0] === 'api' && args.includes('graphql') && args.some((arg) => arg.includes('lastEditedAt'))) {
      return JSON.stringify({ data: { repository: { pullRequest: { body: '', lastEditedAt: null } } } })
    }
    if (args[0] === 'api' && args[1] === `repos/${REPOSITORY}/issues/${ISSUE}`) {
      return JSON.stringify({ number: ISSUE, state: 'open', body: SPEC, user: { login: AUTHOR } })
    }
    // Shared GH number namespace: the pull is also readable via issues/{pr}.
    if (args[0] === 'api' && args[1] === `repos/${REPOSITORY}/issues/${PR}`) {
      return JSON.stringify({ number: PR, state: 'open', body: '', user: { login: AUTHOR } })
    }
    const commentsPath = String(args[1] ?? '')
    const commentPage = commentsPath.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?/)
    if (args[0] === 'api' && commentPage) {
      const page = commentsPath.match(/[?&]page=(\d+)/)?.[1] ?? '1'
      if (page !== '1') return '[]'
      if (Number(commentPage[1]) === ISSUE) {
        if (!issueHistory) throw new Error(`unexpected mandate history read for #${ISSUE}`)
        return historyPage(issueHistory)
      }
      if (Number(commentPage[1]) === PR) return historyPage(history)
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({
        body: SPEC,
        updatedAt: '2026-10-21T12:00:00Z',
        state: 'OPEN',
        labels: [],
      })
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const fields = String(args.at(-1)).split(',')
      return JSON.stringify({
        ...(fields.includes('number') && { number: PR }),
        ...(fields.includes('headRefOid') && { headRefOid: state.head }),
        ...(fields.includes('headRefName') && { headRefName: 'feat/save' }),
        ...(fields.includes('state') && { state: 'OPEN' }),
        ...(fields.includes('labels') && { labels: state.label ? [{ name: 'reviewed' }] : [] }),
        ...(fields.includes('autoMergeRequest') && { autoMergeRequest: state.auto ? { enabledAt: 'now' } : null }),
        ...(fields.includes('mergeStateStatus') && { mergeStateStatus: 'CLEAN' }),
        ...(fields.includes('baseRefName') && { baseRefName: 'main' }),
        ...(fields.includes('baseRefOid') && { baseRefOid: HEADS[0] }),
        ...(fields.includes('author') && { author: { login: AUTHOR } }),
        ...(fields.includes('body') && { body: '' }),
        ...(fields.includes('updatedAt') && { updatedAt: null }),
      })
    }
    if (args[0] === 'api' && (args.includes('POST') || (args.includes('--method') && args.includes('POST')))) {
      const body = String(args.find((arg) => arg.startsWith('body=')) ?? '').slice('body='.length)
      const nativeId = String(history.source.comments.length + 1)
      history.source.comments.push({
        locator: `published-${nativeId}`,
        nativeId,
        author: AUTHOR,
        createdAt: '2026-01-01T00:03:00Z',
        updatedAt: null,
        body,
      })
      return JSON.stringify({ id: Number(nativeId), body, user: { login: AUTHOR } })
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
      state.auto = false
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')) {
      state.label = false
      return ''
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  let proofTreeReads = 0
  const git = async (_cwd, args) => {
    if (args[0] === 'remote' && args[1] === 'get-url')
      return { code: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: '/tmp/wt\n', stderr: '' }
    if (args[0] === 'show' && String(args[1]).endsWith(':.dev/stack.yml'))
      return { code: 128, stdout: '', stderr: 'fatal: path .dev/stack.yml does not exist' }
    if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}'))
      return { code: 0, stdout: `${state.head}\n`, stderr: '' }
    if (args[0] === 'rev-parse' && args.some((arg) => String(arg).includes(':')))
      return { code: 1, stdout: '', stderr: 'absent' }
    if (args[0] === 'ls-tree') {
      // Candidate/base declaration trees (`-r`) are the planned proof read.
      // Pin lookups are single-path and must not trip the head-move hook.
      if (args.includes('-r')) {
        proofTreeReads++
        if (proofTreeReads === 2 && moveHeadAfterProofRead !== null) state.head = moveHeadAfterProofRead
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEADS[0]}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { gh, git, state, calls }
}
