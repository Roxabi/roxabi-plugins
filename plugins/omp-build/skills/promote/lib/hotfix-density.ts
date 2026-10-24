import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Deps, formatResult, type HotfixDensityResult, summarizeHotfixDensity } from './hotfix-density-domain'
import { fetchHotfixPrShas, listCommitsSince, resolveAnchor } from './hotfix-density-readback'

export async function computeHotfixDensity(cwd: string | undefined, deps: Deps): Promise<HotfixDensityResult> {
  const anchor = await resolveAnchor(cwd, deps)
  const commits = await listCommitsSince(anchor.anchorDate, cwd, deps)
  const hotfixPrShas = commits.length === 0 ? new Set<string>() : await fetchHotfixPrShas(anchor.anchorDate, deps)
  return summarizeHotfixDensity(commits, hotfixPrShas, anchor)
}

if (import.meta.main) {
  const execFileAsync = promisify(execFile)
  const deps: Deps = {
    run: async (cmd, cwd) => {
      const [bin, ...args] = cmd
      const { stdout } = await execFileAsync(bin, args, { cwd: cwd ?? process.cwd() })
      return stdout.trim()
    },
  }
  const result = await computeHotfixDensity(process.cwd(), deps)
  console.log(formatResult(result))
}
