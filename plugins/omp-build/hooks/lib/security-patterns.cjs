'use strict'

/**
 * Security scan table — shared by Claude PreToolUse (security-check.cjs)
 * and OMP guards.ts via createRequire. Defined once.
 *
 * Host-specific policy stays in the caller:
 * - Claude: daily debounce under .claude/security_warnings
 * - OMP: 256k fail-open + hashline extract
 */

const SECURITY_PATTERNS = [
  {
    id: 'hardcoded-secret',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    message: 'BLOCKED: Potential hardcoded secret detected',
  },
  {
    id: 'sql-injection',
    pattern: /`SELECT.*\$\{|`INSERT.*\$\{|`UPDATE.*\$\{|`DELETE.*\$\{/gi,
    message: 'BLOCKED: Potential SQL injection via template literal interpolation',
  },
  {
    id: 'command-injection',
    pattern: /exec\s*\(\s*`|spawn\s*\(\s*`|execSync\s*\(\s*`/gi,
    message: 'BLOCKED: Potential command injection via template literal',
  },
]

module.exports = {
  SECURITY_PATTERNS,
}
