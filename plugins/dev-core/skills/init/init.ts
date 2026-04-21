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
 *   bun init.ts scaffold-rules [--stack-path .claude/stack.yml] [--project-name <name>] [--claude-md CLAUDE.md]
 *   bun init.ts scaffold --github-repo <owner/repo> --project-id <PVT_...> [--force] ...
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

  case 'create-project': {
    const { createProject } = await import('./lib/project')
    const owner = parseFlag('--owner', '')
    const repo = parseFlag('--repo', '')
    const rawType = parseFlag('--type', 'technical')
    if (rawType !== 'technical' && rawType !== 'company') {
      console.error(`[init] Invalid --type value: '${rawType}'. Must be 'technical' or 'company'.`)
      process.exit(1)
    }
    const type: import('../shared/ports/workspace').ProjectType = rawType
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
    const scope = parseFlag('--scope', 'all') as 'all' | 'type' | 'area'
    if (!repo) {
      console.error('Usage: init.ts labels --repo <owner/repo> [--scope all|type|area]')
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

  case 'hub-enroll': {
    const { enrollRepo } = await import('./lib/hub-enroll')
    const { readFileSync: readFS } = await import('node:fs')
    const org = parseFlag('--org', 'Roxabi')
    const repoFlag = parseFlag('--repo', '')
    if (!repoFlag) {
      console.error('Usage: init.ts hub-enroll --repo <owner/name> [--org <org>] [--project-url <url>] [--dry-run]')
      process.exit(1)
    }
    const [maybeOrg, maybeRepo] = repoFlag.includes('/') ? repoFlag.split('/') : [org, repoFlag]

    // Resolve projectUrl + projectId: prefer --project-url flag, then artifacts/migration/hub-project.json
    let projectUrl = parseFlag('--project-url', '')
    let projectId = ''
    if (!projectUrl) {
      const hubProjectFile = 'artifacts/migration/hub-project.json'
      try {
        const hubData = JSON.parse(readFS(hubProjectFile, 'utf-8')) as { projectId: string; projectUrl: string }
        projectUrl = hubData.projectUrl
        projectId = hubData.projectId
      } catch {
        console.error(
          `[hub-enroll] --project-url not provided and ${hubProjectFile} not found. Run hub-bootstrap first.`,
        )
        process.exit(1)
      }
    }

    const dryRun = hasFlag('--dry-run')
    const result = await enrollRepo({ org: maybeOrg, repo: maybeRepo, projectUrl, projectId, dryRun })
    console.log(JSON.stringify({ step: 'hub-enroll', ...result }))
    break
  }

  case 'hub-bootstrap': {
    const { bootstrapProject, bootstrapFields, bootstrapIssueTypes, runRenameSpike, applyRenames } = await import(
      './lib/hub-bootstrap'
    )
    const { ghGraphQL } = await import('../shared/adapters/github-adapter')
    const { mkdirSync: mkdirSyncHub, writeFileSync: writeFileSyncHub } = await import('node:fs')

    const owner = parseFlag('--owner', 'Roxabi')
    const spikeOnly = hasFlag('--spike-only')
    const confirmRenames = hasFlag('--confirm-renames')
    const spikeSnapshot = parseFlag('--spike-snapshot', '')

    // Resolve ownerId via organization GraphQL query
    const orgIdOut = (await ghGraphQL('query($l:String!){organization(login:$l){id}}', { l: owner })) as {
      data: { organization: { id: string } }
    }
    const ownerId = orgIdOut.data.organization.id

    if (spikeOnly) {
      const defaultSnapshotPath = `artifacts/migration/119-rename-spike-${new Date().toISOString().slice(0, 10)}.json`
      const snapshotPath = spikeSnapshot || defaultSnapshotPath
      await runRenameSpike({ snapshotPath, ownerLogin: owner })
      console.log(JSON.stringify({ step: 'spike-only', snapshotPath }))
      break
    }

    // Full bootstrap flow (1.1–1.6)
    const project = await bootstrapProject(owner, ownerId)
    await bootstrapFields(project.id)
    await bootstrapIssueTypes(owner, ownerId)

    // Persist hub project metadata for downstream hub-enroll calls (B6)
    const projectUrl = `https://github.com/orgs/${owner}/projects/${project.number}`
    const hubProjectData = {
      projectId: project.id,
      projectUrl,
      number: project.number,
      createdAt: new Date().toISOString(),
    }
    mkdirSyncHub('artifacts/migration', { recursive: true })
    writeFileSyncHub('artifacts/migration/hub-project.json', JSON.stringify(hubProjectData, null, 2))

    console.log(JSON.stringify({ step: 'bootstrap', project: { id: project.id, number: project.number } }))

    if (confirmRenames) {
      await applyRenames({ confirmRenames: true, spikeSnapshot: spikeSnapshot || undefined })
      console.log(JSON.stringify({ step: 'renames-applied' }))
    }
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    console.error(
      'Usage: init.ts [prereqs|discover|create-project|migrate-issues|labels|workflows|push-workflows|protect-branches|list-workflows|scaffold-docs|scaffold-rules|scaffold|scaffold-fumadocs|scaffold-fumadocs-vercel|hub-bootstrap|hub-enroll]',
    )
    process.exit(1)
}
