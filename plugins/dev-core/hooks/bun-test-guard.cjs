#!/usr/bin/env node

/**
 * Block bare `bun test` (Bun runner) — require `bun run test` (Vitest).
 * Dual harness: stdin toolInput.command (Grok) ∪ CLAUDE_TOOL_INPUT (Claude).
 */

const { loadHookInput, extractShellCommand } = require('./lib/hook-input.cjs')

function main() {
  const { toolInput } = loadHookInput()
  const cmd = extractShellCommand(toolInput)
  if (!cmd) process.exit(0)

  const hasBunTest = /(^|\s|&&|;|\|)bun test(\s|$)/.test(cmd)
  const hasBunRunTest = /bun run test/.test(cmd)

  if (hasBunTest && !hasBunRunTest) {
    const reason = 'Use bun run test (Vitest), not bun test (Bun runner)'
    // Grok: decision deny; exit 2 also blocks on both hosts
    process.stdout.write(
      JSON.stringify({ decision: 'deny', reason, message: reason }) + '\n',
    )
    process.stderr.write(reason + '\n')
    process.exit(2)
  }

  process.exit(0)
}

main()
