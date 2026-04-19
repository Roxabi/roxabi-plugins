/**
 * scaffold-rules.ts — Generate CLAUDE.md Critical Rules sections from stack.yml values.
 *
 * Reads .claude/stack.yml, detects project type, and produces markdown sections
 * that can be appended to or merged into an existing CLAUDE.md.
 *
 * Usage:
 *   bun init.ts scaffold-rules [--stack-path .claude/stack.yml] [--project-name <name>] [--claude-md CLAUDE.md]
 *
 * Output: JSON { sections: Section[], markdown: string, projectType: string }
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StackConfig {
  runtime?: string
  package_manager?: string
  backend?: { framework?: string; path?: string }
  frontend?: { framework?: string; path?: string }
  commands?: Record<string, string>
  artifacts?: Record<string, string>
  standards?: Record<string, string>
  docs?: { framework?: string; path?: string; format?: string }
  deploy?: { platform?: string }
  hooks?: { tool?: string }
}

type ProjectType = 'full-app' | 'backend-only' | 'frontend-only' | 'cli-library' | 'docs-content' | 'stub'

interface Section {
  id: string
  title: string
  content: string
}

interface ScaffoldRulesResult {
  projectType: ProjectType
  sections: Section[]
  markdown: string
}

// ---------------------------------------------------------------------------
// Stack.yml parser (minimal YAML — no dependency needed)
// NOTE: Only supports 2-level nesting (top-level keys + 2-space-indented children).
// If the stack.yml schema grows to need deeper nesting, replace with a proper YAML parser.
// ---------------------------------------------------------------------------

function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentSection = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue

    const sectionMatch = line.match(/^(\w[\w_]*):\s*$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      result[currentSection] = {}
      continue
    }

    const nestedMatch = line.match(/^\s{2}(\w[\w_]*):\s*(.*)$/)
    if (nestedMatch && currentSection) {
      const section = result[currentSection] as Record<string, string>
      section[nestedMatch[1]] = nestedMatch[2].replace(/^["']|["']$/g, '').trim()
      continue
    }

    const topMatch = line.match(/^(\w[\w_]*):\s+(.+)$/)
    if (topMatch) {
      result[topMatch[1]] = topMatch[2].replace(/^["']|["']$/g, '').trim()
    }
  }

  return result
}

function loadStack(stackPath: string): StackConfig {
  if (!existsSync(stackPath)) return {}
  const raw = readFileSync(stackPath, 'utf-8')
  const parsed = parseSimpleYaml(raw)

  return {
    runtime: parsed.runtime as string | undefined,
    package_manager: parsed.package_manager as string | undefined,
    backend: parsed.backend as StackConfig['backend'],
    frontend: parsed.frontend as StackConfig['frontend'],
    commands: parsed.commands as Record<string, string> | undefined,
    artifacts: parsed.artifacts as Record<string, string> | undefined,
    standards: parsed.standards as Record<string, string> | undefined,
    docs: parsed.docs as StackConfig['docs'],
    deploy: parsed.deploy as StackConfig['deploy'],
    hooks: parsed.hooks as StackConfig['hooks'],
  }
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

function detectProjectType(stack: StackConfig): ProjectType {
  const hasBE = stack.backend?.framework && stack.backend.framework !== 'none'
  const hasFE = stack.frontend?.framework && stack.frontend.framework !== 'none'
  const hasDocs = stack.docs?.framework && stack.docs.framework !== 'none'

  if (hasBE && hasFE) return 'full-app'
  if (hasBE && !hasFE) return 'backend-only'
  if (hasFE && !hasBE) return 'frontend-only'
  if (hasDocs && !hasBE && !hasFE) return 'docs-content'

  // CLI/library: both none but has commands or a runtime
  if (stack.runtime || stack.commands?.dev) return 'cli-library'

  return 'stub'
}

// ---------------------------------------------------------------------------
// Project name detection
// ---------------------------------------------------------------------------

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
}

function detectProjectName(explicit?: string): string {
  if (explicit) return sanitizeName(explicit)
  try {
    const remoteUrl = Bun.spawnSync(['git', 'remote', 'get-url', 'origin']).stdout.toString().trim()
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/)
    if (match) return sanitizeName(match[1])
  } catch {
    /* ignore */
  }
  return sanitizeName(basename(process.cwd()))
}

// ---------------------------------------------------------------------------
// Section generators
// ---------------------------------------------------------------------------

function tldr(_stack: StackConfig, projectName: string, projectType: ProjectType): Section {
  const parts: string[] = []

  parts.push(`- **Project:** ${projectName}`)
  parts.push(
    '- **Before work:** Use `/dev #N` as the single entry point — it determines tier (S / F-lite / F-full) and drives the full lifecycle',
  )

  if (projectType !== 'docs-content' && projectType !== 'stub') {
    parts.push(`- **All code changes** → worktree: \`git worktree add ../${projectName}-XXX -b feat/XXX-slug staging\``)
  }

  parts.push('- **Never** use `--force`/`--hard`/`--amend`')
  parts.push('- **Always** use appropriate skill even without slash command')

  if (projectType === 'full-app' || projectType === 'backend-only' || projectType === 'frontend-only') {
    parts.push('- **Before code:** Read relevant standards doc (see Coding Standards section below)')
    parts.push('- **Orchestrator** delegates to agents — only minor fixes directly')
  }

  return { id: 'tldr', title: 'TL;DR', content: parts.join('\n') }
}

function devProcess(_stack: StackConfig, _projectType: ProjectType): Section {
  const content = `**Entry point: \`/dev #N\`** — single command that scans artifacts, shows progress, and delegates to the right phase skill.

| Tier | Criteria | Phases |
|------|----------|--------|
| **S** | ≤3 files, no arch, no risk | triage → implement → pr → validate → review → fix* → cleanup* |
| **F-lite** | Clear scope, single domain | Frame → spec → plan → implement → verify → ship |
| **F-full** | New arch, unclear reqs, >2 domains | Frame → analyze → spec → plan → implement → verify → ship |

\`*\` = conditional (runs only if applicable)

Phases: **Frame** (problem) → **Shape** (spec) → **Build** (code) → **Verify** (review) → **Ship** (release).`

  return { id: 'dev-process', title: 'Dev Process', content }
}

function orchestratorDelegation(): Section {
  return {
    id: 'orchestrator-delegation',
    title: 'Orchestrator Delegation',
    content: `Orchestrator does not modify code/docs directly. Delegate: FE→\`frontend-dev\` | BE→\`backend-dev\` | Infra→\`devops\` | Docs→\`doc-writer\` | Tests→\`tester\` | Fixes→\`fixer\`. Exception: typo/single-line. Deploy→\`devops\` only.`,
  }
}

function parallelExecution(): Section {
  return {
    id: 'parallel-execution',
    title: 'Parallel Execution',
    content: `≥3 complex tasks → propose Sequential | Parallel (Recommended).
F-full + ≥4 independent tasks in 1 domain → multiple same-type agents on separate file groups.`,
  }
}

function gitRules(): Section {
  return {
    id: 'git',
    title: 'Git',
    content: `Format: \`<type>(<scope>): <desc>\`
Types: feat|fix|refactor|docs|style|test|chore|ci|perf
Never push without request. Never force/hard/amend. Hook fail → fix + NEW commit.`,
  }
}

function artifactModel(stack: StackConfig): Section {
  const artifacts = stack.artifacts ?? {
    frames: 'artifacts/frames',
    analyses: 'artifacts/analyses',
    specs: 'artifacts/specs',
    plans: 'artifacts/plans',
  }

  const content = `Artifacts are the state markers \`/dev\` uses for progress detection and resumption.

| Type | Directory | Question answered |
|------|-----------|-------------------|
| **Frame** | \`${artifacts.frames ?? 'artifacts/frames'}/\` | What's the problem? |
| **Analysis** | \`${artifacts.analyses ?? 'artifacts/analyses'}/\` | How deep is it? |
| **Spec** | \`${artifacts.specs ?? 'artifacts/specs'}/\` | What will we build? |
| **Plan** | \`${artifacts.plans ?? 'artifacts/plans'}/\` | How do we build it? |`

  return { id: 'artifact-model', title: 'Artifact Model', content }
}

function mandatoryWorktree(projectName: string): Section {
  const content = `\`\`\`bash
git worktree add ../${projectName}-XXX -b feat/XXX-slug staging
cd ../${projectName}-XXX && cp .env.example .env && bun install
\`\`\`

Exceptions: XS (confirm first) | \`/dev\` pre-implementation artifacts (frame, analysis, spec, plan) | \`/promote\` release artifacts.
**Never code on main/staging without worktree.**`

  return { id: 'mandatory-worktree', title: 'Mandatory Worktree', content }
}

function codeReview(stack: StackConfig): Section {
  const reviewPath = stack.standards?.code_review ?? 'docs/standards/code-review.mdx'
  return {
    id: 'code-review',
    title: 'Code Review',
    content: `MUST read [code-review](${reviewPath}). Conventional Comments. Block only: security, correctness, standard violations.`,
  }
}

function codingStandards(stack: StackConfig, projectType: ProjectType): Section {
  const rows: string[] = []

  if (projectType === 'full-app' || projectType === 'frontend-only') {
    const fePath = stack.standards?.frontend ?? 'docs/standards/frontend-patterns.mdx'
    rows.push(`| React / Frontend | [frontend-patterns](${fePath}) |`)
  }
  if (projectType === 'full-app' || projectType === 'backend-only') {
    const bePath = stack.standards?.backend ?? 'docs/standards/backend-patterns.mdx'
    rows.push(`| API / Backend | [backend-patterns](${bePath}) |`)
  }

  const testPath = stack.standards?.testing ?? 'docs/standards/testing.mdx'
  rows.push(`| Tests | [testing](${testPath}) |`)

  const content = `| Context | Read |
|---------|------|
${rows.join('\n')}`

  return { id: 'coding-standards', title: 'Coding Standards', content }
}

function skillsAndAgents(): Section {
  return {
    id: 'skills-agents',
    title: 'Skills & Agents',
    content: `Skills: always use appropriate skill. Workflow skills → \`dev-core\` plugin.
Agents: Sonnet = all agents (frontend-dev, backend-dev, devops, doc-writer, fixer, tester, architect, product-lead, security-auditor).

**Shared agent rules:** Never force/hard/amend | Stage specific files only | Escalate blockers → lead | Message lead on completion.`,
  }
}

function gotchas(): Section {
  return { id: 'gotchas', title: 'Gotchas', content: '<!-- Add project-specific gotchas here -->' }
}

// ---------------------------------------------------------------------------
// Section selection per project type
// ---------------------------------------------------------------------------

const APP_SECTIONS = [
  'tldr',
  'dev-process',
  'orchestrator-delegation',
  'parallel-execution',
  'git',
  'artifact-model',
  'mandatory-worktree',
  'code-review',
  'coding-standards',
  'skills-agents',
  'gotchas',
]

const SECTION_MAP: Record<ProjectType, string[]> = {
  'full-app': APP_SECTIONS,
  'backend-only': APP_SECTIONS,
  'frontend-only': APP_SECTIONS,
  'cli-library': ['tldr', 'dev-process', 'git', 'artifact-model', 'coding-standards', 'gotchas'],
  'docs-content': ['tldr', 'git', 'gotchas'],
  stub: ['tldr', 'git'],
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

function generateSections(stack: StackConfig, projectType: ProjectType, projectName: string): Section[] {
  const sectionIds = SECTION_MAP[projectType]

  const generators: Record<string, () => Section> = {
    tldr: () => tldr(stack, projectName, projectType),
    'dev-process': () => devProcess(stack, projectType),
    'orchestrator-delegation': () => orchestratorDelegation(),
    'parallel-execution': () => parallelExecution(),
    git: () => gitRules(),
    'artifact-model': () => artifactModel(stack),
    'mandatory-worktree': () => mandatoryWorktree(projectName),
    'code-review': () => codeReview(stack),
    'coding-standards': () => codingStandards(stack, projectType),
    'skills-agents': () => skillsAndAgents(),
    gotchas: () => gotchas(),
  }

  return sectionIds.map((id) => generators[id]?.()).filter((s): s is Section => s !== undefined)
}

function sectionsToMarkdown(sections: Section[]): string {
  const parts: string[] = []
  let ruleNumber = 0

  for (const section of sections) {
    if (section.id === 'tldr') {
      parts.push(`## TL;DR`, '', section.content, '')
    } else if (section.id === 'skills-agents' || section.id === 'gotchas') {
      parts.push(`## ${section.title}`, '', section.content, '')
    } else {
      ruleNumber++
      parts.push(`### ${ruleNumber}. ${section.title}`, '', section.content, '')
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Existing CLAUDE.md analysis
// ---------------------------------------------------------------------------

interface ExistingSections {
  hasImport: boolean
  sectionIds: string[]
}

function analyzeExistingClaudeMd(claudeMdPath: string): ExistingSections {
  if (!existsSync(claudeMdPath)) {
    return { hasImport: false, sectionIds: [] }
  }

  const content = readFileSync(claudeMdPath, 'utf-8')
  const lines = content.split('\n')

  const hasImport = lines[0]?.trim() === '@.claude/stack.yml'

  // Detect which Critical Rules sections already exist
  const sectionPatterns: Record<string, RegExp> = {
    tldr: /^## TL;DR/i,
    'dev-process': /^###?\s*(?:\d+[.\s]*)?Dev Process/i,
    'ask-user-question': /^###?\s*(?:\d+[.\s]*)?AskUserQuestion/i,
    'orchestrator-delegation': /^###?\s*(?:\d+[.\s]*)?Orchestrator/i,
    'parallel-execution': /^###?\s*(?:\d+[.\s]*)?Parallel/i,
    git: /^###?\s*(?:\d+[.\s]*)?Git/i,
    'artifact-model': /^###?\s*(?:\d+[.\s]*)?Artifact/i,
    'mandatory-worktree': /^###?\s*(?:\d+[.\s]*)?Mandatory Worktree/i,
    'code-review': /^###?\s*(?:\d+[.\s]*)?Code Review/i,
    'coding-standards': /^###?\s*(?:\d+[.\s]*)?Coding Standards/i,
    'skills-agents': /^## Skills/i,
    gotchas: /^## Gotchas/i,
  }

  const found: string[] = []
  for (const line of lines) {
    for (const [id, pattern] of Object.entries(sectionPatterns)) {
      if (pattern.test(line.trim()) && !found.includes(id)) {
        found.push(id)
      }
    }
  }

  return { hasImport, sectionIds: found }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScaffoldRulesOptions {
  stackPath?: string
  projectName?: string
  claudeMdPath?: string
}

export function scaffoldRules(
  options: ScaffoldRulesOptions = {},
): ScaffoldRulesResult & { existing: ExistingSections } {
  const stackPath = resolve(options.stackPath ?? '.claude/stack.yml')
  const claudeMdPath = resolve(options.claudeMdPath ?? 'CLAUDE.md')

  const stack = loadStack(stackPath)
  const projectType = detectProjectType(stack)
  const projectName = detectProjectName(options.projectName)
  const sections = generateSections(stack, projectType, projectName)
  const markdown = sectionsToMarkdown(sections)
  const existing = analyzeExistingClaudeMd(claudeMdPath)

  return { projectType, sections, markdown, existing }
}

/**
 * Returns the list of expected section IDs for a given project type.
 * Used by /doctor to check completeness.
 */
export function expectedSections(projectType: ProjectType): string[] {
  return SECTION_MAP[projectType] ?? []
}

export type { ProjectType, Section }
