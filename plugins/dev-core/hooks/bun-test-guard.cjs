#!/usr/bin/env node

/**
 * Block bare `bun test` (Bun runner) — require `bun run test` (Vitest).
 * Dual harness: stdin toolInput.command (Grok) ∪ CLAUDE_TOOL_INPUT (Claude).
 */

const { loadHookInput, extractShellCommand } = require('./lib/hook-input.cjs')
const { emitDeny } = require('./lib/principal-freeze.cjs')
const { isBunTestBlocked, BUN_TEST_DENY_REASON } = require('./lib/bun-test-pattern.cjs')

function main() {
  const { toolInput } = loadHookInput()
  const cmd = extractShellCommand(toolInput)
  if (!cmd) process.exit(0)

  if (isBunTestBlocked(cmd)) {
    emitDeny(BUN_TEST_DENY_REASON)
  }

  process.exit(0)
}

main()
