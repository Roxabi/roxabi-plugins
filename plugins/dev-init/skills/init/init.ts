#!/usr/bin/env bun
/**
 * Init CLI — router that delegates to subcommand modules.
 * All subcommands output JSON for the SKILL.md orchestrator to parse.
 *
 * Usage:
 *   bun init.ts prereqs [--json]
 *   bun init.ts discover [--json]
 *   bun init.ts workflows --owner <owner> --repo <repo> --stack <bun|node|python> --test <vitest|jest|pytest|none> --deploy <vercel|none> [--branch <branch>] [--force]
 *   bun init.ts push-workflows --owner <owner> --repo <repo> [--branch <branch>] [--force]  # generic only (auto-merge + pr-title + context-lint)
 *   (both default to TOP-UP: existing workflow files are skipped; --force overwrites)
 *   bun init.ts protect-branches --repo <owner/repo>
 *   bun init.ts scaffold-rules [--stack-path .claude/stack.yml] [--project-name <name>] [--claude-md CLAUDE.md]
 *   bun init.ts scaffold --github-repo <owner/repo> [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]
 *   bun init.ts scaffold-fumadocs [--root <path>] [--docs-path <path>]
 *   bun init.ts scaffold-fumadocs-vercel [--root <path>] [--orchestrator <turbo|none>]
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

  case 'workflows': {
    const { pushWorkflows, writeWorkflows } = await import('./lib/workflows')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    const branch = parseFlag('--branch', 'main')
    const stack = parseFlag('--stack', 'bun') as 'bun' | 'node' | 'python'
    const test = parseFlag('--test', 'vitest') as 'vitest' | 'jest' | 'pytest' | 'none'
    const deploy = parseFlag('--deploy', 'none') as 'vercel' | 'none'
    const force = process.argv.includes('--force')
    if (owner && repo) {
      const result = await pushWorkflows(owner, repo, { stack, test, deploy }, branch, force)
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
    const result = await pushGenericWorkflows(owner, repo, branch, process.argv.includes('--force'))
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

  case 'scaffold-docs': {
    const { scaffoldDocs } = await import('./lib/docs')
    const format = parseFlag('--format', 'md') as 'md' | 'mdx'
    const docsPath = parseFlag('--path', 'docs')
    const result = scaffoldDocs({ format, path: docsPath })
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'scaffold-fumadocs': {
    const { scaffoldFumadocs } = await import('./lib/fumadocs')
    const root = parseFlag('--root', process.cwd())
    const docsPath = parseFlag('--docs-path', 'docs')
    const result = await scaffoldFumadocs(root, docsPath)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'scaffold-fumadocs-vercel': {
    const { scaffoldFumadocsVercel } = await import('./lib/fumadocs')
    const root = parseFlag('--root', process.cwd())
    const orchestrator = parseFlag('--orchestrator', 'none')
    const result = scaffoldFumadocsVercel(root, orchestrator)
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'scaffold-rules': {
    const { scaffoldRules } = await import('./lib/scaffold-rules')
    const result = scaffoldRules({
      stackPath: parseFlag('--stack-path', '.claude/stack.yml'),
      projectName: parseFlag('--project-name', ''),
      claudeMdPath: parseFlag('--claude-md', 'CLAUDE.md'),
    })
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'scaffold': {
    const { scaffold } = await import('./lib/scaffold')
    const result = await scaffold({
      githubRepo: parseFlag('--github-repo', ''),
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
      'Usage: init.ts [prereqs|discover|workflows|push-workflows|protect-branches|scaffold-docs|scaffold-rules|scaffold|scaffold-fumadocs|scaffold-fumadocs-vercel]',
    )
    process.exit(1)
}
