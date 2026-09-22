#!/usr/bin/env node

/**
 * Principal freeze — PreToolUse (soft UX nudge).
 *
 * High-traffic argv patterns only. Not a shell interpreter.
 * PostToolUse (principal-branch-post) re-checks principal HEAD after shell tools
 * and nudges restore — agent discipline, not an OS hard stop (see ADR-017).
 *
 * Escape: DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1 (session env).
 */

'use strict'

const { loadHookInput, extractShellCommand } = require('./lib/hook-input.cjs')
const {
  isBaseBranch,
  hasEscapeHatch,
  isPrincipalCwd,
  DENY_REASON_PRE,
  emitDeny,
} = require('./lib/principal-freeze.cjs')

/**
 * Blank out quoted spans, then cut the command into segments.
 *
 * Two different things used to be confused with argv. Prose lives inside quotes
 * — a commit message or an issue body may discuss a branch move without asking
 * for one. And a later command lives after a separator, so a pattern allowed to
 * bridge arbitrary text could read a verb from one command and a target from
 * another. Masking runs first: a quoted span becomes blanks, so its content can
 * never look like argv, and the separators inside it never cut a segment.
 *
 * Quoted targets (`git switch "my branch"`) were never priced here — the target
 * character class has always excluded quotes — so masking loses no coverage.
 * Unquoted heredoc bodies stay a known gap, as before: the post-tool state
 * assert is what covers anything this shallow pass cannot price.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function commandSegments(cmd) {
  let masked = ''
  let quote = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      masked += ' '
    } else if (ch === '"' || ch === "'") {
      quote = ch
      masked += ' '
    } else {
      masked += ch
    }
  }
  return masked
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Leading env assignments, `env …`, `git`, then git's own global flags. */
const GIT_INVOCATION =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)?git(?:\s+(?:-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+|--exec-path=\S+|--no-pager|--paginate|-p|--literal-pathspecs|--no-replace-objects))*\s+(.+)$/

/**
 * The subcommand and its arguments, or null when the segment does not invoke git.
 * @param {string} segment
 * @returns {string|null}
 */
function gitArgs(segment) {
  const m = segment.match(GIT_INVOCATION)
  return m ? m[1] : null
}

/**
 * A quoted span handed to a shell runner (`bash -c '…'`) is a command, not data.
 * Everything else in quotes is data.
 */
const SHELL_RUNNER = /\b(?:ba|z|k|da|a)?sh\s+-[A-Za-z]*c\s+(?:'([^']*)'|"([^"]*)")/g

/**
 * Price every git invocation in a command string.
 * @param {string} cmd
 * @returns {{ target: string }|null}
 */
function scanSegments(cmd) {
  for (const segment of commandSegments(cmd)) {
    const args = gitArgs(segment)
    if (!args) continue
    const hit = matchGitArgs(args)
    if (hit) return hit
  }
  return null
}

/**
 * Extract a plausible branch target from a high-traffic git form.
 * Returns null if not a priced pre-deny form, or { target } to check.
 * @param {string} cmd
 * @returns {{ target: string }|null}
 */
function matchHighTrafficBranchMove(cmd) {
  if (!cmd || typeof cmd !== 'string') return null
  if (!/\bgit\b/.test(cmd)) return null

  for (const m of cmd.matchAll(SHELL_RUNNER)) {
    const payload = m[1] ?? m[2]
    if (!payload) continue
    const hit = scanSegments(payload)
    if (hit) return hit
  }

  return scanSegments(cmd)
}

/**
 * Price one git invocation's arguments.
 *
 * Intentionally shallow: the post-tool state assert covers scripts, node and
 * aliases.
 *
 * @param {string} args
 * @returns {{ target: string }|null}
 */
function matchGitArgs(args) {
  // Pure path restore
  if (/^checkout\s+--\s/.test(args)) return null

  // git switch … <target>
  let m = args.match(
    /^switch\s+((?:(?:-[cC]|--create(?:=\S+)?|--force-create|--detach|-d|-t|--track|-f|--force|-q|--quiet|--guess|--no-guess)\s+)*)([^\s;&|"']+)/,
  )
  if (m) {
    const target = m[2]
    if (target === '-' || target === '@{-1}') return { target }
    if (target === 'HEAD' && /--detach|-d/.test(m[1] || '')) return { target: 'HEAD' }
    return { target }
  }

  // git checkout -b|-B <branch>
  m = args.match(/^checkout\s+(?:-[bB]\s+)([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git checkout <branch> (not --, not . / .., not path-like file.ext)
  m = args.match(/^checkout\s+(?!-)([^\s;&|"']+)(?!\s+--)/)
  if (m) {
    const t = m[1]
    if (t === '.' || t === '..') return null
    // path restore without --: e.g. file.ts — leave to post if needed
    if (/\.[a-zA-Z0-9]{1,8}$/.test(t) && !t.startsWith('feat/')) return null
    return { target: t }
  }

  // git branch -m|-M [old] <new>
  m = args.match(/^branch\s+(?:-[mM]|--move)\s+(?:[^\s]+\s+)?([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git stash branch <name>
  m = args.match(/^stash\s+branch\s+([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git symbolic-ref HEAD <ref>
  m = args.match(/^symbolic-ref\s+(?:-q\s+)?HEAD\s+([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // note: git reset --hard is intentionally NOT pre-priced (branch name may stay β)

  return null
}

/**
 * @param {string} cmd
 * @param {string} cwd
 * @param {{ isPrincipalCwd?: typeof isPrincipalCwd }} [deps]
 * @returns {boolean}
 */
function shouldDenyPre(cmd, cwd, deps = {}) {
  const isPrincipal = deps.isPrincipalCwd || isPrincipalCwd
  if (!isPrincipal(cwd)) return false
  const hit = matchHighTrafficBranchMove(cmd)
  if (!hit) return false
  if (isBaseBranch(hit.target)) return false
  // Detach / previous-branch / non-base → deny on principal
  return true
}

function main() {
  if (hasEscapeHatch()) process.exit(0)

  const { toolInput } = loadHookInput()
  const cmd = extractShellCommand(toolInput)
  if (!cmd) process.exit(0)

  if (shouldDenyPre(cmd, process.cwd())) {
    emitDeny(DENY_REASON_PRE)
  }

  process.exit(0)
}

module.exports = {
  matchHighTrafficBranchMove,
  shouldDenyPre,
  main,
}

// CLI entry point — unreachable in omp-build, which ships no hooks.json and
// never execs this file. Kept so the snapshot loads unmodified; `main()` and
// everything it reaches (hook-input.cjs) exist for that reason alone.
if (require.main === module) {
  main()
}
