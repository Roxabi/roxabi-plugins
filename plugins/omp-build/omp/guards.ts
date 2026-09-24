/**
 * Guard chain for the omp-build OMP extension.
 *
 * Frozen snapshot (ADR-020, #489): omp-build carries its own guards and its own
 * `hooks/` libs so the safety net survives uninstalling any sibling plugin. No
 * runtime path ever leaves this plugin root. The snapshot is not resynced —
 * divergence from the original is expected and allowed.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import type * as ContractPaths from '../hooks/lib/contract-paths.cjs'

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

const contractPaths = require('../hooks/lib/contract-paths.cjs') as typeof ContractPaths

export { SECURITY_PATTERNS }
export const { isBunTestBlocked, BUN_TEST_DENY_REASON } = bunTestPattern

/** Max content bytes scanned by the OMP security hook (fail-open above this). */
export const SECURITY_SCAN_MAX_BYTES = 256_000

/**
 * Host-neutral project contract: `.dev/` is read identically by every harness.
 * `.claude/stack.yml` is not a contract — `.claude/` holds host state only.
 */
export const PROJECT_CONTRACT_FILES = contractPaths.PROJECT_CONTRACT_FILES

/** Walk to the git top-level using the same exists probe — no process spawn. */
export function gitTopLevel(cwd: string, exists: (path: string) => boolean = existsSync): string | null {
  let dir = resolve(cwd)
  const root = parse(dir).root
  for (;;) {
    if (exists(join(dir, '.git'))) return dir
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function hasProjectContract(cwd: string, exists: (path: string) => boolean = existsSync): boolean {
  const top = gitTopLevel(cwd, exists)
  const roots = top && top !== resolve(cwd) ? [top, cwd] : [cwd]
  return roots.some((dir) => PROJECT_CONTRACT_FILES.some((rel) => exists(join(dir, rel))))
}

export const PRINCIPAL_FREEZE_REASON =
  'Principal freeze (pre): do not move principal off staging|main|master. Feature work → `/feature #N` in an agent-created worktree.'

const EVAL_SWITCH = /\bgit\s+(?:switch|checkout)\b/

export function extractEvalCode(input: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof input.code === 'string') parts.push(input.code)
  if (Array.isArray(input.cells)) {
    for (const cell of input.cells) {
      if (cell && typeof cell === 'object' && 'code' in cell && typeof cell.code === 'string') parts.push(cell.code)
    }
  }
  return parts.join('\n')
}

export function evalGuard(
  input: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  deps?: { isPrincipalCwd?: (cwd: string) => boolean },
): { block: true; reason: string } | null {
  const code = extractEvalCode(input)
  if (!code) return null
  if (!principalFreeze.hasEscapeHatch(env) && EVAL_SWITCH.test(code)) {
    const principal = deps?.isPrincipalCwd ?? principalFreeze.isPrincipalCwd
    if (principal(cwd)) return { block: true, reason: PRINCIPAL_FREEZE_REASON }
  }
  const violation = scanSecurityContent(code)
  if (violation) return { block: true, reason: `Security check: ${violation}` }
  return null
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

export { principalFreeze }
