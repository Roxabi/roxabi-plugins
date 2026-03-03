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
 *   bun init.ts workflows --owner <owner> --repo <repo> --stack <bun|node|python> --test <vitest|jest|pytest|none> --deploy <vercel|none> [--branch <branch>]
 *   bun init.ts push-workflows --owner <owner> --repo <repo> [--branch <branch>]  # generic only (auto-merge + pr-title)
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
    const rawType = parseFlag('--type', 'technical')
    if (rawType !== 'technical' && rawType !== 'company') {
      console.error(`[init] Invalid --type value: '${rawType}'. Must be 'technical' or 'company'.`)
      process.exit(1)
    }
    const type: import('../shared/workspace').ProjectType = rawType
    if (!owner || !repo) {
      console.error('Usage: init.ts create-project --owner <owner> --repo <repo> [--type technical|company]')
      process.exit(1)
    }
    const result = await createProject(owner, repo, type)
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
    const { pushWorkflows, writeWorkflows } = await import('./lib/workflows')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    const branch = parseFlag('--branch', 'main')
    const stack = parseFlag('--stack', 'bun') as 'bun' | 'node' | 'python'
    const test = parseFlag('--test', 'vitest') as 'vitest' | 'jest' | 'pytest' | 'none'
    const deploy = parseFlag('--deploy', 'none') as 'vercel' | 'none'
    if (owner && repo) {
      const result = await pushWorkflows(owner, repo, { stack, test, deploy }, branch)
      console.log(JSON.stringify({ pushed: result }, null, 2))
    } else {
      // fallback: local write (no owner/repo provided)
      const result = await writeWorkflows({ stack, test, deploy })
      console.log(JSON.stringify({ written: result }, null, 2))
    }
    break
  }

  case 'push-workflows': {
    const { pushGenericWorkflows } = await import('./lib/workflows')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    const branch = parseFlag('--branch', 'main')
    if (!owner || !repo) {
      console.error('Usage: init.ts push-workflows --owner <owner> --repo <repo> [--branch <branch>]')
      process.exit(1)
    }
    const result = await pushGenericWorkflows(owner, repo, branch)
    console.log(JSON.stringify({ pushed: result }, null, 2))
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

  case 'list-workflows': {
    const { listProjectWorkflows } = await import('./lib/project')
    const projectId = parseFlag('--project-id', '')
    if (!projectId) {
      console.error('Usage: init.ts list-workflows --project-id <PVT_...>')
      process.exit(1)
    }
    const result = await listProjectWorkflows(projectId)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'enable-workflow': {
    const { enableProjectWorkflow } = await import('./lib/project')
    const workflowId = parseFlag('--workflow-id', '')
    if (!workflowId) {
      console.error('Usage: init.ts enable-workflow --workflow-id <PWF_...>')
      process.exit(1)
    }
    const result = await enableProjectWorkflow(workflowId)
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
      force: hasFlag('--force'),
    })
    console.log(JSON.stringify(result, null, 2))
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    console.error(
      'Usage: init.ts [prereqs|discover|create-project|migrate-issues|labels|workflows|push-workflows|protect-branches|list-workflows|enable-workflow|scaffold]',
    )
    process.exit(1)
}
