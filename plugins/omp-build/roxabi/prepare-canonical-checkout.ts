import type { Gh } from '../adapters/github/types.ts'
import { readSelectionIssueView } from '../adapters/github-native/issue-views.ts'
import { readUwGraph } from '../adapters/github-native/uw-graph-reader.ts'
import { resolveNativeTarget } from '../adapters/github-workflow/native-facts.ts'
import type { Scope } from '../engine/record-values.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { checkoutTarget } from './feature-checkout-target.ts'
import { defaultGh } from './feature-engine.ts'
import { resolveBase } from './feature-mandate.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { issueReference } from './feature-selection.ts'
import { createInstalledUwReadPort, UwGraphUnavailableError } from './uw-read-port.ts'
import {
  type CheckoutPreparation,
  defaultGit,
  type FeatureCheckoutTarget,
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
  target: FeatureCheckoutTarget
  base: string
  repository: string
}): Promise<CheckoutPreparation> {
  let prepared: CheckoutPreparation = { status: 'blocked', reason: 'worktree-add-failed' }
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    prepared = await prepareFeatureCheckout({
      git: input.git,
      sessionCwd: input.sessionCwd,
      target: input.target,
      base: input.base,
      repository: input.repository,
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
      target: { kind: 'branch', branch: target.pullRequest.branch, attachExisting: true },
      base: target.pullRequest.base,
      repository: repository.repository,
    })
  }
  if (target.status !== 'issue') return { status: 'blocked', reason: 'issue-unreadable' }
  const checkout = await resolveIssueCheckout({
    gh,
    cwd: identity.principalTop,
    repository: repository.repository,
    number: classified.number,
    scope: target.scope,
  })
  if ('status' in checkout) return checkout
  const base = await resolveBase(git, identity.principalTop)
  if ('reason' in base) return { status: 'blocked', reason: base.reason }
  return prepareBranch({
    git,
    sessionCwd: input.sessionCwd,
    target: checkout,
    base: base.base,
    repository: repository.repository,
  })
}

async function resolveIssueCheckout(input: {
  gh: Gh
  cwd: string
  repository: string
  number: number
  scope: Scope
}): Promise<FeatureCheckoutTarget | CheckoutPreparation> {
  const { gh, cwd, repository, number, scope } = input
  const issue = await readIssue(gh, cwd, repository, number)
  if ('reason' in issue) return { status: 'blocked', reason: issue.reason }
  const graph = await readUwGraph(scope, { cwd, gh })
  const projected = checkoutTarget({
    uw: scope,
    graph,
    accepted: { status: 'absent' },
    branch: branchFor({ number, title: issue.title, labels: issue.labels }),
  })
  if ('kind' in projected) return { status: 'blocked', reason: projected.reason }
  const root = graph.nodes.find((node) => node.uw.repository === scope.repository && node.uw.target === scope.target)
  if (root === undefined) return { status: 'blocked', reason: 'graph-root-missing' }
  if (root.parent !== null) return resolveParentCheckout(scope, cwd, gh)
  return projected.target
}

async function resolveParentCheckout(
  scope: Scope,
  cwd: string,
  gh: Gh,
): Promise<FeatureCheckoutTarget | CheckoutPreparation> {
  try {
    const reader = createInstalledUwReadPort({ cwd, gh })
    const read = await reader.readUw(scope)
    const anchor = await resolveParentWorktreeAnchor({ subject: scope, read })
    if (!anchor.ok) return { status: 'blocked', reason: anchor.reason }
    return { kind: 'parent', uw: anchor.anchor }
  } catch (error) {
    if (error instanceof UwGraphUnavailableError) return { status: 'blocked', reason: 'uw-graph-unavailable' }
    throw error
  }
}
