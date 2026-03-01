#!/usr/bin/env bun
/**
 * Init CLI — router that delegates to subcommand modules.
 * All subcommands output JSON for the SKILL.md orchestrator to parse.
 *
 * Usage:
 *   bun init.ts prereqs [--json]
 *   bun init.ts discover [--json]
 *   bun init.ts create-project --owner <owner> --repo <repo>
 *   bun init.ts labels --repo <owner/repo> [--scope all|type|area|priority]
 *   bun init.ts workflows --stack <bun|node> --test <vitest|jest|none> --deploy <vercel|none>
 *   bun init.ts protect-branches --repo <owner/repo>
 *   bun init.ts migrate-issues --owner <owner> --repo <repo> --project-number <N>
 *   bun init.ts scaffold --github-repo <owner/repo> --project-id <PVT_...> [--force] ...
 */

const args = process.argv.slice(2)
const command = args[0] ?? 'prereqs'
const rest = args.slice(1)

function parseFlag(flag: string, fallback: string): string {
  const idx = rest.indexOf(flag)
  if (idx === -1 || idx + 1 >= rest.length) return fallback
  return rest[idx + 1]
}

function hasFlag(flag: string): boolean {
  return rest.includes(flag)
}

switch (command) {
  case 'prereqs': {
    const { checkPrereqs } = await import('../shared/prereqs')
    console.log(JSON.stringify(checkPrereqs(), null, 2))
    break
  }

  case 'discover': {
    const { discover } = await import('./lib/discover')
    const result = await discover()
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'create-project': {
    const { createProject } = await import('./lib/project')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    if (!owner || !repo) {
      console.error('Usage: init.ts create-project --owner <owner> --repo <repo>')
      process.exit(1)
    }
    const result = await createProject(owner, repo)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'labels': {
    const { createLabels } = await import('./lib/labels')
    const repo = parseFlag('--repo', '')
    const scope = parseFlag('--scope', 'all') as 'all' | 'type' | 'area' | 'priority'
    if (!repo) {
      console.error('Usage: init.ts labels --repo <owner/repo> [--scope all|type|area|priority]')
      process.exit(1)
    }
    const result = await createLabels(repo, scope)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'workflows': {
    const { writeWorkflows } = await import('./lib/workflows')
    const stack = parseFlag('--stack', 'bun') as 'bun' | 'node'
    const test = parseFlag('--test', 'vitest') as 'vitest' | 'jest' | 'none'
    const deploy = parseFlag('--deploy', 'none') as 'vercel' | 'none'
    const result = await writeWorkflows({ stack, test, deploy })
    console.log(JSON.stringify({ written: result }, null, 2))
    break
  }

  case 'protect-branches': {
    const { protectBranches } = await import('./lib/protection')
    const repo = parseFlag('--repo', '')
    if (!repo) {
      console.error('Usage: init.ts protect-branches --repo <owner/repo>')
      process.exit(1)
    }
    const result = await protectBranches(repo)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'migrate-issues': {
    const { migrateIssues } = await import('./lib/migrate')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    const projectNumber = parseInt(parseFlag('--project-number', '0'), 10)
    if (!owner || !repo || !projectNumber) {
      console.error('Usage: init.ts migrate-issues --owner <owner> --repo <repo> --project-number <N>')
      process.exit(1)
    }
    const result = await migrateIssues(owner, repo, projectNumber)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'scaffold': {
    const { scaffold } = await import('./lib/scaffold')
    const result = await scaffold({
      githubRepo: parseFlag('--github-repo', ''),
      projectId: parseFlag('--project-id', ''),
      statusFieldId: parseFlag('--status-field-id', ''),
      sizeFieldId: parseFlag('--size-field-id', ''),
      priorityFieldId: parseFlag('--priority-field-id', ''),
      statusOptionsJson: parseFlag('--status-options-json', '{}'),
      sizeOptionsJson: parseFlag('--size-options-json', '{}'),
      priorityOptionsJson: parseFlag('--priority-options-json', '{}'),
      vercelToken: parseFlag('--vercel-token', ''),
      vercelProjectId: parseFlag('--vercel-project-id', ''),
      vercelTeamId: parseFlag('--vercel-team-id', ''),
      dashboardPath: parseFlag('--dashboard-path', ''),
      force: hasFlag('--force'),
    })
    console.log(JSON.stringify(result, null, 2))
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    console.error('Usage: init.ts [prereqs|discover|create-project|migrate-issues|labels|workflows|protect-branches|scaffold]')
    process.exit(1)
}
