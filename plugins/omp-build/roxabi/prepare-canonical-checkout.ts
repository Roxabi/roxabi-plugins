import type { Gh } from '../adapters/github/types.ts'
import { readSelectionIssueView } from '../adapters/github-native/issue-views.ts'
import { resolveNativeTarget } from '../adapters/github-workflow/native-facts.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { defaultGh } from './feature-engine.ts'
import { resolveBase } from './feature-mandate.ts'
import { issueReference } from './feature-selection.ts'
import {
  type CheckoutPreparation,
  defaultGit,
  type GitRunner,
  prepareFeatureCheckout,
  sessionWorktreeIdentity,
} from './workflow-checkout.ts'

const QUALIFIED = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/
const LOCAL = /^(?:#(\d+)|(\d+))$/
const ADD_ATTEMPTS = 3

type Classified = { number: number; repository: string | null } | { reason: 'issue-reference-ambiguous' }
type IssueFacts = { title: string; labels: string[] } | { reason: 'issue-unreadable' }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function classifyIssueReference(reference: string): Classified {
  const trimmed = reference.trim()
  if (!issueReference(trimmed)) return { reason: 'issue-reference-ambiguous' }
  const qualified = QUALIFIED.exec(trimmed)
  if (qualified?.[1] && qualified[2]) return { number: Number(qualified[2]), repository: qualified[1] }
  const local = LOCAL.exec(trimmed)
  const number = Number(local?.[1] ?? local?.[2])
  return Number.isInteger(number) && number > 0 ? { number, repository: null } : { reason: 'issue-reference-ambiguous' }
}

async function readRepository(
  gh: Gh,
  cwd: string,
): Promise<{ repository: string } | { reason: 'repository-unreadable' }> {
  try {
    const parsed = record(JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
    const repository = parsed?.nameWithOwner
    return typeof repository === 'string' && repository.includes('/')
      ? { repository }
      : { reason: 'repository-unreadable' }
  } catch {
    return { reason: 'repository-unreadable' }
  }
}

async function readIssue(gh: Gh, cwd: string, repository: string, number: number): Promise<IssueFacts> {
  try {
    const issue = await readSelectionIssueView(repository, number, { cwd, gh })
    return issue === null ? { reason: 'issue-unreadable' } : { title: issue.title, labels: issue.labels }
  } catch {
    return { reason: 'issue-unreadable' }
  }
}

async function prepareBranch(input: {
  git: GitRunner
  sessionCwd: string
  branch: string
  base: string
  repository: string
  attachExisting?: boolean
}): Promise<CheckoutPreparation> {
  let prepared: CheckoutPreparation = { status: 'blocked', reason: 'worktree-add-failed' }
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    prepared = await prepareFeatureCheckout({
      git: input.git,
      sessionCwd: input.sessionCwd,
      branch: input.branch,
      base: input.base,
      repository: input.repository,
      detached: false,
      attachExisting: input.attachExisting === true,
    })
    if (prepared.status !== 'blocked' || prepared.reason !== 'worktree-add-failed') return prepared
    if (attempt < ADD_ATTEMPTS - 1) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 50)
      await promise
    }
  }
  return prepared
}

/**
 * Resolve one unambiguous issue to its canonical checkout. A pull request uses
 * its existing head, never a title-derived issue branch. Does not publish,
 * bootstrap, resume, or move.
 */
export async function prepareCanonicalCheckout(input: {
  reference: string
  sessionCwd: string
  git?: GitRunner
  gh?: Gh
}): Promise<CheckoutPreparation> {
  const classified = classifyIssueReference(input.reference)
  if ('reason' in classified) return { status: 'blocked', reason: classified.reason }
  const git = input.git ?? defaultGit()
  const gh = input.gh ?? defaultGh()
  const identity = await sessionWorktreeIdentity(git, input.sessionCwd)
  if (!identity.ok) return { status: 'blocked', reason: identity.reason }
  const repository = await readRepository(gh, identity.principalTop)
  if ('reason' in repository) return { status: 'blocked', reason: repository.reason }
  if (classified.repository !== null && classified.repository !== repository.repository) {
    return { status: 'blocked', reason: 'repository-mismatch' }
  }
  const target = await resolveNativeTarget(classified.number, { cwd: identity.principalTop, gh }, repository.repository)
  if (target.status === 'pull-request') {
    return prepareBranch({
      git,
      sessionCwd: input.sessionCwd,
      branch: target.pullRequest.branch,
      base: target.pullRequest.base,
      repository: repository.repository,
      attachExisting: true,
    })
  }
  if (target.status !== 'issue') return { status: 'blocked', reason: 'issue-unreadable' }
  const issue = await readIssue(gh, identity.principalTop, repository.repository, classified.number)
  if ('reason' in issue) return { status: 'blocked', reason: issue.reason }
  const base = await resolveBase(git, identity.principalTop)
  if ('reason' in base) return { status: 'blocked', reason: base.reason }
  return prepareBranch({
    git,
    sessionCwd: input.sessionCwd,
    branch: branchFor({ number: classified.number, title: issue.title, labels: issue.labels }),
    base: base.base,
    repository: repository.repository,
  })
}
