import { type Result, viewer } from '../dist/contracts.js'
import { resolveReviewPr } from '../skills/feature/workflow-pr.js'
import { captureReviewInput } from '../skills/feature/workflow-review-input.js'
import type { Gh, Git, ReviewInputCapture } from './review-input-contract'
import { confirmedReviewSemanticContext } from './review-semantic-canon'
import { type ReviewSemanticContext, resolveReviewSemanticContext } from './review-semantic-context'

const SHA = /^[0-9a-f]{40}$/

const failed = <T>(code: string, message: string): Result<T> => ({
  ok: false,
  diagnostics: [{ code, message }],
})

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type PreparedReviewTarget = {
  number: number
  repository: string
  automationLogin: string
  candidate: string
  pr: { base: string; branch: string; body: string }
  semanticContext: ReviewSemanticContext
  capture: ReviewInputCapture
}

/** One read-only target/candidate/binding/capture transaction; no roster or prompt judgment. */
export async function prepareReviewTarget(
  cwd: string,
  requested: number | string | undefined,
  gh: Gh,
  git: Git,
): Promise<Result<PreparedReviewTarget>> {
  const number = await resolveReviewPr(cwd, requested, {
    gh,
    git: async (directory, args) => (await git(directory, [...args])).stdout,
  })
  if (number === null) return failed('review-target-absent', 'no pull request is bound to this review')

  const pr: unknown = JSON.parse(
    await gh(cwd, ['pr', 'view', String(number), '--json', 'headRefOid,baseRefName,headRefName,body,state']),
  )
  if (
    !object(pr) ||
    typeof pr.headRefOid !== 'string' ||
    typeof pr.baseRefName !== 'string' ||
    typeof pr.headRefName !== 'string' ||
    typeof pr.body !== 'string' ||
    pr.state !== 'OPEN'
  ) {
    return failed('review-target-unreadable', 'PR facts are incomplete or closed')
  }
  if (!SHA.test(pr.headRefOid) || !pr.baseRefName || !pr.headRefName) {
    return failed('review-target-unreadable', 'PR did not provide complete head/base/branch facts')
  }

  const verified = await git(cwd, ['rev-parse', '--verify', `${pr.headRefOid}^{commit}`])
  if (verified.code !== 0 || verified.stdout.trim() !== pr.headRefOid) {
    return failed('candidate-unbound', 'local candidate does not match the PR head')
  }
  const repo: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
  if (!object(repo) || typeof repo.nameWithOwner !== 'string' || !repo.nameWithOwner.includes('/')) {
    return failed('repository-unreadable', 'repository identity is unreadable')
  }

  // Viewer identity is memoized per OMP process; `gh auth switch` requires a new session.
  const automationLogin = await viewer({ cwd, gh })
  if (!automationLogin) return failed('automation-login-unreadable', 'gh api user returned no login')
  const semantic = await resolveReviewSemanticContext({
    cwd,
    repository: repo.nameWithOwner,
    pr: number,
    body: pr.body,
    branch: pr.headRefName,
    base: pr.baseRefName,
    automationLogin,
    gh,
  })
  if (!semantic.ok) {
    return failed(
      'review-semantic-context-refused',
      semantic.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '),
    )
  }
  const confirmed = confirmedReviewSemanticContext(semantic.value)
  if ('ok' in confirmed) return failed('review-semantic-context-refused', `${confirmed.reason}: ${confirmed.error}`)
  const capture = await captureReviewInput(cwd, number, pr.headRefOid, { gh, git, semantic: confirmed })
  if (!capture.ok) return failed('review-input-refused', `${capture.reason}: ${capture.error}`)

  return {
    ok: true,
    value: {
      number,
      repository: repo.nameWithOwner,
      automationLogin,
      candidate: pr.headRefOid,
      pr: { base: pr.baseRefName, branch: pr.headRefName, body: pr.body },
      semanticContext: semantic.value,
      capture,
    },
  }
}
