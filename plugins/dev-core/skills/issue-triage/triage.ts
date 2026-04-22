#!/usr/bin/env bun
/**
 * Issue triage CLI — router that delegates to command modules.
 * Replaces triage.sh.
 *
 * Usage:
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts [list] [--json]
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <number> [--size S] [--priority P] ...
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create --title "Title" [--body "Body"] ...
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts migrate audit-schema
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts migrate backfill --repo OWNER/REPO [--dry-run] [--snapshot <path>]
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts migrate rewrite-titles --repo OWNER/REPO [--dry-run] [--snapshot <path>]
 *   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts migrate revert --snapshot <path>
 */

const args = process.argv.slice(2)
const command = args[0] ?? 'list'
const rest = args.slice(1)

function parseMigrateBackfillArgs(argv: string[]): { repo: string; dryRun: boolean; snapshotPath?: string } {
  let repo: string | undefined
  let dryRun = false
  let snapshotPath: string | undefined
  let i = 0

  while (i < argv.length) {
    const flag = argv[i]
    if (flag === '--repo') {
      repo = argv[i + 1]
      if (!repo) {
        console.error('Error: --repo requires a value (OWNER/REPO)')
        process.exit(1)
      }
      i += 2
    } else if (flag === '--dry-run') {
      dryRun = true
      i += 1
    } else if (flag === '--snapshot') {
      snapshotPath = argv[i + 1]
      if (!snapshotPath) {
        console.error('Error: --snapshot requires a path value')
        process.exit(1)
      }
      i += 2
    } else {
      console.error(`Error: unknown flag "${flag}"`)
      console.error('Usage: triage.ts migrate backfill --repo OWNER/REPO [--dry-run] [--snapshot <path>]')
      process.exit(1)
    }
  }

  if (!repo) {
    console.error('Error: --repo OWNER/REPO is required')
    console.error('Usage: triage.ts migrate backfill --repo OWNER/REPO [--dry-run] [--snapshot <path>]')
    process.exit(1)
  }

  // fix #9: validate --repo format
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error('Error: --repo must be OWNER/REPO format')
    process.exit(1)
  }

  return { repo, dryRun, snapshotPath }
}

function parseMigrateRevertArgs(argv: string[]): { snapshotPath: string } {
  let snapshotPath: string | undefined
  let i = 0

  while (i < argv.length) {
    const flag = argv[i]
    if (flag === '--snapshot') {
      snapshotPath = argv[i + 1]
      if (!snapshotPath) {
        console.error('Error: --snapshot requires a path value')
        console.error('Usage: triage.ts migrate revert --snapshot <path>')
        process.exit(1)
      }
      i += 2
    } else {
      console.error(`Error: unknown flag "${flag}"`)
      console.error('Usage: triage.ts migrate revert --snapshot <path>')
      process.exit(1)
    }
  }

  if (!snapshotPath) {
    console.error('Error: --snapshot <path> is required')
    console.error('Usage: triage.ts migrate revert --snapshot <path>')
    process.exit(1)
  }

  return { snapshotPath }
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
  case 'migrate': {
    const sub = rest[0]
    const subArgs = rest.slice(1)
    switch (sub) {
      case 'audit-schema': {
        const { auditSchema } = await import('./lib/migrate')
        await auditSchema()
        break
      }
      case 'backfill': {
        const { backfill, validateSnapshotPath } = await import('./lib/migrate')
        const opts = parseMigrateBackfillArgs(subArgs)
        // fix #2: validate user-supplied snapshot path at CLI layer
        if (opts.snapshotPath) opts.snapshotPath = validateSnapshotPath(opts.snapshotPath)
        await backfill(opts)
        break
      }
      case 'rewrite-titles': {
        const { rewriteTitles, validateSnapshotPath } = await import('./lib/migrate')
        const opts = parseMigrateBackfillArgs(subArgs)
        // fix #2: validate user-supplied snapshot path at CLI layer
        if (opts.snapshotPath) opts.snapshotPath = validateSnapshotPath(opts.snapshotPath)
        await rewriteTitles(opts)
        break
      }
      case 'revert': {
        const { revert, validateSnapshotPath } = await import('./lib/migrate')
        const opts = parseMigrateRevertArgs(subArgs)
        // fix #2: validate user-supplied snapshot path at CLI layer
        opts.snapshotPath = validateSnapshotPath(opts.snapshotPath)
        await revert(opts)
        break
      }
      default:
        console.error('Usage: triage.ts migrate <audit-schema|backfill|rewrite-titles|revert> [args]')
        process.exit(1)
    }
    break
  }
  default:
    console.error('Usage: triage.ts [list|set|create|migrate] ...')
    process.exit(1)
}
