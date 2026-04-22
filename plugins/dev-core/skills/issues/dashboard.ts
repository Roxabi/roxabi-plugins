#!/usr/bin/env bun

/**
 * Issues Dashboard — local dev tool
 * Usage: bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/dashboard.ts [--port=3333] [--poll=60]
 *
 * Serves a live HTML dashboard of GitHub project issues.
 * Features: in-memory cache, background polling, SSE live updates, multi-project workspace.
 */

import { discoverProject } from '../../cli/lib/github-discovery'
import { readWorkspace, writeWorkspace } from '../../cli/lib/workspace-store'
import {
  addToProject,
  getItemId,
  getNodeId,
  getProjectTitle,
  removeFromProject,
} from '../shared/adapters/github-adapter'
import type { VercelProjectRef, WorkspaceProject } from '../shared/ports/workspace'
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
import { buildHtml } from './lib/page'
import type { Branch, BranchCI, Issue, PR, VercelDeployment, WorkflowRun, Worktree } from './lib/types'
import { handleUpdate } from './lib/update'

type ProjectMeta = {
  prs: PR[]
  branchCI: BranchCI[]
  workflowRuns: WorkflowRun[]
  deployments: VercelDeployment[]
  branches: Branch[]
  worktrees: Worktree[]
}

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3333)
const POLL_MS = Number(process.argv.find((a) => a.startsWith('--poll='))?.split('=')[1] ?? 60) * 1000
const PID_FILE = `${import.meta.dirname}/.dashboard.pid`

// ---------------------------------------------------------------------------
// Roadmap project title cache (fetched once per process lifetime)
// ---------------------------------------------------------------------------
let cachedRoadmapLabel: string | undefined

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
  workflowRuns: WorkflowRun[],
): string {
  const key = JSON.stringify({
    i: issues.map((i) => [i.number, i.status, i.size, i.priority, i.blockStatus, i.children.length]),
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

/** Resolve the list of Vercel projects for a workspace entry. */
function resolveVercelProjects(p: WorkspaceProject): VercelProjectRef[] {
  if (p.vercelProjects && p.vercelProjects.length > 0) return p.vercelProjects
  // Legacy single-project fields removed — use vercelProjects[] array
  return []
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

    // Fetch roadmap items (and title, once) if configured
    let roadmapItems: Issue[] | undefined
    let roadmapLabel = cachedRoadmapLabel
    const ROADMAP_KEY = '__roadmap__'

    if (ws.projects.length > 0) {
      // Build a single batched entry list: workspace projects + roadmap (if any)
      const allEntries: { label: string; projectId: string }[] = [...ws.projects]
      if (ws.roadmapProjectId) allEntries.push({ label: ROADMAP_KEY, projectId: ws.roadmapProjectId })

      // Deduplicate repos so PRs/BranchCI are fetched once per repo
      const uniqueRepos = [...new Set(ws.projects.map((p) => p.repo))]

      const [{ items: rawMap, truncated: truncatedLabels }, prsByRepo, branchCIByRepo, titleResult, metaResults] =
        await Promise.all([
          fetchAllProjects(allEntries),
          Promise.all(uniqueRepos.map((repo) => fetchPRs(repo).then((prs) => [repo, prs] as const))),
          Promise.all(uniqueRepos.map((repo) => fetchBranchCI(repo).then((ci) => [repo, ci] as const))),
          ws.roadmapProjectId && !cachedRoadmapLabel
            ? getProjectTitle(ws.roadmapProjectId)
            : Promise.resolve(cachedRoadmapLabel),
          Promise.all(
            ws.projects.map(async (p) => {
              const [workflowRuns, deployments, branches, worktrees] = await Promise.all([
                fetchWorkflowRuns(p.repo),
                Promise.all(resolveVercelProjects(p).map((vp) => fetchVercelDeployments(vp.projectId, vp.teamId))).then(
                  (r) => r.flat(),
                ),
                p.localPath ? fetchBranches(p.localPath) : Promise.resolve([]),
                p.localPath ? fetchWorktrees(p.localPath) : Promise.resolve([]),
              ])
              return { label: p.label, workflowRuns, deployments, branches, worktrees }
            }),
          ),
        ])

      const prsMap = new Map(prsByRepo)
      const branchCIMap = new Map(branchCIByRepo)

      // Resolve roadmap from batched result
      if (ws.roadmapProjectId) {
        try {
          const rawRoadmap = rawMap.get(ROADMAP_KEY) ?? []
          roadmapItems = rawItemsToIssues(rawRoadmap)
          roadmapLabel = titleResult ?? undefined
          if (!cachedRoadmapLabel && roadmapLabel) cachedRoadmapLabel = roadmapLabel
        } catch (err) {
          console.error('[dashboard] roadmap fetch failed:', err instanceof Error ? err.message : err)
          roadmapItems = []
        }
      }

      // Attach PRs/BranchCI per project from deduplicated maps
      const metaResultsWithCI = metaResults.map((m) => {
        const repo = ws.projects.find((p) => p.label === m.label)?.repo ?? ''
        return {
          ...m,
          prs: prsMap.get(repo) ?? [],
          branchCI: branchCIMap.get(repo) ?? [],
        }
      })

      byProject = new Map<string, Issue[]>()
      for (const [label, rawItems] of rawMap) {
        if (label === ROADMAP_KEY) continue // roadmap handled separately
        const proj = ws.projects.find((p) => p.label === label)
        const type = proj?.type ?? 'technical'
        const slotNames = type === 'company' ? { col2: 'Quarter', col3: 'Pillar' } : { col2: 'Size', col3: 'Priority' }
        byProject.set(label, rawItemsToIssues(rawItems, slotNames))
      }
      issues = [...byProject.values()].flat()

      // Tag each issue with the list of projects it belongs to (for context menu add/remove).
      // Key: "owner/repo:number" to avoid collisions across repos.
      const issueProjectsMap = new Map<string, string[]>()
      for (const [label, projectIssues] of byProject.entries()) {
        const repo = ws.projects.find((p) => p.label === label)?.repo ?? ''
        for (const issue of projectIssues) {
          const key = `${repo}:${issue.number}`
          const existing = issueProjectsMap.get(key)
          if (existing) existing.push(label)
          else issueProjectsMap.set(key, [label])
        }
      }
      for (const [label, projectIssues] of byProject.entries()) {
        const repo = ws.projects.find((p) => p.label === label)?.repo ?? ''
        for (const issue of projectIssues) {
          issue.inProjects = issueProjectsMap.get(`${repo}:${issue.number}`) ?? []
          for (const child of issue.children) {
            child.inProjects = issueProjectsMap.get(`${repo}:${child.number}`) ?? issue.inProjects
          }
        }
      }
      // Tag roadmap items: cross-reference with workspace projects + add the roadmap itself
      if (roadmapItems) {
        for (const item of roadmapItems) {
          const itemRepo = item.url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? ''
          const projectLabels = issueProjectsMap.get(`${itemRepo}:${item.number}`) ?? []
          item.inProjects = roadmapLabel ? [...projectLabels, roadmapLabel] : projectLabels
        }
      }

      byProjectMeta = new Map(
        metaResultsWithCI.map((m) => [
          m.label,
          {
            prs: m.prs,
            branchCI: m.branchCI,
            workflowRuns: m.workflowRuns,
            deployments: m.deployments,
            branches: m.branches,
            worktrees: m.worktrees,
          },
        ]),
      )

      const prs = metaResultsWithCI.flatMap((m) => m.prs)
      const branches_ = metaResultsWithCI.flatMap((m) => m.branches)
      const worktrees_ = metaResultsWithCI.flatMap((m) => m.worktrees)
      const branchCI = metaResultsWithCI.flatMap((m) => m.branchCI)
      const workflowRuns = metaResultsWithCI.flatMap((m) => m.workflowRuns)
      const deployments_ = metaResultsWithCI.flatMap((m) => m.deployments)
      const fetchMs = Math.round(performance.now() - start)
      const hash = computeHash(issues, prs, branches_, worktrees_, deployments_, branchCI, workflowRuns)
      const workspaceChanged = !cache || cache.workspaceHash !== newWorkspaceHash
      const changed = workspaceChanged || !cache || cache.hash !== hash
      const updatedAt = Date.now()
      const wsProjects = ws.projects.map((p) => ({
        label: p.label,
        repo: p.repo,
        projectId: p.projectId,
        type: p.type,
        fieldIds: p.fieldIds,
        vercelProjects: p.vercelProjects,
        localPath: p.localPath,
      })) as WorkspaceProject[]
      const roadmapProject =
        ws.roadmapProjectId && roadmapLabel ? { label: roadmapLabel, projectId: ws.roadmapProjectId } : undefined
      const html = buildHtml(
        issues,
        prs,
        branches_,
        worktrees_,
        deployments_,
        branchCI,
        workflowRuns,
        fetchMs,
        updatedAt,
        byProject,
        wsProjects,
        byProjectMeta,
        roadmapItems,
        roadmapProject,
        truncatedLabels.length > 0 ? truncatedLabels : undefined,
      )
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
    const wsProjects = ws.projects.map((p) => ({
      label: p.label,
      repo: p.repo,
      projectId: p.projectId,
      type: p.type,
      fieldIds: p.fieldIds,
      vercelProjects: p.vercelProjects,
    })) as WorkspaceProject[]
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
      wsProjects.length > 0 ? (wsProjects as WorkspaceProject[]) : undefined,
      undefined,
      roadmapItems,
      ws.roadmapProjectId && roadmapLabel ? { label: roadmapLabel, projectId: ws.roadmapProjectId } : undefined,
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
            { status: 400 },
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
        console.error('[dashboard] workspace/add error:', msg)
        return Response.json({ ok: false, error: 'Workspace update failed — check server logs' }, { status: 400 })
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
        console.error('[dashboard] workspace/remove error:', msg)
        return Response.json({ ok: false, error: 'Workspace update failed — check server logs' }, { status: 400 })
      }
    }

    // Add/remove an issue from a project
    if (url.pathname === '/api/project-item' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          issueNumber: number
          projectLabel: string
          action: 'add' | 'remove'
          issueRepo?: string
          projectId?: string // direct projectId for roadmap (not in ws.projects)
        }
        const { issueNumber, projectLabel, action, issueRepo, projectId: directProjectId } = body
        const ws = readWorkspace()

        // Find project in ws.projects, or fall back to the roadmap project
        const project = ws.projects.find((p) => p.label === projectLabel)
        const resolvedProjectId =
          project?.projectId ??
          (directProjectId ||
            (ws.roadmapProjectId && cachedRoadmapLabel === projectLabel ? ws.roadmapProjectId : undefined))
        if (!resolvedProjectId) {
          return Response.json({ ok: false, error: `Unknown project: ${projectLabel}` }, { status: 400 })
        }

        // Use issueRepo from browser (supports cross-repo roadmap items); fall back to project repo
        const repoForApi = issueRepo || project?.repo || ''
        if (!repoForApi) {
          return Response.json({ ok: false, error: 'Cannot determine issue repo' }, { status: 400 })
        }

        if (action === 'add') {
          const nodeId = await getNodeId(issueNumber, repoForApi)
          await addToProject(nodeId, resolvedProjectId)
        } else {
          const itemId = await getItemId(issueNumber, { projectId: resolvedProjectId, repo: repoForApi })
          await removeFromProject(itemId, resolvedProjectId)
        }
        refreshCache()
        return Response.json({ ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[dashboard] project-item error:', msg)
        return Response.json({ ok: false, error: 'Operation failed — check server logs' }, { status: 500 })
      }
    }

    // Dashboard page
    try {
      if (!cache) await refreshCache()
      const html = cache?.stale ? cache.html.replace('<body', '<body data-stale="true"') : cache?.html
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[dashboard] page render error:', msg)
      return new Response(`<pre style="color:red;padding:20px;">Error loading dashboard — check server logs</pre>`, {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      })
    }
  },
})

const pollSec = POLL_MS / 1000
console.log(`\n  Issues Dashboard \u2192 http://localhost:${server.port}  (live, polling every ${pollSec}s)\n`)
