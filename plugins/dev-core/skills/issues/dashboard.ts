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
  rawItemsToIssues,
} from './lib/fetch'
import type { WorkspaceProject } from '../shared/workspace'
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

import { handleUpdate } from './lib/update'
import {
  discoverProject,
  readWorkspace,
  writeWorkspace,
} from '../shared/workspace'

type ProjectMeta = { prs: PR[]; branchCI: BranchCI[]; workflowRuns: WorkflowRun[]; deployments: VercelDeployment[] }

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3333)
const POLL_MS =
  Number(process.argv.find((a) => a.startsWith('--poll='))?.split('=')[1] ?? 60) * 1000
const PID_FILE = `${import.meta.dirname}/.dashboard.pid`

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
  stale?: boolean
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
    let byProjectMeta: Map<string, ProjectMeta> | null = null

    if (ws.projects.length > 0) {
      const [rawMap, metaResults, branches_, worktrees_] = await Promise.all([
        fetchAllProjects(ws.projects),
        Promise.all(ws.projects.map(async (p) => ({
          label: p.label,
          prs: await fetchPRs(p.repo),
          branchCI: await fetchBranchCI(p.repo),
          workflowRuns: await fetchWorkflowRuns(p.repo),
          deployments: await fetchVercelDeployments(p.vercelProjectId, p.vercelTeamId),
        }))),
        fetchBranches(),
        fetchWorktrees(),
      ])

      byProject = new Map<string, Issue[]>()
      for (const [label, rawItems] of rawMap) {
        byProject.set(label, rawItemsToIssues(rawItems))
      }
      issues = [...byProject.values()].flat()
      byProjectMeta = new Map(metaResults.map((m) => [m.label, { prs: m.prs, branchCI: m.branchCI, workflowRuns: m.workflowRuns, deployments: m.deployments }]))

      const prs = metaResults.flatMap((m) => m.prs)
      const branchCI = metaResults.flatMap((m) => m.branchCI)
      const workflowRuns = metaResults.flatMap((m) => m.workflowRuns)
      const deployments_ = metaResults.flatMap((m) => m.deployments)
      const fetchMs = Math.round(performance.now() - start)
      const hash = computeHash(issues, prs, branches_, worktrees_, deployments_, branchCI, workflowRuns)
      const workspaceChanged = !cache || cache.workspaceHash !== newWorkspaceHash
      const changed = workspaceChanged || !cache || cache.hash !== hash
      const updatedAt = Date.now()
      const wsProjects = ws.projects.map(p => ({
        label: p.label,
        repo: p.repo,
        type: p.type,
        fieldIds: p.fieldIds,
        vercelProjectId: p.vercelProjectId,
        vercelTeamId: p.vercelTeamId,
      }))
      const html = buildHtml(issues, prs, branches_, worktrees_, deployments_, branchCI, workflowRuns, fetchMs, updatedAt, byProject, wsProjects, byProjectMeta)
      cache = { html, hash, fetchMs, updatedAt, byProject, workspaceHash: newWorkspaceHash }
      if (changed) notifyClients()
      return
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
    const wsProjects = ws.projects.map(p => ({
      label: p.label,
      repo: p.repo,
      type: p.type,
      fieldIds: p.fieldIds,
      vercelProjectId: p.vercelProjectId,
      vercelTeamId: p.vercelTeamId,
    }))
    const html = buildHtml(
      issues,
      prs,
      branches,
      worktrees,
      deployments,
      branchCI,
      workflowRuns,
      fetchMs,
      updatedAt,
      byProject ?? undefined,
      wsProjects.length > 0 ? wsProjects : undefined
    )
    cache = { html, hash, fetchMs, updatedAt, byProject, workspaceHash: newWorkspaceHash }

    if (changed) notifyClients()
  } catch (err) {
    console.error('[dashboard] refresh failed:', err instanceof Error ? err.message : err)
    if (cache) {
      cache.stale = true
      notifyClients()
    }
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
  hostname: '127.0.0.1',
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
      const html = cache?.stale
        ? cache.html.replace('<body', '<body data-stale="true"')
        : cache?.html
      return new Response(html, {
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
