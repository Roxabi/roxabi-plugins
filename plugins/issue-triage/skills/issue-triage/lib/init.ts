/**
 * `init` — tracker contract, canonical labels, legacy label migration.
 *
 * An existing `docs/agents/issue-tracker.md` is an authored contract: init never
 * rewrites it. Label vocabulary comes from that file when it exists (a
 * `Label | Colour` table, or the template's bullet list); otherwise from
 * `CANONICAL_LABELS`. Label writes go through the GitHub adapter. `--dry-run`
 * writes nothing. A repository label definition is never deleted or recoloured.
 * Issue bodies are never edited.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectGitHubRepo } from '../../shared/adapters/config-helpers'
import { ensureLabel, listIssueLabelSets, listLabelNames, updateLabels } from '../../shared/adapters/github-adapter'
import {
  applyRelabels,
  CANONICAL_LABELS,
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
  labelColors: Record<string, string>
  relabels: IssueRelabel[]
  proseBlockedBy: number[]
  contract: 'write' | 'unchanged' | 'skip-other-repo' | 'keep-existing'
}

export interface InitDeps {
  listLabelNames: (repo: string) => Promise<string[]>
  listIssueLabelSets: (repo: string) => Promise<IssueLabels[]>
  ensureLabel: (name: string, repo: string, color?: string) => Promise<'created' | 'present'>
  updateLabels: (issueNumber: number, add: string[], remove: string[], repo: string) => Promise<void>
  readContract: () => string | null
  writeContract: (text: string) => void
  cwdRepo: string
}

const DEFAULT_LABEL_COLOR = 'ededed'

export interface ContractLabel {
  name: string
  color: string
}

function renderContract(repo: string, labels: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const template = readFileSync(join(here, '../templates/issue-tracker.md'), 'utf8')
  const list = labels.length === 0 ? '(none)' : labels.map((name) => `- \`${name}\``).join('\n')
  return template.replaceAll('{{REPO}}', repo).replaceAll('{{LABELS}}', list)
}

/** Absent → write. Byte-identical to the template → unchanged. Anything else is kept. */
export function contractAction(
  cwdRepo: string,
  repo: string,
  current: string | null,
  next: string,
): InitPlan['contract'] {
  if (repo !== cwdRepo) return 'skip-other-repo'
  if (current === null) return 'write'
  if (current === next) return 'unchanged'
  return 'keep-existing'
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function plainCell(cell: string): string {
  return cell.replace(/`/g, '').trim()
}

function parseLabelTable(markdown: string): ContractLabel[] | null {
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const header = splitTableRow(lines[i])
    if (!header) continue
    const labelIdx = header.findIndex((cell) => plainCell(cell).toLowerCase() === 'label')
    const colorIdx = header.findIndex((cell) => /^colou?r$/i.test(plainCell(cell)))
    if (labelIdx < 0 || colorIdx < 0) continue
    const labels: ContractLabel[] = []
    for (const line of lines.slice(i + 1)) {
      const row = splitTableRow(line)
      if (!row) break
      if (row.every((cell) => /^:?-{3,}:?$/.test(plainCell(cell)))) continue
      const name = plainCell(row[labelIdx] ?? '')
      if (!name) continue
      const color = plainCell(row[colorIdx] ?? '')
        .replace(/^#/, '')
        .toLowerCase()
      labels.push({ name, color: color || DEFAULT_LABEL_COLOR })
    }
    return labels
  }
  return null
}

function parseTemplateList(markdown: string): ContractLabel[] | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^##\s+Labels in use\s*$/.test(line.trim()))
  if (start < 0) return null
  const labels: ContractLabel[] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (/^#{1,6}\s/.test(trimmed)) break
    if (trimmed === '(none)') return []
    const bullet = /^[-*]\s+`([^`]+)`\s*$/.exec(trimmed)
    if (bullet) labels.push({ name: bullet[1].trim(), color: DEFAULT_LABEL_COLOR })
  }
  return labels
}

/** Kit `Label | Colour` table, else the template's `## Labels in use` list. */
export function parseContractLabels(markdown: string): ContractLabel[] {
  return parseLabelTable(markdown) ?? parseTemplateList(markdown) ?? []
}

function vocabularyFor(current: string | null): ContractLabel[] {
  if (current === null) {
    return CANONICAL_LABELS.map((name) => ({ name, color: DEFAULT_LABEL_COLOR }))
  }
  return parseContractLabels(current)
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
  const vocabulary = vocabularyFor(current)
  const have = new Set(defined)
  const createLabels = vocabulary.filter((row) => !have.has(row.name)).map((row) => row.name)
  const labelColors = Object.fromEntries(vocabulary.map((row) => [row.name, row.color]))
  const afterCreate = [...defined, ...createLabels]
  const contractText = renderContract(repo, afterCreate.sort())
  return {
    issues,
    contractText,
    plan: {
      repo,
      createLabels,
      labelColors,
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

  for (const name of plan.createLabels) {
    await bound.ensureLabel(name, repo, plan.labelColors[name] ?? DEFAULT_LABEL_COLOR)
  }
  for (const row of plan.relabels) await bound.updateLabels(row.number, row.add, row.remove, repo)
  if (plan.contract === 'write') bound.writeContract(contractText)
  return plan
}
