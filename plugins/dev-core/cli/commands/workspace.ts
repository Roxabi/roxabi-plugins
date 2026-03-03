import { discoverProject, readWorkspace, writeWorkspace } from '../lib/workspace'

const USAGE = `
Usage:
  roxabi workspace list
  roxabi workspace add <owner/repo>
  roxabi workspace remove <owner/repo>
`.trim()

function printTable(projects: { repo: string; projectId: string; label: string }[]): void {
  if (projects.length === 0) {
    console.log('No projects registered. Run: roxabi workspace add owner/repo')
    return
  }

  const repoW = Math.max('repo'.length, ...projects.map((p) => p.repo.length))
  const idW = Math.max('projectId'.length, ...projects.map((p) => p.projectId.length))
  const labelW = Math.max('label'.length, ...projects.map((p) => p.label.length))

  const row = (r: string, id: string, l: string) => `${r.padEnd(repoW)}  ${id.padEnd(idW)}  ${l.padEnd(labelW)}`

  console.log(row('repo', 'projectId', 'label'))
  console.log('-'.repeat(repoW + idW + labelW + 4))
  for (const p of projects) {
    console.log(row(p.repo, p.projectId, p.label))
  }
}

async function cmdList(): Promise<void> {
  const ws = readWorkspace()
  printTable(ws.projects)
}

async function cmdAdd(repo: string): Promise<void> {
  if (!repo) {
    console.error('Usage: roxabi workspace add <owner/repo>')
    process.exit(1)
  }

  let nodes: { repo: string; projectId: string; label: string }[]
  try {
    nodes = await discoverProject(repo)
  } catch (e) {
    console.error(String(e))
    process.exit(1)
  }

  if (nodes.length === 0) {
    console.error(`No GitHub Projects found for ${repo}.`)
    process.exit(1)
  }

  let chosen: { repo: string; projectId: string; label: string }

  if (nodes.length === 1) {
    chosen = nodes[0]
  } else {
    process.stdout.write('Multiple projects found. Select one:\n')
    for (let i = 0; i < nodes.length; i++)
      process.stdout.write(`  ${i + 1}. ${nodes[i].label} (${nodes[i].projectId})\n`)
    process.stdout.write('Enter number: ')

    const line = await new Promise<string>((resolve) => {
      process.stdin.once('data', (d) => resolve(d.toString().trim()))
    })

    const idx = parseInt(line, 10) - 1
    if (idx < 0 || idx >= nodes.length || Number.isNaN(idx)) {
      console.error(`Invalid selection: ${line}`)
      process.exit(1)
    }
    chosen = nodes[idx]
  }

  const ws = readWorkspace()
  const existing = ws.projects.findIndex((p) => p.repo === repo)
  if (existing !== -1) {
    ws.projects[existing] = chosen
  } else {
    ws.projects.push(chosen)
  }
  writeWorkspace(ws)
  console.log(`Added: ${chosen.repo} → ${chosen.label} (${chosen.projectId})`)
}

async function cmdRemove(repo: string): Promise<void> {
  if (!repo) {
    console.error('Usage: roxabi workspace remove <owner/repo>')
    process.exit(1)
  }

  const ws = readWorkspace()
  const idx = ws.projects.findIndex((p) => p.repo === repo)
  if (idx === -1) {
    console.error(`Error: '${repo}' is not registered in the workspace.`)
    process.exit(1)
    return
  }

  ws.projects.splice(idx, 1)
  writeWorkspace(ws)
  console.log(`Removed: ${repo}`)
  process.exit(0)
}

export async function run(args: string[]): Promise<void> {
  const sub = args[0]

  switch (sub) {
    case 'list':
      await cmdList()
      break

    case 'add':
      await cmdAdd(args[1] ?? '')
      break

    case 'remove':
      await cmdRemove(args[1] ?? '')
      break

    default:
      if (sub) {
        console.error(`Unknown workspace subcommand: ${sub}`)
      }
      console.log(USAGE)
      process.exit(sub ? 1 : 0)
  }
}
