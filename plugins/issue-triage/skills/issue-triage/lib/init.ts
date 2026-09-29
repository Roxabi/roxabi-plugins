/**
 * `init` — tracker contract, canonical labels, legacy label migration.
 *
 * An existing `docs/agents/issue-tracker.md` is an authored contract: init never
 * rewrites it. The file is read from the git toplevel, not the process cwd.
 * Label vocabulary comes from that file when it exists (a `Label | Colour`
 * table, or canonical names in the template list); otherwise from
 * `CANONICAL_LABELS`. A contract that parses to no vocabulary is a refusal,
 * not an empty plan. `--repo` other than the local repo is refused: the local
 * file is not that repo's vocabulary. Label writes go through the GitHub
 * adapter. `--dry-run` writes nothing. A repository label definition is never
 * deleted or recoloured. Issue bodies are never edited.
 */

import { execFileSync } from 'node:child_process'
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
  planRelabels,
  proseBlockedBy,
} from './migrate-labels'

const CONTRACT_REL = 'docs/agents/issue-tracker.md'
const NONE_PARSED = 'vocabulary: none parsed from docs/agents/issue-tracker.md'

export type VocabularySource = 'table' | 'template-list' | 'canonical' | 'none'

export interface InitPlan {
  repo: string
  createLabels: string[]
  labelColors: Record<string, string>
  relabels: IssueRelabel[]
  proseBlockedBy: number[]
  contract: 'write' | 'unchanged' | 'skip-other-repo' | 'keep-existing'
  vocabulary: VocabularySource
  refused: string[]
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

function fold(name: string): string {
  return name.toLowerCase()
}

function canonicalSpelling(name: string): string | null {
  return CANONICAL_LABELS.find((label) => fold(label) === fold(name)) ?? null
}

function sameLabel(left: string, right: string): boolean {
  return fold(left) === fold(right)
}

export function contractFile(root: string): string {
  return join(root, CONTRACT_REL)
}

function gitRevParse(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
}

/** Contract path is the git toplevel, never the process cwd. */
export function repoToplevel(cwd: string, revParse: (cwd: string) => string = gitRevParse): string {
  return revParse(cwd)
}

export function readContractFile(root: string): string | null {
  const file = contractFile(root)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function renderContract(repo: string, labels: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const template = readFileSync(join(here, '../templates/issue-tracker.md'), 'utf8')
  const list = labels.length === 0 ? '(none)' : labels.map((name) => `- \`${name}\``).join('\n')
  return template.replaceAll('{{REPO}}', repo).replaceAll('{{LABELS}}', list)
}

export function contractReader(cwd: string, revParse: (cwd: string) => string = gitRevParse): () => string | null {
  const file = contractFile(repoToplevel(cwd, revParse))
  return () => (existsSync(file) ? readFileSync(file, 'utf8') : null)
}
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
  if (!trimmed.includes('|') || trimmed.startsWith('#')) return null
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
  return cells.length < 2 ? null : cells
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
    if (!bullet) continue
    const name = canonicalSpelling(bullet[1])
    if (name) labels.push({ name, color: DEFAULT_LABEL_COLOR })
  }
  return labels
}

export function classifyVocabulary(markdown: string): {
  source: Exclude<VocabularySource, 'canonical'>
  labels: ContractLabel[]
} {
  const table = parseLabelTable(markdown)
  if (table && table.length > 0) return { source: 'table', labels: table }
  const list = parseTemplateList(markdown)
  if (list && list.length > 0) return { source: 'template-list', labels: list }
  return { source: 'none', labels: [] }
}

/** Kit `Label | Colour` table, else canonical names listed under `## Labels in use`. */
export function parseContractLabels(markdown: string): ContractLabel[] {
  return classifyVocabulary(markdown).labels
}

function vocabularyFor(current: string | null): { source: VocabularySource; labels: ContractLabel[] } {
  if (current === null) {
    return {
      source: 'canonical',
      labels: CANONICAL_LABELS.map((name) => ({ name, color: DEFAULT_LABEL_COLOR })),
    }
  }
  return classifyVocabulary(current)
}

export function relabelTargetsOutside(defined: string[], createLabels: string[], relabels: IssueRelabel[]): string[] {
  const allowed = new Set([...defined, ...createLabels].map(fold))
  const outside: string[] = []
  for (const row of relabels) {
    for (const add of row.add) {
      if (!allowed.has(fold(add)) && !outside.some((name) => sameLabel(name, add))) outside.push(add)
    }
  }
  return outside
}

function vocabularyLine(plan: InitPlan): string {
  if (plan.refused.some((line) => line.startsWith('vocabulary: none parsed'))) return NONE_PARSED
  return `vocabulary: ${plan.vocabulary}`
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
    vocabularyLine(plan),
    `create labels (${plan.createLabels.length}): ${plan.createLabels.join(', ') || '(none)'}`,
    `relabel issues: ${plan.relabels.length}`,
    ...[...pairs.entries()].map(([key, count]) => `  ${key}: ${count}`),
    `prose Blocked by: ${plan.proseBlockedBy.join(', ') || '(none)'}`,
    `contract: ${plan.contract}`,
    ...plan.refused.filter((line) => !line.startsWith('vocabulary: none parsed')).map((line) => `refused: ${line}`),
    `writes: ${dryRun ? 0 : 'pending'}`,
  ]
  return lines.join('\n')
}

export async function buildPlan(
  repo: string,
  cwdRepo: string,
  deps: Pick<InitDeps, 'listLabelNames' | 'listIssueLabelSets' | 'readContract'>,
): Promise<{ plan: InitPlan; issues: IssueLabels[]; contractText: string }> {
  const otherRepo = repo !== cwdRepo
  const [defined, issues, current] = await Promise.all([
    deps.listLabelNames(repo),
    deps.listIssueLabelSets(repo),
    otherRepo ? Promise.resolve(null) : Promise.resolve(deps.readContract()),
  ])
  const parsed = otherRepo ? { source: 'none' as const, labels: [] } : vocabularyFor(current)
  const createLabels: string[] = []
  const mismatches: string[] = []
  for (const row of parsed.labels) {
    const match = defined.find((name) => sameLabel(name, row.name))
    if (!match) createLabels.push(row.name)
    else if (match !== row.name) mismatches.push(`${row.name}: repo has ${match}`)
  }
  const relabels = planRelabels(issues)
  const refused: string[] = []
  if (otherRepo) {
    refused.push(`init: --repo ${repo} is not the local repo ${cwdRepo}; refusing without an explicit vocabulary`)
  }
  if (!otherRepo && current !== null && parsed.source === 'none') refused.push(NONE_PARSED)
  for (const row of mismatches) refused.push(`label case mismatch: ${row}`)
  for (const name of relabelTargetsOutside(defined, createLabels, relabels)) {
    refused.push(`${name}: not in contract vocabulary, not on repo`)
  }
  const labelColors = Object.fromEntries(parsed.labels.map((row) => [row.name, row.color]))
  const contractText = renderContract(repo, [...defined, ...createLabels].sort())
  return {
    issues,
    contractText,
    plan: {
      repo,
      createLabels,
      labelColors,
      relabels,
      proseBlockedBy: proseBlockedBy(issues),
      contract: contractAction(cwdRepo, repo, otherRepo ? null : current, contractText),
      vocabulary: parsed.source,
      refused,
    },
  }
}

/** True when a second pass over the post-migration labels has nothing to do. */
export function secondPassIsNoop(
  issues: IssueLabels[],
  defined: string[],
  relabels: IssueRelabel[],
  created: string[],
  vocabulary: readonly string[] = CANONICAL_LABELS,
): boolean {
  const nextIssues = applyRelabels(issues, relabels)
  const have = new Set([...defined, ...created].map(fold))
  const missing = vocabulary.filter((name) => !have.has(fold(name)))
  return planRelabels(nextIssues).length === 0 && missing.length === 0
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

function defaultDeps(cwdRepo: string, cwd = process.cwd()): InitDeps {
  const file = contractFile(repoToplevel(cwd))
  return {
    listLabelNames,
    listIssueLabelSets,
    ensureLabel,
    updateLabels,
    cwdRepo,
    readContract: contractReader(cwd),
    writeContract: (text) => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
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
  if (plan.refused.length > 0) throw new Error(plan.refused.join('\n'))

  for (const name of plan.createLabels) {
    await bound.ensureLabel(name, repo, plan.labelColors[name] ?? DEFAULT_LABEL_COLOR)
  }
  for (const row of plan.relabels) await bound.updateLabels(row.number, row.add, row.remove, repo)
  if (plan.contract === 'write') bound.writeContract(contractText)
  return plan
}
