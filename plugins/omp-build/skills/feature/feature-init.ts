#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export type Facts = {
  hasTracker: boolean
  labels: string[]
  hasSemctx: boolean
  hasSemctxHooks: boolean
  hasWorkingEmptyJob: boolean
  activeContracts: number
  hasAssertledger: boolean
  vitest: boolean
  hasCcc: boolean
  hasCodegraph: boolean
  mergeOnGreen: boolean
  checks: string[]
  hasWorktree: boolean
  hasPostMerge: boolean
  hasReleaseModel: boolean
  cccConsent: boolean
  codegraphConsent: boolean
}

export function plan(facts: Facts): string[] {
  const lines: string[] = []
  if (!facts.hasTracker) lines.push('tracker contract')
  if (facts.labels.some((label) => /^(XS|S|M|L|XL)$/.test(label) || label.startsWith('priority:'))) {
    lines.push('label migration')
  } else if (!facts.hasTracker) {
    lines.push('labels')
  }
  if (facts.hasSemctx && !facts.hasSemctxHooks) lines.push('semctx hooks')
  if (facts.hasSemctx && !facts.hasWorkingEmptyJob) lines.push('CI job semctx-working-empty')
  if (facts.activeContracts > 0) lines.push(`${facts.activeContracts} orphan contracts`)
  if (!facts.hasAssertledger) {
    lines.push(facts.vitest ? 'assertledger + vitest adapter' : 'assertledger')
  }
  if (!facts.hasCcc && !facts.cccConsent) lines.push('ccc proposed')
  if (!facts.hasCodegraph && !facts.codegraphConsent) lines.push('codegraph proposed')
  if (facts.mergeOnGreen) {
    lines.push(`landing = merge-on-green with ${facts.checks.join(' + ')}`)
  }
  if (!facts.hasWorktree) lines.push('worktree block')
  if (!facts.hasPostMerge) lines.push('release.post_merge asked')
  if (!facts.hasReleaseModel) lines.push('release.model asked')
  return lines
}

function jobName(text: string): string | null {
  const match = text.match(/^ {2}trufflehog:\n {4}name: TruffleHog/m) ?? text.match(/^ {4}name: TruffleHog/m)
  return match ? 'TruffleHog' : null
}

export function readFacts(dir: string, labels: string[] = []): Facts {
  const stackPath = join(dir, '.dev', 'stack.yml')
  const stack = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : ''
  const mergePath = join(dir, '.github', 'workflows', 'merge-on-green.yml')
  const merge = existsSync(mergePath) ? readFileSync(mergePath, 'utf8') : ''
  const secretPath = join(dir, '.github', 'workflows', 'secret-scan.yml')
  const secret = existsSync(secretPath) ? readFileSync(secretPath, 'utf8') : ''
  const ciPath = join(dir, '.github', 'workflows', 'ci.yml')
  const ci = existsSync(ciPath) ? readFileSync(ciPath, 'utf8') : ''
  const lefthook = existsSync(join(dir, 'lefthook.yml')) ? readFileSync(join(dir, 'lefthook.yml'), 'utf8') : ''
  const pkg = existsSync(join(dir, 'package.json')) ? readFileSync(join(dir, 'package.json'), 'utf8') : ''
  const checks: string[] = []
  if (merge) {
    if (/\^ci\$|\bname: ci\b|workflows: \[CI|Lint & Test/.test(merge)) checks.push('ci')
    if (/Secret scan/.test(merge)) checks.push(jobName(secret) ?? 'Secret scan')
    if (/semctx-working-empty/.test(merge) && /hasWorking|working=/.test(merge)) checks.push('semctx-working-empty')
  }
  let active = 0
  const walk = (root: string) => {
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) {
      const path = join(root, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.json') && readFileSync(path, 'utf8').includes('"active"')) active += 1
    }
  }
  walk(join(dir, '.semctx', 'working'))
  return {
    hasTracker: existsSync(join(dir, 'docs', 'agents', 'issue-tracker.md')),
    labels,
    hasSemctx: existsSync(join(dir, '.semctx')),
    hasSemctxHooks: /semctx verify/.test(lefthook),
    hasWorkingEmptyJob: /semctx-working-empty/.test(ci),
    activeContracts: active,
    hasAssertledger: /assertledger/.test(pkg),
    vitest: /vitest/.test(pkg),
    hasCcc: existsSync(join(dir, '.cocoindex_code')),
    hasCodegraph: existsSync(join(dir, '.codegraph')),
    mergeOnGreen: Boolean(merge),
    checks,
    hasWorktree: /^worktree:/m.test(stack),
    hasPostMerge: /post_merge/.test(stack),
    hasReleaseModel: /^ {2}model:/m.test(stack),
    cccConsent: /ccc:\s*true/.test(stack),
    codegraphConsent: /codegraph:\s*true/.test(stack),
  }
}

function isPrincipal(dir: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  const first = out.match(/^worktree (.+)$/m)?.[1]
  if (!first) return true
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim()
  return here === first
}

function applyStack(dir: string, facts: Facts): void {
  const stackPath = join(dir, '.dev', 'stack.yml')
  let stack = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : 'schema_version: "1.0"\n'
  if (!facts.hasWorktree) {
    stack += '\nworktree:\n  copy: []\n  seed: []\n  setup: ""\n'
  }
  if (facts.mergeOnGreen && !/^landing:/m.test(stack)) {
    stack += `\nlanding:\n  mode: merge-on-green\n  required_checks: [${facts.checks.join(', ')}]\n`
  }
  writeFileSync(stackPath, stack)
  const gitDirRaw = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' }).trim()
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw)
  writeFileSync(join(gitDir, 'omp-build-feature-init'), new Date().toISOString())
}

if (import.meta.main) {
  const dir = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : process.cwd()
  const dry = process.argv.includes('--dry-run')
  if (!dry && isPrincipal(dir)) {
    console.error('init=refused principal')
    process.exit(2)
  }
  const gitDirRaw = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' }).trim()
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw)
  if (!dry && existsSync(join(gitDir, 'omp-build-feature-init'))) {
    console.log('init=noop')
    process.exit(0)
  }
  let labels: string[] = []
  if (process.env.FEATURE_INIT_LABELS) labels = process.env.FEATURE_INIT_LABELS.split(',').filter(Boolean)
  const facts = readFacts(dir, labels)
  const lines = plan(facts)
  if (dry) {
    for (const line of lines) console.log(line)
    process.exit(0)
  }
  try {
    execFileSync('bun', ['skill://issue-triage/triage.ts', 'init'], { cwd: dir, stdio: 'ignore' })
  } catch {
    // The plan names the tracker step. A missing CLI must not write issues by hand.
  }
  applyStack(dir, facts)
  console.log('init=done')
  for (const line of lines) console.log(line)
}
