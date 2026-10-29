import {
  confirmedReviewSemanticContext as projectReviewSemanticContext,
  reviewSemanticCanon,
} from '../../roxabi/review-semantic-canon.ts'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context.ts'
import { captureReviewInput as captureReviewInputCore } from './review-input.ts'
import { isCommitSha, readPrFields } from './workflow-gate.js'
import { fetchBase } from './workflow-readiness.js'
import { repositoryScope } from './workflow-records.js'
import { gh, gitResult } from './workflow-runtime.js'

export async function confirmedReviewSemanticContext(cwd, pr, ghFn, base, automationLogin) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefName,body')
  if (typeof selected.headRefName !== 'string' || selected.headRefName === '')
    return { ok: false, reason: 'unreadable', error: 'PR head branch is unreadable' }
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
  if (resolved?.ok) return projectReviewSemanticContext(resolved.value)
  const diagnostic = Array.isArray(resolved?.diagnostics) ? resolved.diagnostics[0] : undefined
  const code = typeof diagnostic?.code === 'string' ? diagnostic.code : ''
  return {
    ok: false,
    reason: code.endsWith('unreadable') ? 'unreadable' : 'unbound',
    error: typeof diagnostic?.message === 'string' ? diagnostic.message : 'review semantic context refused',
  }
}

async function captureInput(
  cwd,
  pr,
  head,
  {
    gh: ghFn = gh,
    git: gitFn = gitResult,
    semantic: supplied,
    automationLogin,
    pluginPin,
    persistedFingerprint,
    preparedSnapshot,
  } = {},
  mergedBase,
) {
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefOid,baseRefName')
  if (!isCommitSha(head) || selected.headRefOid !== head)
    return { ok: false, reason: 'unbound', error: 'the review head changed; start a fresh review' }
  const base = await fetchBase(cwd, selected.baseRefName, gitFn, ghFn)
  if (base.refusal) return base.refusal
  const semantic = supplied ?? (await confirmedReviewSemanticContext(cwd, pr, ghFn, base.name, automationLogin))
  if (semantic.ok === false) return semantic
  const snapshot = await captureReviewInputCore(
    cwd,
    { pr: Number(pr), candidate: head, base: mergedBase ?? base.tip },
    { gh: ghFn, semantic, automationLogin, pluginPin, persistedFingerprint, preparedSnapshot },
  )
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    input: snapshot.input,
    body: snapshot.body,
    semantic,
    semanticCanon: reviewSemanticCanon(semantic),
  }
}
export async function captureReviewInput(cwd, pr, head, deps = {}) {
  return captureInput(cwd, pr, head, deps)
}

async function validateInput(cwd, pr, head, input, deps, changed, mergedBase) {
  const { semantic: _stale, preparedSnapshot: _prepared, ...fresh } = deps
  const current = await captureInput(cwd, pr, head, { ...fresh, persistedFingerprint: input }, mergedBase)
  if (!current.ok) return current
  return current.input === input ? { ok: true } : changed
}
/** Initial dispatch checks the sealed host-prepared snapshot before its inventory is published. */
export async function validatePreparedReviewInput(cwd, pr, head, snapshot, deps = {}) {
  const { semantic: _stale, persistedFingerprint: _persisted, preparedSnapshot: _prepared, ...fresh } = deps
  const current = await captureInput(cwd, pr, head, { ...fresh, preparedSnapshot: snapshot })
  if (!current.ok) return current
  if (snapshot?.fingerprint !== current.input)
    return { ok: false, reason: 'review-input-changed', error: 'prepared review input no longer matches current facts' }
  return { ok: true }
}

export async function validateReviewInput(cwd, pr, head, input, deps = {}) {
  return validateInput(cwd, pr, head, input, deps, {
    ok: false,
    reason: 'unbound',
    error:
      'review inputs changed during review; do not post this approval or replace its binding — start a fresh review',
  })
}

export async function validateLandingReviewInput(cwd, pr, head, input, deps = {}, mergedBase) {
  return validateInput(
    cwd,
    pr,
    head,
    input,
    deps,
    {
      ok: false,
      reason: 'review-input-changed',
      error: 'review inputs changed after review; re-review the current head before landing',
    },
    mergedBase,
  )
}

export async function hasFreshReviewInput(cwd, pr, records, deps = {}) {
  return (await validateReviewInput(cwd, pr, records.head, records.input, deps)).ok
}
