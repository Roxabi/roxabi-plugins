#!/usr/bin/env bun
/**
 * Issues Dashboard — local dev tool
 * Usage: bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/dashboard.ts [--port=3333] [--poll=60]
 *
 * Serves a live HTML dashboard of GitHub project issues.
 * Features: in-memory cache, background polling, SSE live updates, multi-project workspace.
 */

import {
  fetchAllProjects,
  fetchBranchCI,
  fetchBranches,
  fetchIssues,
  fetchPRs,
  fetchVercelDeployments,
  fetchWorkflowRuns,
  fetchWorktrees,
} from './lib/fetch'
import type { WorkspaceProject } from './lib/fetch'
import { buildHtml } from './lib/page'
import type {
  Branch,
  BranchCI,
  Issue,
  PR,
  VercelDeployment,
  WorkflowRun,
  Worktree,
} from './lib/types'
import type { RawItem } from '../../shared/types'
import { handleUpdate } from './lib/update'
import {
  discoverProject,
  readWorkspace,
  writeWorkspace,
  getWorkspacePath,
} from '../../../../cli/lib/workspace'

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3333)
const POLL_MS =
  Number(process.argv.find((a) => a.startsWith('--poll='))?.split('=')[1] ?? 60) * 1000
const PID_FILE = `${import.meta.dirname}/.dashboard.pid`

// ---------------------------------------------------------------------------
// Raw-items-to-issues transform (mirrors fetchIssues logic, for multi-project)
// ---------------------------------------------------------------------------
function rawItemsToIssues(items: RawItem[]): Issue[] {
  const openItems = items.filter((i) => i.content?.state === 'OPEN')

  const field = (item: RawItem, name: string): string => {
    for (const fv of item.fieldValues.nodes) {
      if (fv.field?.name === name && fv.name) return fv.name
    }
    return '-'
  }

  const byNumber = new Map<number, RawItem>()
  for (const item of openItems) byNumber.set(item.content.number, item)

  const toIssue = (item: RawItem): Issue => {
    const bb = item.content.blockedBy?.nodes ?? []
    const bl = item.content.blocking?.nodes ?? []
    const openBlockedBy = bb.filter((b) => b.state === 'OPEN')

    let blockStatus: Issue['blockStatus'] = 'ready'
    if (openBlockedBy.length > 0) blockStatus = 'blocked'
    else if (bl.length > 0) blockStatus = 'blocking'

    const subs = item.content.subIssues?.nodes ?? []
    const children: Issue[] = subs
      .map((sub) => {
        const child = byNumber.get(sub.number)
        if (!child) return null
        return toIssue(child)
      })
      .filter(Boolean) as Issue[]

    return {
      number: item.content.number,
      title: item.content.title,
      url: item.content.url,
      status: field(item, 'Status'),
      size: field(item, 'Size'),
      priority: field(item, 'Priority'),
      blockStatus,
      blockedBy: bb,
      blocking: bl,
      children,
    }
  }

  const roots = openItems
    .filter((i) => !i.content.parent || i.content.parent.state === 'CLOSED')
    .map(toIssue)

  const statusOrder: Record<string, number> = {
    Review: 0,
    'In Progress': 1,
    Specs: 2,
    Analysis: 3,
    Backlog: 4,
    '-': 99,
  }
  const blockOrder: Record<string, number> = { blocking: 0, ready: 1, blocked: 2 }
  const priorityOrder: Record<string, number> = {
    'P0 - Urgent': 0,
    'P1 - High': 1,
    'P2 - Medium': 2,
    'P3 - Low': 3,
    '-': 99,
  }

  roots.sort((a, b) => {
    const sd = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99)
    if (sd !== 0) return sd
    const bd = (blockOrder[a.blockStatus] ?? 9) - (blockOrder[b.blockStatus] ?? 9)
    if (bd !== 0) return bd
    return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99)
  })

  return roots
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
let cache: {
  html: string
  hash: string
  fetchMs: number
  updatedAt: number
  byProject: Map<string, Issue[]> | null
  workspaceHash: string
} | null = null

function computeHash(
  issues: Issue[],
  prs: PR[],
  branches: Branch[],
  worktrees: Worktree[],
  deployments: VercelDeployment[],
  branchCI: BranchCI[],
  workflowRuns: WorkflowRun[]
): string {
  const key = JSON.stringify({
    i: issues.map((i) => [
      i.number,
      i.status,
      i.size,
      i.priority,
      i.blockStatus,
      i.children.length,
    ]),
    p: prs.map((p) => [
      p.number,
      p.isDraft,
      p.reviewDecision,
      p.updatedAt,
      p.checks.map((c) => [c.name, c.status, c.conclusion]),
    ]),
    b: branches.length,
    w: worktrees.length,
    v: deployments.map((d) => [d.uid, d.state, d.buildSteps.map((s) => s.status)]),
    ci: branchCI.map((c) => [c.branch, c.commitSha, c.overallState]),
    wr: workflowRuns.map((r) => [r.id, r.status, r.conclusion]),
  })
  return Bun.hash(key).toString(36)
}

function computeWorkspaceHash(projects: WorkspaceProject[]): string {
  return Bun.hash(JSON.stringify(projects)).toString(36)
}

async function refreshCache(): Promise<void> {
  try {
    const start = performance.now()

    // Resolve issues — multi-project if workspace has projects, else single-project fallback
    const ws = readWorkspace()
    const newWorkspaceHash = computeWorkspaceHash(ws.projects)
    let issues: Issue[]
    let byProject: Map<string, Issue[]> | null = null

    if (ws.projects.length > 0) {
      const rawMap = await fetchAllProjects(ws.projects)
      byProject = new Map<string, Issue[]>()
      const allRaw: RawItem[] = []
      for (const [label, rawItems] of rawMap) {
        const projectIssues = rawItemsToIssues(rawItems)
        byProject.set(label, projectIssues)
        allRaw.push(...rawItems)
      }
      issues = rawItemsToIssues(allRaw)
    } else {
      issues = await fetchIssues()
    }

    const [prs, branches, worktrees, deployments, branchCI, workflowRuns] = await Promise.all([
      fetchPRs(),
      fetchBranches(),
      fetchWorktrees(),
      fetchVercelDeployments(),
      fetchBranchCI(),
      fetchWorkflowRuns(),
    ])

    const fetchMs = Math.round(performance.now() - start)
    const hash = computeHash(issues, prs, branches, worktrees, deployments, branchCI, workflowRuns)

    // Detect workspace change and notify clients even if issue data is unchanged
    const workspaceChanged = !cache || cache.workspaceHash !== newWorkspaceHash
    const dataChanged = !cache || cache.hash !== hash
    const changed = dataChanged || workspaceChanged

    const updatedAt = Date.now()
    const html = buildHtml(
      issues,
      prs,
      branches,
      worktrees,
      deployments,
      branchCI,
      workflowRuns,
      fetchMs,
      updatedAt
    )
    cache = { html, hash, fetchMs, updatedAt, byProject, workspaceHash: newWorkspaceHash }

    if (changed) notifyClients()
  } catch (err) {
    console.error('[dashboard] refresh failed:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
const sseClients = new Set<ReadableStreamDefaultController>()

function notifyClients(): void {
  const dead: ReadableStreamDefaultController[] = []
  for (const client of sseClients) {
    try {
      client.enqueue(new TextEncoder().encode('data: refresh\n\n'))
    } catch {
      dead.push(client)
    }
  }
  for (const c of dead) sseClients.delete(c)
}

// Heartbeat to keep SSE connections alive
setInterval(() => {
  const dead: ReadableStreamDefaultController[] = []
  for (const client of sseClients) {
    try {
      client.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
    } catch {
      dead.push(client)
    }
  }
  for (const c of dead) sseClients.delete(c)
}, 30_000)

// ---------------------------------------------------------------------------
// PID file + cleanup
// ---------------------------------------------------------------------------
await Bun.write(PID_FILE, String(process.pid))
process.on('SIGINT', () => {
  try {
    require('node:fs').unlinkSync(PID_FILE)
  } catch {}
  process.exit(0)
})
process.on('SIGTERM', () => {
  try {
    require('node:fs').unlinkSync(PID_FILE)
  } catch {}
  process.exit(0)
})

// ---------------------------------------------------------------------------
// Initial fetch + background poll
// ---------------------------------------------------------------------------
await refreshCache()
setInterval(refreshCache, POLL_MS)

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max — SSE connections are long-lived
  async fetch(req) {
    const url = new URL(req.url)

    // SSE endpoint
    if (url.pathname === '/api/events') {
      let ctrl: ReadableStreamDefaultController
      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller
          sseClients.add(controller)
          controller.enqueue(new TextEncoder().encode('data: connected\n\n'))
        },
        cancel() {
          sseClients.delete(ctrl)
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // Field update
    if (url.pathname === '/api/update' && req.method === 'POST') {
      const response = await handleUpdate(req)
      // Trigger immediate refresh after update
      refreshCache()
      return response
    }

    // Workspace: add a project
    if (url.pathname === '/api/workspace/add' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { repo?: string }
        if (!body.repo) {
          return Response.json({ ok: false, error: 'Missing repo field' }, { status: 400 })
        }
        const discovered = await discoverProject(body.repo)
        if (discovered.length === 0) {
          return Response.json(
            { ok: false, error: `No GitHub Projects found for repo '${body.repo}'` },
            { status: 400 }
          )
        }
        // Auto-select the first project when only one is found; if multiple, pick first
        const project = discovered[0]
        const ws = readWorkspace()
        const alreadyAdded = ws.projects.some((p) => p.projectId === project.projectId)
        if (!alreadyAdded) {
          ws.projects.push(project)
          writeWorkspace(ws)
        }
        notifyClients()
        refreshCache()
        return Response.json({ ok: true, project })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json({ ok: false, error: msg }, { status: 400 })
      }
    }

    // Workspace: remove a project
    if (url.pathname === '/api/workspace/remove' && req.method === 'DELETE') {
      try {
        const body = (await req.json()) as { repo?: string }
        if (!body.repo) {
          return Response.json({ ok: false, error: 'Missing repo field' }, { status: 400 })
        }
        const ws = readWorkspace()
        const before = ws.projects.length
        ws.projects = ws.projects.filter((p) => p.repo !== body.repo)
        if (ws.projects.length !== before) {
          writeWorkspace(ws)
          notifyClients()
          refreshCache()
        }
        return Response.json({ ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json({ ok: false, error: msg }, { status: 400 })
      }
    }

    // Dashboard page
    try {
      if (!cache) await refreshCache()
      return new Response(cache?.html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return new Response(
        `<pre style="color:red;padding:20px;">Error fetching issues:\n${msg}</pre>`,
        { status: 500, headers: { 'Content-Type': 'text/html' } }
      )
    }
  },
})

const pollSec = POLL_MS / 1000
console.log(
  `\n  Issues Dashboard \u2192 http://localhost:${server.port}  (live, polling every ${pollSec}s)\n`
)
