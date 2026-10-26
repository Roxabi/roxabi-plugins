import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context.ts'
import { captureReviewInput as captureProofReviewInput } from './proof-capture.ts'
import { proofSemanticContext } from './proof-context.ts'
import { reviewSemanticCanon } from './proof-semantic-canon.ts'
import { isCommitSha, readPrFields } from './workflow-gate.js'
import { fetchBase } from './workflow-readiness.js'
import { repositoryScope } from './workflow-records.js'
import { gh, gitResult } from './workflow-runtime.js'

export async function confirmedReviewSemanticContext(cwd, pr, ghFn, base, automationLogin) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefName,body')
  if (typeof selected.headRefName !== 'string' || selected.headRefName === '')
    return { ok: false, producer: 'candidate', reason: 'unreadable', error: 'PR head branch is unreadable' }
  const resolved = await resolveReviewSemanticContext({
    cwd,
    repository: scope.repository,
    pr: Number(pr),
    body: typeof selected.body === 'string' ? selected.body : '',
    branch: selected.headRefName,
    base,
    automationLogin,
    gh: ghFn,
  })
  if (resolved?.ok) return proofSemanticContext(resolved.value)
  const diagnostic = Array.isArray(resolved?.diagnostics) ? resolved.diagnostics[0] : undefined
  const code = typeof diagnostic?.code === 'string' ? diagnostic.code : ''
  return {
    ok: false,
    producer: 'candidate',
    reason: code.endsWith('unreadable') ? 'unreadable' : 'unbound',
    error: typeof diagnostic?.message === 'string' ? diagnostic.message : 'review semantic context refused',
  }
}

export async function captureReviewInput(
  cwd,
  pr,
  head,
  { gh: ghFn = gh, git: gitFn = gitResult, semantic: supplied, automationLogin } = {},
) {
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefOid,baseRefName')
  if (!isCommitSha(head) || selected.headRefOid !== head)
    return {
      ok: false,
      producer: 'candidate',
      reason: 'unbound',
      error: 'the review head changed; start a fresh review',
    }
  const base = await fetchBase(cwd, selected.baseRefName, gitFn, ghFn)
  if (base.refusal) return base.refusal
  const semantic = supplied ?? (await confirmedReviewSemanticContext(cwd, pr, ghFn, base.name, automationLogin))
  if (semantic.ok === false) return semantic
  const snapshot = await captureProofReviewInput(
    cwd,
    { pr: Number(pr), candidate: head, base: base.name, baseTip: base.tip },
    { gh: ghFn, git: gitFn, semantic },
  )
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    input: snapshot.input,
    body: snapshot.body,
    semctx: snapshot.semctx,
    assertledger: snapshot.assertledger,
    semantic,
    semanticCanon: reviewSemanticCanon(semantic),
  }
}

export async function validateReviewInput(cwd, pr, head, input, deps = {}) {
  const { semantic: _stale, ...fresh } = deps
  const current = await captureReviewInput(cwd, pr, head, fresh)
  if (!current.ok) return current
  if (current.input !== input)
    return {
      ok: false,
      producer: 'candidate',
      reason: 'unbound',
      error:
        'review inputs changed during review; do not post this approval or replace its binding — start a fresh review',
    }
  return { ok: true }
}

export async function hasFreshReviewInput(cwd, pr, records, deps = {}) {
  return (await validateReviewInput(cwd, pr, records.head, records.input, deps)).ok
}
