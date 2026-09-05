import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const principalPre = require('../hooks/principal-branch-pre.cjs') as {
  shouldDenyPre: (cmd: string, cwd: string, deps?: { isPrincipalCwd?: (cwd: string) => boolean }) => boolean
}

const principalFreeze = require('../hooks/lib/principal-freeze.cjs') as {
  hasEscapeHatch: (env?: NodeJS.ProcessEnv) => boolean
  isPrincipalCwd: (cwd: string) => boolean
  principalHead: (
    cwd?: string,
  ) => { status: 'ok'; principal: string; branch: string } | { status: 'not_git' } | { status: 'probe_error' }
  isBaseBranch: (name: string | null | undefined) => boolean
}

const { SECURITY_PATTERNS } = require('../hooks/lib/security-patterns.cjs') as {
  SECURITY_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }>
}

const bunTestPattern = require('../hooks/lib/bun-test-pattern.cjs') as {
  isBunTestBlocked: (command: string) => boolean
  BUN_TEST_DENY_REASON: string
}

export { SECURITY_PATTERNS }
export const { isBunTestBlocked, BUN_TEST_DENY_REASON } = bunTestPattern

/** Max content bytes scanned by the OMP security hook (fail-open above this). */
export const SECURITY_SCAN_MAX_BYTES = 256_000

/** Host-neutral project contract. `.claude/stack.yml` is not a contract. */
export const PROJECT_CONTRACT_FILES = ['stack.yml', '.omp/stack.yml', 'dev-core.yml', '.omp/dev-core.yml'] as const

export function hasProjectContract(cwd: string, exists: (path: string) => boolean = existsSync): boolean {
  return PROJECT_CONTRACT_FILES.some((rel) => exists(join(cwd, rel)))
}

export function shouldBlockPrincipalSwitch(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  deps?: { isPrincipalCwd?: (cwd: string) => boolean },
): boolean {
  if (principalFreeze.hasEscapeHatch(env)) return false
  return principalPre.shouldDenyPre(command, cwd, deps)
}

export function extractWriteContent(input: Record<string, unknown>): string {
  const content = input.content ?? input.new_string ?? input.newString ?? input.new_str ?? input.input ?? ''
  return typeof content === 'string' ? content : ''
}

export function extractShellCommand(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd ?? ''
  return typeof command === 'string' ? command : ''
}

export function scanSecurityContent(content: string): string | null {
  if (!content) return null
  if (Buffer.byteLength(content, 'utf8') > SECURITY_SCAN_MAX_BYTES) return null

  for (const rule of SECURITY_PATTERNS) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(content)) {
      return rule.message
    }
    rule.pattern.lastIndex = 0
  }

  return null
}

/** Dump-time only: expand leftover $CLAUDE_* while registerCommand still injects SKILL.md. */
export function rewriteHarnessPaths(body: string, skillDir: string, pluginRoot: string): string {
  return body
    .replaceAll('${CLAUDE_SKILL_DIR}', skillDir)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('$CLAUDE_SKILL_DIR', skillDir)
    .replaceAll('$CLAUDE_PLUGIN_ROOT', pluginRoot)
}

export { principalFreeze }
