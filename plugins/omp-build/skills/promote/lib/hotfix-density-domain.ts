export type Gauge = 'green' | 'warn' | 'pause'
export type AnchorSource = 'tag' | 'promotion-merge' | 'fallback-30d'

export interface HotfixDensityResult {
  total: number
  hotfixCount: number
  density: number
  gauge: Gauge
  anchorDate: string
  anchorSource: AnchorSource
  anchorWarn?: string
}

export interface Deps {
  run: (cmd: string[], cwd?: string) => Promise<string>
}

export type Commit = { sha: string; title: string }

export const THRESHOLD_GREEN = 0.2
export const THRESHOLD_WARN = 0.4
export const THRESHOLD_PAUSE = THRESHOLD_WARN

export function classifyDensity(density: number): Gauge {
  if (density < THRESHOLD_GREEN) return 'green'
  if (density < THRESHOLD_WARN) return 'warn'
  return 'pause'
}

export function parseCommits(output: string): Commit[] {
  if (!output.trim()) return []
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab === -1
        ? { sha: line.trim(), title: '' }
        : { sha: line.slice(0, tab).trim(), title: line.slice(tab + 1).trim() }
    })
}

export function isHotfix(sha: string, title: string, hotfixPrShas: Set<string>): boolean {
  return /^fix:/i.test(title) || hotfixPrShas.has(sha)
}

export function summarizeHotfixDensity(
  commits: Commit[],
  hotfixPrShas: Set<string>,
  anchor: Pick<HotfixDensityResult, 'anchorDate' | 'anchorSource' | 'anchorWarn'>,
): HotfixDensityResult {
  const hotfixCount = commits.filter(({ sha, title }) => isHotfix(sha, title, hotfixPrShas)).length
  const total = commits.length
  const density = total === 0 ? 0 : hotfixCount / total
  return {
    total,
    hotfixCount,
    density,
    gauge: classifyDensity(density),
    ...anchor,
  }
}

function signalFor(gauge: Gauge): string {
  switch (gauge) {
    case 'green':
      return 'OK'
    case 'warn':
      return 'WARN: elevated hotfix rate since the last release'
    case 'pause':
      return `PAUSE recommended: >${(THRESHOLD_WARN * 100).toFixed(0)}% hotfix rate; find the defect source before promoting`
  }
}

export function formatResult(result: HotfixDensityResult): string {
  const line = `hotfix-density: ${result.hotfixCount}/${result.total} (${(result.density * 100).toFixed(0)}%) — ${signalFor(result.gauge)}`
  return result.anchorWarn ? `${line}\n  note: ${result.anchorWarn}` : line
}
