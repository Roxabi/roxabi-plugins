/**
 * Shared types, helpers, and render utilities for the doctor health check.
 */

import { readFileSync } from 'node:fs'
import { parseStackYml } from '../../hooks/lib/parse-stack-yml.cjs'

// --- Types ---

export type Status = 'pass' | 'fail' | 'warn' | 'skip'

export interface Check {
  name: string
  status: Status
  detail: string
}

export interface Section {
  name: string
  checks: Check[]
}

// --- Helpers ---

export function spawnSync(cmd: string[]): { stdout: string; ok: boolean } {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return { stdout: new TextDecoder().decode(proc.stdout).trim(), ok: proc.exitCode === 0 }
  } catch {
    return { stdout: '', ok: false }
  }
}

/** Read .claude/dev-core.yml and return a map of YAML keys to values (uppercase keys for compat). */
export function readDevCoreYml(): Record<string, string> {
  try {
    const text = readFileSync('.claude/dev-core.yml', 'utf8') as string
    const config: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^(\w+):\s*['"]?(.+?)['"]?\s*$/)
      if (match) {
        const [, key, value] = match
        // Store under both YAML key and uppercase env-style key for lookup compat
        config[key] = value
        config[key.toUpperCase()] = value
      }
    }
    return config
  } catch {
    return {}
  }
}

export function readEnvFile(): Record<string, string> {
  try {
    const text = readFileSync('.env', 'utf8') as string
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
  } catch {
    return {}
  }
}

/** Read config with 3-tier fallback: dev-core.yml → .env → empty. */
export function readConfig(): Record<string, string> {
  const yml = readDevCoreYml()
  const env = readEnvFile()
  // dev-core.yml takes precedence, env fills gaps
  return { ...env, ...yml }
}

export interface StackInfo {
  hasDeployPlatform: boolean
  hasFrontend: boolean
  deployPlatform: string | null
  runtime: string | null
  hasLint: boolean
  hasTypecheck: boolean
  e2e: string | null
  mergeStrategy: 'auto-merge' | 'merge-on-green' | null
  /** σ.commands.test */
  test: string | null
  /** σ.testing.unit */
  unit: string | null
  /** σ.release — Model B (#371). null when no `release:` block. `model` is
   * defaulted to 'staging-train' here, so an absent key never reads as trunk. */
  release: { model: string; component: string | null } | null
}

export function readStackYml(): StackInfo {
  try {
    const text = readFileSync('.claude/stack.yml', 'utf8') as string
    const stack = parseStackYml(text)
    const merge = stack.ciMerge === 'merge-on-green' || stack.ciMerge === 'auto-merge' ? stack.ciMerge : null
    return {
      hasDeployPlatform: stack.platform !== null,
      hasFrontend: stack.frontend !== null,
      deployPlatform: stack.platform,
      runtime: stack.runtime,
      hasLint: Boolean(stack.commands.lint),
      hasTypecheck: Boolean(stack.commands.typecheck),
      e2e: stack.testingE2e,
      mergeStrategy: merge,
      test: stack.commands.test,
      unit: stack.testingUnit ?? null,
      release: stack.release
        ? { model: stack.release.model ?? 'staging-train', component: stack.release.component }
        : null,
    }
  } catch {
    return {
      hasDeployPlatform: true,
      hasFrontend: true,
      deployPlatform: null,
      runtime: null,
      hasLint: false,
      hasTypecheck: false,
      e2e: null,
      mergeStrategy: null,
      test: null,
      unit: null,
      release: null,
    }
  }
}

// --- Output formatting ---

export const ICONS: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭' }

export function formatText(sections: Section[]): string {
  const lines: string[] = ['dev-core doctor', '================', '']

  for (const section of sections) {
    lines.push(`  ${section.name}`)
    for (const check of section.checks) {
      lines.push(`    ${check.name.padEnd(20)} ${ICONS[check.status]} ${check.detail}`)
    }
    lines.push('')
  }

  // Verdict
  let total = 0
  let passed = 0
  for (const s of sections) {
    for (const c of s.checks) {
      if (c.status !== 'skip') {
        total++
        if (c.status === 'pass') passed++
      }
    }
  }

  const hasWarn = sections.some((s) => s.checks.some((c) => c.status === 'warn'))
  const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
  if (!hasFail && !hasWarn) {
    lines.push(`  Verdict: All ${total} checks passed. dev-core is fully configured.`)
  } else if (!hasFail) {
    lines.push(`  Verdict: ${passed}/${total} checks passed (${total - passed} warnings). dev-core is operational.`)
  } else {
    lines.push(`  Verdict: ${passed}/${total} checks passed. Run \`/init\` to fix missing items.`)
  }

  return lines.join('\n')
}
