import {
  canonicalValueDigest,
  framingObservationDigest,
  projectNativeUwChildren,
  sameScope,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { checkoutTarget } from './feature-checkout-target.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { discoverFramingCoverageIntent, resolveFramingCoverageIntent } from './feature-framing-coverage.ts'
import { initialCoverageBasis } from './feature-initial-coverage.ts'
import { resolveBase } from './feature-mandate.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { UwOperations, UwRead } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'
import type { WrittenFramingGraph } from './uw-framing-contract.ts'
import {
  type CheckoutPreparation,
  type FeatureCheckoutTarget,
  type GitRunner,
  prepareFeatureCheckout,
  sessionWorktreeIdentity,
  verifyParentCheckout,
} from './workflow-checkout.ts'

export type FramedHandoffPreparation = Readonly<{
  written: WrittenFramingGraph
  root: Scope
  repository: string
  principalTop: string
  target: FeatureCheckoutTarget
  destination: string
  expectedBase: string
  coverage: ParentCoverage | null
  basis: ParentCoverageRequest
  checkout: CheckoutPreparation
}>

type Gh = NonNullable<ContinueFeatureInput['gh']>

async function currentPair(
  root: Scope,
  read: UwRead,
): Promise<{ coverage: ParentCoverage | null; basis: ParentCoverageRequest } | ContinueFeatureResult> {
  const facts = await readCurrentFramingFacts({ uw: root, read })
  if (!facts.ok) return { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
  const basis = initialCoverageBasis(root, facts.value.currentSpec)
  const discovered = discoverFramingCoverageIntent(root, read)
  if ('kind' in discovered) return discovered
  if (discovered.intent === null)
    return basis.children.length === 0
      ? { coverage: null, basis }
      : { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest: basis }
  return resolveFramingCoverageIntent({ uw: root, read, intent: discovered.intent })
}

function checkWritten(written: WrittenFramingGraph, read: UwRead): ContinueFeatureResult | null {
  const membership = read.admission.aggregate
  if (
    written.kind !== 'uw' ||
    !sameScope(written.root, read.uw) ||
    read.accepted.status !== 'absent' ||
    read.observation.status !== 'complete' ||
    membership.status !== 'complete' ||
    canonicalValueDigest(membership.intent) !== canonicalValueDigest(written.intent) ||
    canonicalValueDigest(membership.result) !== canonicalValueDigest(written.result) ||
    framingObservationDigest(read.observation) !== written.observationDigest
  )
    return { kind: 'blocked', reason: 'framing-handoff-changed' }
  return null
}

async function checkRepository(gh: Gh, cwd: string, repository: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    return typeof value === 'object' && value !== null && 'nameWithOwner' in value && value.nameWithOwner === repository
  } catch {
    return false
  }
}

function freezeData<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

/** Prepare the canonical checkout; this does not relocate the session or establish a Mandate. */
export async function prepareFramedFeatureHandoff(input: {
  written: WrittenFramingGraph
  read: UwRead
  cwd: string
  git: GitRunner
  gh: Gh
  uw: UwOperations
  checkLive: () => Promise<boolean>
}): Promise<FramedHandoffPreparation | ContinueFeatureResult> {
  const { written, read, cwd, git, gh, uw } = input
  const problem = checkWritten(written, read)
  if (problem !== null) return problem
  if (!(await checkRepository(gh, cwd, written.root.repository)))
    return { kind: 'blocked', reason: 'repository-mismatch' }
  const identity = await sessionWorktreeIdentity(git, cwd)
  if (!identity.ok) return { kind: 'blocked', reason: identity.reason }
  const base = await resolveBase(git, identity.principalTop)
  if ('reason' in base) return { kind: 'blocked', reason: base.reason }
  const node = read.graph.nodes.find((entry) => sameScope(entry.uw, written.root))
  if (!node) return { kind: 'blocked', reason: 'graph-root-missing' }
  const number = Number(written.root.target.slice(written.root.target.lastIndexOf('#') + 1))
  if (!Number.isSafeInteger(number) || number < 1) return { kind: 'blocked', reason: 'issue-unreadable' }
  const projected = checkoutTarget({
    uw: written.root,
    children: projectNativeUwChildren({ uw: written.root, graph: read.graph, accepted: read.accepted }),
    branch: branchFor({ number, title: node.title, labels: [...node.labels] }),
  })
  if ('kind' in projected) return projected
  const anchor = await resolveParentWorktreeAnchor({ subject: written.root, read })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  const target = projected.target.kind === 'parent' ? { kind: 'parent' as const, uw: anchor.anchor } : projected.target
  const fresh = await uw.readUw(written.root)
  const freshProblem = checkWritten(written, fresh)
  if (freshProblem !== null) return freshProblem
  const pair = await currentPair(written.root, fresh)
  if ('kind' in pair) return pair
  let revoked = false
  const guardedGit: GitRunner = async (directory, args) => {
    let live = false
    try {
      live = await input.checkLive()
    } catch {
      /* A failed lifetime check refuses the effect. */
    }
    if (!live) {
      revoked = true
      return { code: 1, stdout: '', stderr: 'framing-handoff-revoked' }
    }
    return git(directory, args)
  }
  const checkout = await prepareFeatureCheckout({
    git: guardedGit,
    sessionCwd: cwd,
    target,
    base: base.base,
    repository: written.root.repository,
  })
  if (revoked) return { kind: 'blocked', reason: 'framing-handoff-revoked' }
  if (checkout.status === 'blocked') return { kind: 'blocked', reason: checkout.reason }
  const destination = checkout.status === 'ready' ? checkout.cwd : checkout.path
  return freezeData(
    structuredClone({
      written,
      root: written.root,
      repository: written.root.repository,
      principalTop: identity.principalTop,
      target,
      destination,
      expectedBase: base.base,
      coverage: pair.coverage,
      basis: pair.basis,
      checkout,
    }),
  )
}

/** Recheck the fresh destination and return the exact ordinary continuation input. */
export async function verifyFramedFeatureDestination(input: {
  ticket: FramedHandoffPreparation
  read: UwRead
  cwd: string
  git: GitRunner
  gh: Gh
  uw: UwOperations
  pluginPin?: TrustedHostPluginPin
}): Promise<{ continuation: ContinueFeatureInput } | ContinueFeatureResult> {
  const { ticket, read, cwd, git, gh } = input
  const problem = checkWritten(ticket.written, read)
  if (problem !== null) return problem
  if (!(await checkRepository(gh, cwd, ticket.repository))) return { kind: 'blocked', reason: 'repository-mismatch' }
  const checkoutProblem = await verifyDestinationCheckout(ticket, cwd, git)
  if (checkoutProblem !== null) return checkoutProblem
  const fresh = await input.uw.readUw(ticket.root)
  const freshProblem = checkWritten(ticket.written, fresh)
  if (freshProblem !== null) return freshProblem
  const pair = await currentPair(ticket.root, fresh)
  if ('kind' in pair) return pair
  if (canonicalValueDigest(pair) !== canonicalValueDigest({ coverage: ticket.coverage, basis: ticket.basis }))
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  return {
    continuation: {
      cwd,
      reference: ticket.root.target,
      control: 'continue',
      principal: false,
      uw: input.uw,
      read: input.uw,
      gh,
      git,
      parentCoverage: pair.coverage,
      parentCoverageBasis: pair.basis,
      ...(input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin }),
    },
  }
}

async function verifyDestinationCheckout(
  ticket: FramedHandoffPreparation,
  cwd: string,
  git: GitRunner,
): Promise<ContinueFeatureResult | null> {
  const identity = await sessionWorktreeIdentity(git, cwd)
  if (!identity.ok) return { kind: 'blocked', reason: identity.reason }
  if (
    identity.onPrincipal ||
    identity.sessionTop !== ticket.destination ||
    identity.principalTop !== ticket.principalTop
  )
    return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  const base = await resolveBase(git, identity.principalTop)
  if ('reason' in base || base.base !== ticket.expectedBase)
    return { kind: 'blocked', reason: 'first-mandate-base-changed' }
  if (ticket.target.kind === 'parent') {
    const checked = await verifyParentCheckout({ git, cwd, uw: ticket.target.uw })
    return checked.ok ? null : { kind: 'blocked', reason: checked.reason }
  }
  const branch = await git(cwd, ['branch', '--show-current'])
  return branch.code === 0 && branch.stdout.trim() === ticket.target.branch
    ? null
    : { kind: 'blocked', reason: 'session-not-intended-worktree' }
}
