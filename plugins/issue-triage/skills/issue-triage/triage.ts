#!/usr/bin/env bun
/**
 * Issue triage CLI — router that delegates to command modules.
 * Replaces triage.sh.
 *
 * Usage:
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts [list] [--json] [--untriaged]
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <number> [--size S] [--priority P] [--lane L] [--blocked-by N] [--parent N] [--child N] ...
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create (--title "Title" | --title-file <path>) [--body "Body" | --body-file <path>] ...
 *   bun skill://issue-triage/triage.ts init [--dry-run] [--repo owner/repo]
 * Default with no args (or flags-only) is list.
 */

const args = process.argv.slice(2)
let command = args[0]
let rest = args.slice(1)
if (!command || command.startsWith('--')) {
  command = 'list'
  rest = args
}

switch (command) {
  case 'list': {
    const { listIssues } = await import('./lib/list')
    await listIssues(rest)
    break
  }
  case 'set': {
    const { setIssue } = await import('./lib/set')
    await setIssue(rest)
    break
  }
  case 'create': {
    const { createIssue } = await import('./lib/create')
    await createIssue(rest)
    break
  }
  case 'init': {
    const { initIssues } = await import('./lib/init')
    await initIssues(rest)
    break
  }
  default:
    console.error('Usage: triage.ts [list|set|create|init] ...')
    process.exit(1)
}
