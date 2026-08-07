#!/usr/bin/env node

/**
 * Principal freeze — PreToolUse (soft UX nudge).
 *
 * High-traffic argv patterns only. Not a shell interpreter.
 * Hard invariant lives in principal-branch-post.cjs (state check).
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
 * Extract a plausible branch target from a high-traffic git form.
 * Returns null if not a priced pre-deny form, or { target } to check.
 * @param {string} cmd
 * @returns {{ target: string }|null}
 */
function matchHighTrafficBranchMove(cmd) {
  if (!cmd || typeof cmd !== 'string') return null
  if (!/\bgit\b/.test(cmd)) return null

  // Intentionally shallow: post-tool state assert covers scripts/node/aliases.
  // Skip pure path restore
  if (/\bgit\s+checkout\s+--\s/.test(cmd) && !/\b(switch|branch\s+-[mM]|stash\s+branch)\b/.test(cmd)) {
    return null
  }

  // git switch … <target>
  let m = cmd.match(
    /\bgit\b(?:\s+(?:-[^\s"']+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+switch\s+((?:(?:-[cC]|--create(?:=\S+)?|--force-create|--detach|-d|-t|--track|-f|--force|-q|--quiet|--guess|--no-guess)\s+)*)([^\s;&|"']+)/,
  )
  if (m) {
    const target = m[2]
    if (target === '-' || target === '@{-1}') return { target }
    if (target === 'HEAD' && /--detach|-d/.test(m[1] || '')) return { target: 'HEAD' }
    return { target }
  }

  // git checkout -b|-B <branch>
  m = cmd.match(/\bgit\b(?:\s+\S+)*\s+checkout\s+(?:-[bB]\s+)([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git checkout <branch> (not --, not . / .., not path-like file.ext)
  m = cmd.match(
    /\bgit\b(?:\s+\S+)*\s+checkout\s+(?!-)([^\s;&|"']+)(?!\s+--)/,
  )
  if (m) {
    const t = m[1]
    if (t === '.' || t === '..') return null
    // path restore without --: e.g. file.ts — leave to post if needed
    if (/\.[a-zA-Z0-9]{1,8}$/.test(t) && !t.startsWith('feat/')) return null
    return { target: t }
  }

  // git branch -m|-M [old] <new>
  m = cmd.match(/\bgit\b(?:\s+\S+)*\s+branch\s+(?:-[mM]|--move)\s+(?:[^\s]+\s+)?([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git stash branch <name>
  m = cmd.match(/\bgit\b(?:\s+\S+)*\s+stash\s+branch\s+([^\s;&|"']+)/)
  if (m) return { target: m[1] }

  // git symbolic-ref HEAD <ref>
  m = cmd.match(/\bgit\b(?:\s+\S+)*\s+symbolic-ref\s+(?:-q\s+)?HEAD\s+([^\s;&|"']+)/)
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

if (require.main === module) {
  main()
}
