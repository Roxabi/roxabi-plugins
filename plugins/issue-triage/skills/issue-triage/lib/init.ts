/**
 * `init` — tracker contract, canonical labels, legacy label migration.
 *
 * Label writes go through the GitHub adapter. `--dry-run` writes nothing.
 * A repository label definition is never deleted. Issue bodies are never edited.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectGitHubRepo } from '../../shared/adapters/config-helpers'
import { ensureLabel, listIssueLabelSets, listLabelNames, updateLabels } from '../../shared/adapters/github-adapter'
import {
  applyRelabels,
  type IssueLabels,
  type IssueRelabel,
  migrateLabel,
  missingCanonical,
  planRelabels,
  proseBlockedBy,
} from './migrate-labels'

const CONTRACT_REL = 'docs/agents/issue-tracker.md'

export interface InitPlan {
  repo: string
  createLabels: string[]
  relabels: IssueRelabel[]
  proseBlockedBy: number[]
  contract: 'write' | 'unchanged' | 'skip-other-repo'
}

export interface InitDeps {
  listLabelNames: (repo: string) => Promise<string[]>
  listIssueLabelSets: (repo: string) => Promise<IssueLabels[]>
  ensureLabel: (name: string, repo: string) => Promise<'created' | 'present'>
  updateLabels: (issueNumber: number, add: string[], remove: string[], repo: string) => Promise<void>
  readContract: () => string | null
  writeContract: (text: string) => void
  cwdRepo: string
}

function renderContract(repo: string, labels: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const template = readFileSync(join(here, '../templates/issue-tracker.md'), 'utf8')
  const list = labels.length === 0 ? '(none)' : labels.map((name) => `- \`${name}\``).join('\n')
  return template.replaceAll('{{REPO}}', repo).replaceAll('{{LABELS}}', list)
}

function contractAction(cwdRepo: string, repo: string, current: string | null, next: string): InitPlan['contract'] {
  if (repo !== cwdRepo) return 'skip-other-repo'
  if (current === next) return 'unchanged'
  return 'write'
}

export function formatPlan(plan: InitPlan, dryRun: boolean): string {
  const pairs = new Map<string, number>()
  for (const row of plan.relabels) {
    for (const removed of row.remove) {
      const move = migrateLabel(removed)
      const key = `${removed} → ${move.add ?? '(remove)'}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
    }
  }
  const lines = [
    `repo: ${plan.repo}`,
    `dry-run: ${dryRun}`,
    `create labels (${plan.createLabels.length}): ${plan.createLabels.join(', ') || '(none)'}`,
    `relabel issues: ${plan.relabels.length}`,
    ...[...pairs.entries()].map(([key, count]) => `  ${key}: ${count}`),
    `prose Blocked by: ${plan.proseBlockedBy.join(', ') || '(none)'}`,
    `contract: ${plan.contract}`,
    `writes: ${dryRun ? 0 : 'pending'}`,
  ]
  return lines.join('\n')
}

export async function buildPlan(
  repo: string,
  cwdRepo: string,
  deps: Pick<InitDeps, 'listLabelNames' | 'listIssueLabelSets' | 'readContract'>,
): Promise<{ plan: InitPlan; issues: IssueLabels[]; contractText: string }> {
  const [defined, issues, current] = await Promise.all([
    deps.listLabelNames(repo),
    deps.listIssueLabelSets(repo),
    Promise.resolve(deps.readContract()),
  ])
  const createLabels = missingCanonical(defined)
  const afterCreate = [...defined, ...createLabels]
  const contractText = renderContract(repo, afterCreate.sort())
  return {
    issues,
    contractText,
    plan: {
      repo,
      createLabels,
      relabels: planRelabels(issues),
      proseBlockedBy: proseBlockedBy(issues),
      contract: contractAction(cwdRepo, repo, current, contractText),
    },
  }
}

/** True when a second pass over the post-migration labels has nothing to do. */
export function secondPassIsNoop(
  issues: IssueLabels[],
  defined: string[],
  relabels: IssueRelabel[],
  created: string[],
): boolean {
  const nextIssues = applyRelabels(issues, relabels)
  const nextDefined = [...defined, ...created]
  return planRelabels(nextIssues).length === 0 && missingCanonical(nextDefined).length === 0
}

function parseArgs(args: string[]): { dryRun: boolean; repo?: string } {
  let dryRun = false
  let repo: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--repo') {
      repo = args[++i]
      if (!repo) throw new Error('init: --repo needs owner/repo')
      continue
    }
    throw new Error(`init: unknown argument ${arg}`)
  }
  return { dryRun, repo }
}

function defaultDeps(cwdRepo: string): InitDeps {
  return {
    listLabelNames,
    listIssueLabelSets,
    ensureLabel,
    updateLabels,
    cwdRepo,
    readContract: () => (existsSync(CONTRACT_REL) ? readFileSync(CONTRACT_REL, 'utf8') : null),
    writeContract: (text) => {
      mkdirSync(dirname(CONTRACT_REL), { recursive: true })
      writeFileSync(CONTRACT_REL, text)
    },
  }
}

export async function initIssues(args: string[], deps?: InitDeps): Promise<InitPlan> {
  const { dryRun, repo: repoFlag } = parseArgs(args)
  const cwdRepo = deps?.cwdRepo ?? detectGitHubRepo()
  const repo = repoFlag ?? cwdRepo
  const bound = deps ?? defaultDeps(cwdRepo)
  const { plan, contractText } = await buildPlan(repo, cwdRepo, bound)
  console.log(formatPlan(plan, dryRun))
  if (dryRun) return plan

  for (const name of plan.createLabels) await bound.ensureLabel(name, repo)
  for (const row of plan.relabels) await bound.updateLabels(row.number, row.add, row.remove, repo)
  if (plan.contract === 'write') bound.writeContract(contractText)
  return plan
}
