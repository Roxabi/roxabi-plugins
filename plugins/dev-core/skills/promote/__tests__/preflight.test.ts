import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const PREFLIGHT_SH = fileURLToPath(new URL('../preflight.sh', import.meta.url))

// Strip ambient GIT_* (a lefthook/pre-push hook exports GIT_DIR/GIT_WORK_TREE);
// without this the staging-train case could fetch against the real worktree
// instead of failing deterministically in the throwaway dir.
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v
  }
  return env
}

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function runPreflight(stackYml: string | null): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'))
  dirs.push(dir)
  if (stackYml !== null) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'stack.yml'), stackYml)
  }
  const r = spawnSync('bash', [PREFLIGHT_SH], { cwd: dir, encoding: 'utf8', env: cleanEnv() })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? -1 }
}

describe('preflight.sh — trunk-mode guard (#371 N17)', () => {
  it('no-ops with status=trunk_mode when release.model is trunk, before any staging git op', () => {
    const { out, code } = runPreflight('release:\n  model: trunk\n  component: x\n')
    expect(out).toContain('status=trunk_mode')
    expect(code).toBe(0)
  })

  it('leaves a staging-train repo untouched — guard inert on the default model', () => {
    // No release: block → staging-train. The guard must not fire; preflight then
    // proceeds to its staging git ops (which fail in this non-repo dir — that is
    // fine, the point is only that trunk_mode is NOT emitted).
    const { out } = runPreflight('runtime: bun\n')
    expect(out).not.toContain('status=trunk_mode')
  })

  it('trunk WITH a staging branch → opens the create-PR path (trunk_promote_pr), not a blanket no-op (#371 B1)', () => {
    // The narrowed guard (B1): a repo mid-transition that keeps `staging` must
    // still be able to open the staging→main merge PR — auto-release.yml tags on
    // merge. Falsifiable: reverting to the blanket `status=trunk_mode; exit 0`
    // guard makes this emit trunk_mode and never reach the fall-through line.
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'))
    dirs.push(dir)
    const env = {
      ...cleanEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    }
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env })
    spawnSync('git', ['branch', 'staging'], { cwd: dir, env })
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'stack.yml'), 'release:\n  model: trunk\n  component: x\n')
    const r = spawnSync('bash', [PREFLIGHT_SH], { cwd: dir, encoding: 'utf8', env })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    // Fell through to the create-PR flow (the informational line is printed before
    // the later staging fetch fails in this origin-less repo).
    expect(out).toContain('status=trunk_promote_pr')
    expect(out).not.toContain('status=trunk_mode')
  })
})
