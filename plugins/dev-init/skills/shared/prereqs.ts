/**
 * Shared prerequisite checks — used by doctor and init.
 * Uses Bun.spawnSync() for synchronous execution (like detectGitHubRepo).
 */

export interface PrereqResult {
  bun: { ok: boolean; version: string }
  gh: { ok: boolean; detail: string }
  gitRemote: { ok: boolean; url: string; repo: string; owner: string }
}

function spawnSync(cmd: string[]): { stdout: string; ok: boolean } {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    return { stdout, ok: proc.exitCode === 0 }
  } catch {
    return { stdout: '', ok: false }
  }
}

export function checkPrereqs(): PrereqResult {
  // Bun
  const bunVersion = spawnSync(['bun', '--version'])
  const bun = { ok: bunVersion.ok, version: bunVersion.ok ? bunVersion.stdout : '' }

  // GitHub CLI + auth
  let gh: PrereqResult['gh'] = { ok: false, detail: '' }
  const ghVersion = spawnSync(['gh', '--version'])
  if (ghVersion.ok) {
    const ghAuth = spawnSync(['gh', 'auth', 'status'])
    // gh auth status outputs to stderr on success, but exits 0
    gh = { ok: ghAuth.ok, detail: ghAuth.ok ? 'authenticated' : 'not authenticated' }
  } else {
    gh = { ok: false, detail: 'not installed' }
  }

  // Git remote
  let gitRemote: PrereqResult['gitRemote'] = { ok: false, url: '', repo: '', owner: '' }
  const remoteUrl = spawnSync(['git', 'remote', 'get-url', 'origin'])
  if (remoteUrl.ok && remoteUrl.stdout) {
    const match = remoteUrl.stdout.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
    if (match) {
      gitRemote = { ok: true, url: remoteUrl.stdout, owner: match[1], repo: match[2] }
    }
  }

  return { bun, gh, gitRemote }
}
