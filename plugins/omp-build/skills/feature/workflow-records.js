import {
  decodeHistory,
  githubScope,
  readGitHubHistory,
  selectedReviewOperations,
  summarizeReviews,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { loadReviewClassCatalogues } from '../../roxabi/review-class-catalogues.ts'
import { readReviewInputHistories } from '../../roxabi/uw-input-readers.ts'
import { gh, preview } from './workflow-runtime.js'

export function reviewRefusal(refusal) {
  const diagnostics = Array.isArray(refusal?.diagnostics) ? refusal.diagnostics : []
  const error = new Error(
    `review records refused: ${diagnostics.map((entry) => entry?.message ?? entry?.code ?? String(entry)).join('; ') || 'unknown record failure'}`,
  )
  Object.assign(error, { reviewRecords: refusal })
  return error
}

export async function repositoryScope(cwd, pr, ghFn = gh) {
  const raw = await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`readReviewRecords: repository for PR ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data?.nameWithOwner !== 'string' || !/^[^/]+\/[^/]+$/.test(data.nameWithOwner))
    throw new Error(`readReviewRecords: repository for PR ${pr} is unreadable`)
  const number = Number(pr)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new TypeError(`readReviewRecords: invalid PR ${JSON.stringify(pr)}`)
  return githubScope(data.nameWithOwner, number)
}

export function reviewRecords(history, { catalogues, acceptedEvidencePolicyRef = null, externalHistories = [] }) {
  return summarizeReviews(history, catalogues, acceptedEvidencePolicyRef, externalHistories)
}

async function observedReviewRecords(cwd, pr, { gh: ghFn = gh, acceptedEvidencePolicyRef = null } = {}) {
  const history = await readReviewHistory(cwd, pr, ghFn)
  const cited = await readReviewInputHistories(history, { cwd, gh: ghFn })
  if (!cited.ok) {
    // A proved primary denial may take precedence, never authorize admission.
    // Keep the external failure on that refusal instead of replacing it.
    const catalogues = await loadReviewClassCatalogues({ histories: [history], cwd, gh: ghFn })
    const primary = reviewRecords(history, { catalogues, acceptedEvidencePolicyRef })
    if (!primary.ok && primary.spent === true) {
      return {
        history,
        result: { ...primary, diagnostics: [...primary.diagnostics, ...cited.diagnostics] },
      }
    }
    const error = reviewRefusal(cited)
    error.citedHistory = true
    throw error
  }
  const catalogues = await loadReviewClassCatalogues({
    histories: [history, ...cited.value],
    cwd,
    gh: ghFn,
  })
  return {
    history,
    result: reviewRecords(history, {
      catalogues,
      acceptedEvidencePolicyRef,
      externalHistories: cited.value,
    }),
  }
}

export async function readReviewHistory(cwd, pr, ghFn = gh) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  return decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh: ghFn })))
}

export async function readReviewRecords(cwd, pr, options) {
  const { result } = await observedReviewRecords(cwd, pr, options)
  return result
}

export async function requiredReviewAdmission(cwd, pr, options) {
  const { history, result } = await observedReviewRecords(cwd, pr, options)
  if (!result.ok) throw reviewRefusal(result)
  return { records: result.value, operations: selectedReviewOperations(history, result.value) }
}
export async function requiredReviewRecords(cwd, pr, options) {
  const result = await readReviewRecords(cwd, pr, options)
  if (!result.ok) throw reviewRefusal(result)
  return result.value
}

export async function readComments(cwd, pr, { gh: ghFn = gh } = {}) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  const history = await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh: ghFn }))
  return {
    me: history.expectedAuthor,
    comments: history.comments.map((comment) => ({
      author: { login: comment.author ?? '' },
      body: comment.body,
      ...(comment.nativeId !== null && /^\d+$/.test(comment.nativeId) && { id: Number(comment.nativeId) }),
      ...(comment.createdAt !== null && { createdAt: comment.createdAt }),
      ...(comment.updatedAt !== null && { updatedAt: comment.updatedAt }),
    })),
  }
}
