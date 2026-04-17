import type { BuildStep, VercelDeployment } from './types'

const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID ?? ''
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID ?? ''

export function getVercelToken(): string {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN
  // Try Vercel CLI auth files (written by `vercel login`)
  const home = process.env.HOME ?? ''
  const candidates = [
    `${home}/.local/share/com.vercel.cli/auth.json`, // Linux
    `${home}/Library/Application Support/com.vercel.cli/auth.json`, // macOS
    `${home}/.vercel/auth.json`, // legacy
  ]
  for (const p of candidates) {
    try {
      const json = JSON.parse(require('node:fs').readFileSync(p, 'utf8')) as { token?: string }
      if (json.token) return json.token
    } catch {
      // not found or unreadable — try next
    }
  }
  return ''
}

// Build phases detected from Vercel build log text
const BUILD_PHASES: { name: string; patterns: RegExp[] }[] = [
  { name: 'Provision', patterns: [/Running build in/] },
  { name: 'Download', patterns: [/Retrieving list|Downloading .* deployment files/] },
  { name: 'Install', patterns: [/Running "install"|bun install|npm install|yarn install/] },
  {
    name: 'Build',
    patterns: [/Running "vercel build"|Running "build"|turbo run build|vite build/],
  },
  { name: 'Deploy', patterns: [/Deploying outputs|Build completed|Serverless Function/] },
]

function parseBuildSteps(logs: string[], deployState: string): BuildStep[] {
  const reached = new Set<number>()
  for (const line of logs) {
    for (let i = 0; i < BUILD_PHASES.length; i++) {
      if (BUILD_PHASES[i].patterns.some((p) => p.test(line))) reached.add(i)
    }
  }

  const hasError = deployState === 'ERROR' || logs.some((l) => /^Error:|Command ".*" exited with \d+/.test(l))
  const maxReached = Math.max(-1, ...reached)

  return BUILD_PHASES.map((phase, i) => {
    if (i < maxReached) return { name: phase.name, status: 'done' as const }
    if (i === maxReached) {
      if (hasError) return { name: phase.name, status: 'error' as const }
      if (deployState === 'READY') return { name: phase.name, status: 'done' as const }
      return { name: phase.name, status: 'running' as const }
    }
    if (deployState === 'READY') return { name: phase.name, status: 'done' as const }
    return { name: phase.name, status: 'pending' as const }
  })
}

async function fetchBuildLogs(token: string, deploymentId: string, teamId: string): Promise<string[]> {
  try {
    const url = `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${teamId}&limit=200`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const events = (await res.json()) as { text: string; type: string }[]
    return events.map((e) => e.text).filter(Boolean)
  } catch {
    return []
  }
}

interface RawVercelDeployment {
  uid: string
  url: string
  name?: string
  state?: string
  readyState?: string
  target?: string
  createdAt: number
  buildingAt?: number
  ready?: number
  source?: string
  meta?: { githubCommitRef?: string; githubCommitMessage?: string }
  inspectorUrl?: string
}

export async function fetchVercelDeployments(
  projectId: string = VERCEL_PROJECT_ID,
  teamId: string = VERCEL_TEAM_ID,
): Promise<VercelDeployment[]> {
  const token = getVercelToken()
  if (!token || !projectId || !teamId) return []

  try {
    const url = `https://api.vercel.com/v6/deployments?projectId=${projectId}&teamId=${teamId}&limit=10`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { deployments: RawVercelDeployment[] }

    const mapped = data.deployments.map((d) => ({
      uid: d.uid,
      url: d.url,
      name: d.name ?? '',
      state: d.state ?? d.readyState ?? '',
      target: d.target ?? '',
      createdAt: d.createdAt,
      buildingAt: d.buildingAt ?? 0,
      ready: d.ready ?? 0,
      source: d.source ?? '',
      meta: {
        githubCommitRef: d.meta?.githubCommitRef,
        githubCommitMessage: d.meta?.githubCommitMessage,
      },
      inspectorUrl: d.inspectorUrl ?? '',
      buildSteps: [] as BuildStep[],
      isCurrent: false,
    }))

    const FIVE_MIN = 5 * 60 * 1000
    const now = Date.now()
    const isOngoing = (d: (typeof mapped)[0]) => ['BUILDING', 'QUEUED', 'INITIALIZING'].includes(d.state)

    // Production: current (latest READY prod) + latest prod error if newer than current
    const currentProd = mapped.find((d) => d.state === 'READY' && d.target === 'production')
    if (currentProd) currentProd.isCurrent = true
    const latestProdError = mapped.find((d) => d.state === 'ERROR' && d.target === 'production')
    const showProdError = latestProdError && (!currentProd || latestProdError.createdAt > currentProd.createdAt)

    // Preview: latest ongoing preview + latest completed preview if within last 5 min
    const latestOngoingPreview = mapped.find((d) => isOngoing(d) && d.target !== 'production')
    const latestCompletedPreview = mapped.find(
      (d) => !isOngoing(d) && d.target !== 'production' && now - d.createdAt < FIVE_MIN,
    )

    // Also include ongoing production deployments
    const ongoingProd = mapped.filter((d) => isOngoing(d) && d.target === 'production')

    const seen = new Set<string>()
    const filtered: typeof mapped = []
    const candidates = [
      ...ongoingProd,
      ...(currentProd ? [currentProd] : []),
      ...(showProdError ? [latestProdError] : []),
      ...(latestOngoingPreview ? [latestOngoingPreview] : []),
      ...(latestCompletedPreview ? [latestCompletedPreview] : []),
    ]
    for (const d of candidates) {
      if (!seen.has(d.uid)) {
        seen.add(d.uid)
        filtered.push(d)
      }
    }

    // Fetch build logs in parallel for all visible deployments
    const logResults = await Promise.all(filtered.map((d) => fetchBuildLogs(token, d.uid, teamId)))
    for (let i = 0; i < filtered.length; i++) {
      filtered[i].buildSteps = parseBuildSteps(logResults[i], filtered[i].state)
    }

    return filtered
  } catch {
    return []
  }
}
