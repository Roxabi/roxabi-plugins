#!/usr/bin/env node

/**
 * Principal freeze — PostToolUse state detect + restore nudge.
 *
 * Measures invariant I: principal HEAD ∈ {staging, main, master}.
 * Runs after Bash / run_terminal_command regardless of how git was invoked
 * (scripts, node -e, aliases, etc.).
 *
 * Not an OS-level hard stop: exit 2 + message so the agent is nudged to restore.
 * Escape: DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1 (session env).
 */

'use strict'

const {
  hasEscapeHatch,
  isBaseBranch,
  principalHead,
  normalizeHeadResult,
  DENY_REASON_POST,
  DENY_REASON_PROBE,
  emitPostAssert,
} = require('./lib/principal-freeze.cjs')

/**
 * @param {string} [cwd]
 * @param {{ principalHead?: Function }} [deps]
 * @returns {{ ok: boolean, branch?: string, principal?: string, reason?: string, status?: string }}
 */
function assertPrincipalOnBase(cwd = process.cwd(), deps = {}) {
  const headFn = deps.principalHead || principalHead
  const info = normalizeHeadResult(headFn(cwd))

  if (info.status === 'not_git') {
    return { ok: true, status: 'not_git' }
  }

  if (info.status === 'probe_error') {
    return {
      ok: false,
      status: 'probe_error',
      reason: DENY_REASON_PROBE,
    }
  }

  // status === 'ok'
  if (isBaseBranch(info.branch)) {
    return {
      ok: true,
      status: 'ok',
      branch: info.branch,
      principal: info.principal,
    }
  }

  const reason =
    DENY_REASON_POST + ` Currently: ${info.branch} @ ${info.principal}`
  return {
    ok: false,
    status: 'off_base',
    branch: info.branch,
    principal: info.principal,
    reason,
  }
}

function main() {
  if (hasEscapeHatch()) process.exit(0)

  const result = assertPrincipalOnBase(process.cwd())
  if (!result.ok) {
    emitPostAssert(result.reason || DENY_REASON_POST)
  }

  process.exit(0)
}

module.exports = {
  assertPrincipalOnBase,
  main,
}

if (require.main === module) {
  main()
}
