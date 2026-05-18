import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  composeScript,
  type ProjectContext,
  parseChecklist,
  selectConcerns,
  shouldOfferRetrofit,
} from '../worktreeScaffold'

// ─── Paths ───────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const REAL_CHECKLIST = path.join(REPO_ROOT, 'plugins/dev-core/references/worktree-setup-checklist.md')
const FIXTURES_ROOT = path.join(import.meta.dirname, '__fixtures__/projects')
const SCAFFOLD_TS = path.join(REPO_ROOT, 'plugins/dev-core/tools/worktreeScaffold.ts')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function gitAvailable(): boolean {
  try {
    execSync('command -v git', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function bunAvailable(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let shellcheckAvailable = false

beforeAll(() => {
  try {
    execSync('command -v shellcheck', { stdio: 'ignore' })
    shellcheckAvailable = true
  } catch {
    shellcheckAvailable = false
  }
})

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir })
  execSync('git add -A', { cwd: dir })
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: dir })
}

// ─── T8 — python.uv fixture integration ─────────────────────────────────────

describe('python.uv fixture integration', () => {
  let tmpMain: string
  let tmpWt: string

  afterEach(() => {
    if (tmpWt && fs.existsSync(tmpWt)) {
      try {
        execSync(`git worktree remove --force "${tmpWt}"`, { cwd: tmpMain, stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }
    if (tmpMain && fs.existsSync(tmpMain)) {
      fs.rmSync(tmpMain, { recursive: true, force: true })
    }
  })

  it('scaffolds and symlinks .venv in a fresh worktree', () => {
    if (!gitAvailable()) return

    tmpMain = makeTmpDir('wt-py-main-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'x')

    tmpWt = path.join(path.dirname(tmpMain), `wt-py-wt-${Date.now()}`)
    execSync(`git worktree add -q "${tmpWt}" -b feat/x-${Date.now()}`, { cwd: tmpMain })

    const ctx: ProjectContext = {
      runtime: 'python',
      package_manager: 'uv',
      monorepo: false,
      hooks_tool: 'lefthook',
      env_files: ['.env'],
      database: 'none',
      backend_paths: [],
    }
    const ctxJson = JSON.stringify(ctx)

    fs.mkdirSync(path.join(tmpWt, 'tools'), { recursive: true })
    const scriptContent = execSync(
      `bun "${SCAFFOLD_TS}" compose --checklist "${REAL_CHECKLIST}" --context-json '${ctxJson}' --mode setup`,
      { encoding: 'utf-8' },
    )
    const scriptPath = path.join(tmpWt, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    execSync('bash tools/worktree-setup.sh', { cwd: tmpWt })

    const stat = fs.lstatSync(path.join(tmpWt, '.venv'))
    expect(stat.isSymbolicLink()).toBe(true)

    const target = fs.readlinkSync(path.join(tmpWt, '.venv'))
    expect(target).toContain('.venv')
    expect(target).toContain(tmpMain)
  })

  it('script exits 0 when run inside main checkout (refuses self-symlink)', () => {
    if (!gitAvailable()) return

    tmpMain = makeTmpDir('wt-py-self-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'x')

    const ctx: ProjectContext = {
      runtime: 'python',
      package_manager: 'uv',
      monorepo: false,
      hooks_tool: 'lefthook',
      env_files: ['.env'],
      database: 'none',
      backend_paths: [],
    }
    const ctxJson = JSON.stringify(ctx)

    fs.mkdirSync(path.join(tmpMain, 'tools'), { recursive: true })
    const scriptContent = execSync(
      `bun "${SCAFFOLD_TS}" compose --checklist "${REAL_CHECKLIST}" --context-json '${ctxJson}' --mode setup`,
      { encoding: 'utf-8' },
    )
    const scriptPath = path.join(tmpMain, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    const result = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: tmpMain })
    expect(result.status).toBe(0)

    const markerStat = fs.statSync(path.join(tmpMain, '.venv', 'marker'))
    expect(markerStat.isFile()).toBe(true)
    const content = fs.readFileSync(path.join(tmpMain, '.venv', 'marker'), 'utf-8')
    expect(content).toBe('x')
  })

  it('compose output is shellcheck-clean', () => {
    if (!shellcheckAvailable) return

    const checklist = parseChecklist(REAL_CHECKLIST)
    const ctx: ProjectContext = {
      runtime: 'python',
      package_manager: 'uv',
      monorepo: false,
      hooks_tool: 'lefthook',
      env_files: ['.env'],
      database: 'none',
      backend_paths: [],
    }
    const selected = selectConcerns(ctx, checklist)
    const script = composeScript(selected, 'setup')

    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(result).toBeDefined()
  })
})

// ─── T9 — bun.monorepo+neon fixture integration ──────────────────────────────

describe('bun.monorepo+neon fixture integration', () => {
  let tmpDir: string

  const bunNeonCtx: ProjectContext = {
    runtime: 'bun',
    package_manager: 'bun',
    monorepo: true,
    hooks_tool: 'lefthook',
    env_files: ['.env'],
    database: 'neon',
    backend_paths: ['apps/api'],
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('selects expected concerns for monorepo+neon ctx', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(bunNeonCtx, checklist)
    const ids = new Set(selected.map((c) => c.id))

    expect(ids.has('env-files')).toBe(true)
    expect(ids.has('bun-install-warmup')).toBe(true)
    expect(ids.has('lefthook-hookspath-fix')).toBe(true)
    expect(ids.has('neon-db-branch')).toBe(true)

    expect(ids.has('uv-venv-symlink')).toBe(false)
    expect(ids.has('npm-install-warmup')).toBe(false)
  })

  it('generated script contains expected concern bodies', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(bunNeonCtx, checklist)
    const script = composeScript(selected, 'setup')

    expect(script).toContain('bun install')
    expect(script).toContain('git config --unset-all core.hooksPath')
    expect(script).toContain('db:branch:create')
    expect(script).toContain('cp .env.example .env')
  })

  it('re-running script in same worktree is idempotent (no errors)', () => {
    if (!gitAvailable()) return
    if (!bunAvailable()) return

    tmpDir = makeTmpDir('wt-bun-mono-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'bun-monorepo'), tmpDir)
    initGitRepo(tmpDir)

    const wtPath = path.join(path.dirname(tmpDir), `wt-bun-wt-${Date.now()}`)
    execSync(`git worktree add -q "${wtPath}" -b feat/bun-${Date.now()}`, { cwd: tmpDir })

    try {
      const ctxJson = JSON.stringify(bunNeonCtx)
      fs.mkdirSync(path.join(wtPath, 'tools'), { recursive: true })
      const scriptContent = execSync(
        `bun "${SCAFFOLD_TS}" compose --checklist "${REAL_CHECKLIST}" --context-json '${ctxJson}' --mode setup`,
        { encoding: 'utf-8' },
      )
      const scriptPath = path.join(wtPath, 'tools', 'worktree-setup.sh')
      fs.writeFileSync(scriptPath, scriptContent)
      fs.chmodSync(scriptPath, 0o755)

      const run1 = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: wtPath })
      expect(run1.status).toBe(0)

      const run2 = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: wtPath })
      expect(run2.status).toBe(0)
    } finally {
      try {
        execSync(`git worktree remove --force "${wtPath}"`, { cwd: tmpDir, stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }
  })

  it('compose teardown is shellcheck-clean', () => {
    if (!shellcheckAvailable) return

    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(bunNeonCtx, checklist)
    const script = composeScript(selected, 'teardown')

    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(result).toBeDefined()
  })
})

// ─── T10 — env-setup retrofit detection ──────────────────────────────────────

describe('env-setup retrofit detection', () => {
  const FIXTURE_PATH = path.join(FIXTURES_ROOT, 'retrofit-bun')
  const STACK_YML_PATH = path.join(FIXTURE_PATH, '.claude/stack.yml')
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns true for fresh bun project without hook', () => {
    const content = fs.readFileSync(STACK_YML_PATH, 'utf-8')
    expect(shouldOfferRetrofit(content, FIXTURE_PATH)).toBe(true)
  })

  it('returns false when stack.yml has worktree_setup key', () => {
    const content = `${fs.readFileSync(STACK_YML_PATH, 'utf-8')}\n  worktree_setup: tools/worktree-setup.sh\n`
    expect(shouldOfferRetrofit(content, FIXTURE_PATH)).toBe(false)
  })

  it('returns false when tools/worktree-setup.sh already exists', () => {
    tmpDir = makeTmpDir('retrofit-detect-')
    copyDirRecursive(FIXTURE_PATH, tmpDir)

    fs.mkdirSync(path.join(tmpDir, 'tools'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'tools', 'worktree-setup.sh'), '#!/usr/bin/env bash\n')

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'stack.yml'), 'utf-8')
    expect(shouldOfferRetrofit(content, tmpDir)).toBe(false)
  })

  it('returns false for unsupported runtime', () => {
    const original = fs.readFileSync(STACK_YML_PATH, 'utf-8')
    const patched = original.replace(/^runtime:\s*\S+/m, 'runtime: rust')
    expect(shouldOfferRetrofit(patched, FIXTURE_PATH)).toBe(false)
  })
})
