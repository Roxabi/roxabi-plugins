import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  decodeHistory,
  githubScope,
  readGitHubHistory,
  selectedReviewOperations,
  summarizeReviews,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { gh, preview } from './workflow-runtime.js'

let cachedTaxonomy

export function reviewTaxonomy() {
  if (cachedTaxonomy !== undefined) return cachedTaxonomy
  const source = readFileSync(fileURLToPath(new URL('../dev-review/review-classes.yml', import.meta.url)), 'utf8')
  const taxonomy = [...source.matchAll(/^\s*-\s+class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (taxonomy.length === 0) throw new Error('reviewRecords: canonical review taxonomy is unreadable')
  cachedTaxonomy = taxonomy
  return taxonomy
}

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

export function reviewRecords(history, { taxonomy = reviewTaxonomy(), acceptedEvidencePolicyRef = null } = {}) {
  return summarizeReviews(history, taxonomy, acceptedEvidencePolicyRef)
}

export async function readReviewHistory(cwd, pr, ghFn = gh) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  return decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh: ghFn })))
}

export async function readReviewRecords(cwd, pr, { gh: ghFn = gh, taxonomy, acceptedEvidencePolicyRef = null } = {}) {
  const history = await readReviewHistory(cwd, pr, ghFn)
  return reviewRecords(history, { ...(taxonomy === undefined ? {} : { taxonomy }), acceptedEvidencePolicyRef })
}

export async function requiredReviewAdmission(cwd, pr, options) {
  const { gh: ghFn = gh, taxonomy, acceptedEvidencePolicyRef = null } = options ?? {}
  const history = await readReviewHistory(cwd, pr, ghFn)
  const result = reviewRecords(history, { ...(taxonomy === undefined ? {} : { taxonomy }), acceptedEvidencePolicyRef })
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
