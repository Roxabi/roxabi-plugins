#!/usr/bin/env bun
/**
 * Issues Dashboard — local dev tool
 * Usage: bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/dashboard.ts [--port=3333] [--poll=60]
 *
 * Serves a live HTML dashboard of GitHub project issues.
 * Features: in-memory cache, background polling, SSE live updates.
 */

import {
  fetchBranchCI,
  fetchBranches,
  fetchIssues,
  fetchPRs,
  fetchVercelDeployments,
  fetchWorkflowRuns,
  fetchWorktrees,
} from './lib/fetch'
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

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3333)
const POLL_MS =
  Number(process.argv.find((a) => a.startsWith('--poll='))?.split('=')[1] ?? 60) * 1000
const PID_FILE = `${import.meta.dirname}/.dashboard.pid`

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
let cache: { html: string; hash: string; fetchMs: number; updatedAt: number } | null = null

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

async function refreshCache(): Promise<void> {
  try {
    const start = performance.now()
    const [issues, prs, branches, worktrees, deployments, branchCI, workflowRuns] =
      await Promise.all([
        fetchIssues(),
        fetchPRs(),
        fetchBranches(),
        fetchWorktrees(),
        fetchVercelDeployments(),
        fetchBranchCI(),
        fetchWorkflowRuns(),
      ])
    const fetchMs = Math.round(performance.now() - start)
    const hash = computeHash(issues, prs, branches, worktrees, deployments, branchCI, workflowRuns)

    const changed = !cache || cache.hash !== hash
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
    cache = { html, hash, fetchMs, updatedAt }

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
