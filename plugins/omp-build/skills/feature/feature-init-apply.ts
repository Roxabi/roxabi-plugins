import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InitDeps, InitPlan } from '../../dist/issue-triage/skills/issue-triage/lib/init.ts'
import { ownerRepoFromRemote, plan, readFacts, realGitRemoteUrl } from './feature-init-facts'
import { isPrincipal, proposeStack } from './feature-init-stack'
import { loadTriageInit, type TriageInit } from './feature-init-triage'
import type { Facts, ParseYaml, StackProposal } from './feature-init-types'

type FeatureArgs = { dryRun: boolean; approve?: string; operatorApproval?: string; dir?: string }

const FEATURE_OPTIONS: Record<string, keyof Omit<FeatureArgs, 'dryRun'>> = {
  '--approve': 'approve',
  '--operator-approval': 'operatorApproval',
  '--dir': 'dir',
}

function featureArgs(args: string[]): FeatureArgs {
  const out: FeatureArgs = { dryRun: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dry-run') {
      out.dryRun = true
      continue
    }
    const option = FEATURE_OPTIONS[arg]
    if (!option) throw new Error(`init: unknown argument ${arg}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`init: ${arg} needs a value`)
    out[option] = value
    index++
  }
  return out
}

type TrackerProposal = { plan: InitPlan; contractText: string; canonical: string; deps: InitDeps }
export type FeatureProposal = {
  checkout: string
  repository: string | null
  facts: Facts
  stack: StackProposal
  tracker: TrackerProposal | null
  withheld: string | null
  refusal: string | null
  digest: string
}

function hostPinned(repo: string): string {
  return repo.startsWith('github.com/') || repo.includes('://') ? repo : `github.com/${repo}`
}

function pinTrackerDeps(deps: InitDeps): InitDeps {
  return {
    ...deps,
    listLabelNames: (repo) => deps.listLabelNames(hostPinned(repo)),
    listIssueLabelSets: (repo) => deps.listIssueLabelSets(hostPinned(repo)),
    ensureLabel: (name, repo, color) => deps.ensureLabel(name, hostPinned(repo), color),
    updateLabels: (number, add, remove, repo) => deps.updateLabels(number, add, remove, hostPinned(repo)),
  }
}

async function trackerProposal(
  dir: string,
  facts: Facts,
  triage: TriageInit,
  repository: string | null = ownerRepoFromRemote(realGitRemoteUrl(dir)('origin')),
): Promise<TrackerProposal | null> {
  if (!repository || facts.labelsState !== 'ok') return null
  const deps = pinTrackerDeps(triage.defaultInitDeps(repository, dir))
  const built = await triage.buildPlan(repository, repository, deps)
  return { ...built, deps, canonical: triage.canonicalPlan(built.plan, built.contractText) }
}

function digestFor(
  checkout: string,
  repository: string | null,
  stack: StackProposal,
  tracker: TrackerProposal | null,
  withheld: string | null,
  refusal: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        checkout,
        repository,
        // Bind the bytes that apply would write, not only the addition keys.
        // Otherwise a preserved stack body can change between preview and apply
        // while additions stay identical and the digest still matches.
        before: stack.before,
        after: stack.after,
        additions: [...stack.additions].sort((left, right) => left.key.localeCompare(right.key)),
        tracker: tracker?.canonical ?? null,
        withheld,
        refusal,
      }),
    )
    .digest('hex')
}

export type FeatureInitDeps = {
  facts?: Facts
  parseYaml?: ParseYaml
  triage?: TriageInit
  repository?: string | null
  principal?: boolean
}

export async function previewFeatureInit(dir: string, deps: FeatureInitDeps = {}): Promise<FeatureProposal> {
  const checkout = realpathSync(dir)
  const facts = deps.facts ?? (await readFacts(checkout))
  const stack = proposeStack(checkout, facts, deps.parseYaml)
  const repository = deps.repository ?? ownerRepoFromRemote(realGitRemoteUrl(checkout)('origin'))
  let tracker: TrackerProposal | null = null
  let withheld: string | null = null
  let refusal = stack.refusal
  if (refusal) {
    // An unreadable stack is a hard stop; do not discover a tracker against it.
  } else if (facts.labelsState !== 'ok') withheld = `labels ${facts.labelsState}`
  else if (!repository) withheld = 'no GitHub origin'
  else {
    try {
      tracker = await trackerProposal(checkout, facts, deps.triage ?? (await loadTriageInit()), repository)
      if (tracker?.plan.refused.length) {
        refusal = tracker.plan.refused.join('\n')
        tracker = null
      }
    } catch (err) {
      withheld = err instanceof Error ? err.message : String(err)
      tracker = null
    }
  }
  return {
    checkout,
    repository,
    facts,
    stack,
    tracker,
    withheld,
    refusal,
    digest: digestFor(checkout, repository, stack, tracker, withheld, refusal),
  }
}

function trackerChanges(tracker: TrackerProposal | null): boolean {
  return Boolean(
    tracker && (tracker.plan.createLabels.length || tracker.plan.relabels.length || tracker.plan.contract === 'write'),
  )
}

function printProposal(proposal: FeatureProposal): void {
  console.log(`checkout: ${proposal.checkout}`)
  console.log(`repository: ${proposal.repository ?? 'unknown'}`)
  for (const line of plan(proposal.facts)) console.log(line)
  for (const addition of proposal.stack.additions) console.log(`stack add ${addition.key}: ${addition.source}`)
  for (const conflict of proposal.stack.conflicts) console.log(`stack conflict: ${conflict}`)
  console.log(
    `tracker: ${proposal.tracker?.canonical ?? (proposal.withheld ? `withheld (${proposal.withheld})` : 'withheld')}`,
  )
  if (proposal.refusal) console.log(`refused: ${proposal.refusal}`)
  console.log(`digest: ${proposal.digest}`)
  console.log('digest is not authorization')
}

function authenticateApproval(parsed: FeatureArgs, preview: FeatureProposal): void {
  // Strip whitespace + Cf (ZWSP/ZWNJ/…) so digest±format-chars cannot pass as a
  // distinct operator reply (Spec B: digest is not authorization).
  const operatorApproval = (parsed.operatorApproval ?? '').replace(/[\s\p{Cf}]/gu, '')
  if (
    !parsed.approve ||
    !operatorApproval ||
    operatorApproval === parsed.approve ||
    operatorApproval === preview.digest
  ) {
    throw new Error('init=refused explicit operator approval is required')
  }
  if (parsed.approve !== preview.digest) throw new Error('init=refused approval digest does not match the preview')
}

function refusePrincipal(checkout: string, principal: boolean | undefined): void {
  if (!(principal ?? isPrincipal(checkout))) return
  throw Object.assign(new Error('init=refused principal'), { exitCode: 2 })
}

function assertRereadMatches(preview: FeatureProposal, reread: FeatureProposal): void {
  if (reread.digest !== preview.digest || Boolean(reread.tracker) !== Boolean(preview.tracker)) {
    throw new Error('init=refused plan changed before apply')
  }
}

function writeProposedStack(proposal: FeatureProposal): void {
  if (proposal.stack.after === null || proposal.stack.after === proposal.stack.before) return
  const stackPath = join(proposal.checkout, '.dev', 'stack.yml')
  mkdirSync(dirname(stackPath), { recursive: true })
  writeFileSync(stackPath, proposal.stack.after)
}

async function applyRereadTracker(proposal: FeatureProposal, deps: FeatureInitDeps): Promise<void> {
  if (!proposal.tracker || !trackerChanges(proposal.tracker)) return
  await (deps.triage ?? (await loadTriageInit())).applyApprovedPlan(
    proposal.tracker.plan,
    proposal.tracker.contractText,
    proposal.tracker.deps,
  )
}

/** Preview by default; apply requires a matching digest and separate operator text. */
export async function initFeature(args: string[], deps: FeatureInitDeps = {}): Promise<FeatureProposal> {
  const parsed = featureArgs(args)
  const preview = await previewFeatureInit(parsed.dir ?? process.cwd(), deps)
  printProposal(preview)
  if (parsed.dryRun || parsed.approve === undefined) return preview
  authenticateApproval(parsed, preview)
  refusePrincipal(preview.checkout, deps.principal)
  if (preview.refusal) throw new Error(`init=refused ${preview.refusal}`)
  if (preview.stack.additions.length === 0 && !trackerChanges(preview.tracker)) {
    console.log('init=noop')
    return preview
  }
  const reread = await previewFeatureInit(preview.checkout, deps)
  assertRereadMatches(preview, reread)
  writeProposedStack(reread)
  await applyRereadTracker(reread, deps)
  return preview
}
