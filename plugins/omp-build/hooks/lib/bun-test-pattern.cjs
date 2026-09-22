'use strict'

/**
 * bun-test guard table — shared by Claude PreToolUse (bun-test-guard.cjs)
 * and OMP guards.ts / index.ts via createRequire. Defined once.
 *
 * Block bare `bun test` (Bun runner); allow `bun run test` (Vitest).
 */

const BUN_TEST_RE = /(^|\s|&&|;|\|)bun test(\s|$)/
const BUN_RUN_TEST_RE = /bun run test/
const BUN_TEST_DENY_REASON = 'Use bun run test (Vitest), not bun test (Bun runner)'

/**
 * @param {string} command
 * @returns {boolean}
 */
function isBunTestBlocked(command) {
  if (!command || typeof command !== 'string') return false
  return BUN_TEST_RE.test(command) && !BUN_RUN_TEST_RE.test(command)
}

module.exports = {
  BUN_TEST_RE,
  BUN_RUN_TEST_RE,
  BUN_TEST_DENY_REASON,
  isBunTestBlocked,
}
