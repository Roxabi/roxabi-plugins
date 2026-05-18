import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

// ─── Tool availability (module-level, for skipIf) ────────────────────────────

const gitAvailable: boolean = (() => {
  try {
    execSync('command -v git', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const bunAvailable: boolean = (() => {
  try {
    execSync('bun --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const shellcheckAvailable: boolean = (() => {
  try {
    execSync('command -v shellcheck', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

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

// Isolate tmp-repo git operations from the developer's environment:
// (1) scrub GIT_* env vars so a parent git process (e.g. pre-push hook setting
//     GIT_DIR/GIT_WORK_TREE on the outer push) doesn't hijack subprocess git calls
// (2) point GIT_CONFIG_GLOBAL/SYSTEM at /dev/null so global config (e.g. gpg
//     signing requiring an agent that isn't reachable in subprocess context)
//     doesn't leak into the test's throwaway commits
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, env: CLEAN_ENV })
}

function initGitRepo(dir: string): void {
  git('git init -q', dir)
  git('git add -A', dir)
  git('git -c user.email=t@t -c user.name=t commit -q -m init', dir)
}

// Run scaffold compose via spawnSync (avoids shell-quoting issues with JSON args)
function runCompose(ctx: ProjectContext, mode: 'setup' | 'teardown'): string {
  const ctxJson = JSON.stringify(ctx)
  const result = spawnSync(
    'bun',
    [SCAFFOLD_TS, 'compose', '--checklist', REAL_CHECKLIST, '--context-json', ctxJson, '--mode', mode],
    { encoding: 'utf-8', env: CLEAN_ENV },
  )
  if (result.status !== 0) {
    throw new Error(`compose failed: ${result.stderr}`)
  }
  return result.stdout
}

// ─── T8 — python.uv fixture integration ─────────────────────────────────────

describe('python.uv fixture integration', () => {
  let tmpMain: string
  let tmpWt: string

  afterEach(() => {
    if (tmpWt && fs.existsSync(tmpWt)) {
      try {
        execSync(`git worktree remove --force "${tmpWt}"`, { cwd: tmpMain, stdio: 'ignore', env: CLEAN_ENV })
      } catch {
        /* ignore */
      }
    }
    if (tmpMain && fs.existsSync(tmpMain)) {
      fs.rmSync(tmpMain, { recursive: true, force: true })
    }
  })

  const pythonUvCtx: ProjectContext = {
    runtime: 'python',
    package_manager: 'uv',
    monorepo: false,
    hooks_tool: 'lefthook',
    env_files: ['.env'],
    database: 'none',
    backend_paths: [],
  }

  it.skipIf(!gitAvailable)('scaffolds and symlinks .venv in a fresh worktree', () => {
    tmpMain = makeTmpDir('wt-py-main-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'x')

    tmpWt = path.join(path.dirname(tmpMain), `wt-py-wt-${Date.now()}`)
    execSync(`git worktree add -q "${tmpWt}" -b feat/x-${Date.now()}`, { cwd: tmpMain, env: CLEAN_ENV })

    fs.mkdirSync(path.join(tmpWt, 'tools'), { recursive: true })
    const scriptContent = runCompose(pythonUvCtx, 'setup')
    const scriptPath = path.join(tmpWt, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    execSync('bash tools/worktree-setup.sh', { cwd: tmpWt, env: CLEAN_ENV })

    const stat = fs.lstatSync(path.join(tmpWt, '.venv'))
    expect(stat.isSymbolicLink()).toBe(true)

    const target = fs.readlinkSync(path.join(tmpWt, '.venv'))
    expect(target).toContain('.venv')
    expect(target).toContain(tmpMain)
  })

  it.skipIf(!gitAvailable)('script exits 0 when run inside main checkout (refuses self-symlink)', () => {
    tmpMain = makeTmpDir('wt-py-self-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'x')

    fs.mkdirSync(path.join(tmpMain, 'tools'), { recursive: true })
    const scriptContent = runCompose(pythonUvCtx, 'setup')
    const scriptPath = path.join(tmpMain, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    const result = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: tmpMain, env: CLEAN_ENV })
    expect(result.status).toBe(0)

    const markerStat = fs.statSync(path.join(tmpMain, '.venv', 'marker'))
    expect(markerStat.isFile()).toBe(true)
    const content = fs.readFileSync(path.join(tmpMain, '.venv', 'marker'), 'utf-8')
    expect(content).toBe('x')
  })

  it.skipIf(!gitAvailable)('skips when .venv exists as a real directory (preserves diverged-deps state)', () => {
    tmpMain = makeTmpDir('wt-py-realdir-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    // main repo needs a .venv for the guard to pass the "main .venv exists" check
    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'main')

    tmpWt = path.join(path.dirname(tmpMain), `wt-py-realdir-wt-${Date.now()}`)
    execSync(`git worktree add -q "${tmpWt}" -b feat/realdir-${Date.now()}`, { cwd: tmpMain, env: CLEAN_ENV })

    // worktree already has a real .venv directory with its own state
    fs.mkdirSync(path.join(tmpWt, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpWt, '.venv', 'diverged-marker'), 'wt-local')

    fs.mkdirSync(path.join(tmpWt, 'tools'), { recursive: true })
    const scriptContent = runCompose(pythonUvCtx, 'setup')
    const scriptPath = path.join(tmpWt, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    execSync('bash tools/worktree-setup.sh', { cwd: tmpWt, env: CLEAN_ENV })

    const stat = fs.lstatSync(path.join(tmpWt, '.venv'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)

    // marker file must be untouched — real dir was not replaced
    const markerContent = fs.readFileSync(path.join(tmpWt, '.venv', 'diverged-marker'), 'utf-8')
    expect(markerContent).toBe('wt-local')
  })

  it.skipIf(!gitAvailable)('replaces stale symlink pointing nowhere with a fresh symlink', () => {
    tmpMain = makeTmpDir('wt-py-stale-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'main')

    tmpWt = path.join(path.dirname(tmpMain), `wt-py-stale-wt-${Date.now()}`)
    execSync(`git worktree add -q "${tmpWt}" -b feat/stale-${Date.now()}`, { cwd: tmpMain, env: CLEAN_ENV })

    // pre-existing stale symlink pointing to a non-existent path
    fs.symlinkSync('/tmp/does-not-exist-ever', path.join(tmpWt, '.venv'))

    fs.mkdirSync(path.join(tmpWt, 'tools'), { recursive: true })
    const scriptContent = runCompose(pythonUvCtx, 'setup')
    const scriptPath = path.join(tmpWt, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(scriptPath, scriptContent)
    fs.chmodSync(scriptPath, 0o755)

    execSync('bash tools/worktree-setup.sh', { cwd: tmpWt, env: CLEAN_ENV })

    const stat = fs.lstatSync(path.join(tmpWt, '.venv'))
    expect(stat.isSymbolicLink()).toBe(true)

    const target = fs.readlinkSync(path.join(tmpWt, '.venv'))
    expect(target).toBe(path.join(tmpMain, '.venv'))
  })

  it.skipIf(!gitAvailable)('teardown removes the .venv symlink but leaves a real .venv untouched', () => {
    tmpMain = makeTmpDir('wt-py-teardown-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'python-uv'), tmpMain)
    initGitRepo(tmpMain)

    fs.mkdirSync(path.join(tmpMain, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpMain, '.venv', 'marker'), 'main')

    tmpWt = path.join(path.dirname(tmpMain), `wt-py-teardown-wt-${Date.now()}`)
    execSync(`git worktree add -q "${tmpWt}" -b feat/teardown-${Date.now()}`, { cwd: tmpMain, env: CLEAN_ENV })

    fs.mkdirSync(path.join(tmpWt, 'tools'), { recursive: true })

    // Run setup first to create the symlink
    const setupContent = runCompose(pythonUvCtx, 'setup')
    const setupPath = path.join(tmpWt, 'tools', 'worktree-setup.sh')
    fs.writeFileSync(setupPath, setupContent)
    fs.chmodSync(setupPath, 0o755)
    execSync('bash tools/worktree-setup.sh', { cwd: tmpWt, env: CLEAN_ENV })

    // Confirm symlink exists before teardown
    expect(fs.lstatSync(path.join(tmpWt, '.venv')).isSymbolicLink()).toBe(true)

    // Run teardown — should remove the symlink
    const teardownContent = runCompose(pythonUvCtx, 'teardown')
    const teardownPath = path.join(tmpWt, 'tools', 'worktree-teardown.sh')
    fs.writeFileSync(teardownPath, teardownContent)
    fs.chmodSync(teardownPath, 0o755)
    execSync('bash tools/worktree-teardown.sh', { cwd: tmpWt, env: CLEAN_ENV })

    expect(fs.existsSync(path.join(tmpWt, '.venv'))).toBe(false)

    // Real .venv in main checkout must be untouched
    expect(fs.existsSync(path.join(tmpMain, '.venv'))).toBe(true)
    const markerContent = fs.readFileSync(path.join(tmpMain, '.venv', 'marker'), 'utf-8')
    expect(markerContent).toBe('main')
  })

  it.skipIf(!shellcheckAvailable)('compose output is shellcheck-clean', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(pythonUvCtx, checklist)
    const script = composeScript(selected, 'setup')

    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // shellcheck emits nothing to stdout when the script is clean
    expect(result).toBe('')
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

  it.skipIf(!gitAvailable || !bunAvailable)('re-running script in same worktree is idempotent (no errors)', () => {
    tmpDir = makeTmpDir('wt-bun-mono-')
    copyDirRecursive(path.join(FIXTURES_ROOT, 'bun-monorepo'), tmpDir)
    initGitRepo(tmpDir)

    const wtPath = path.join(path.dirname(tmpDir), `wt-bun-wt-${Date.now()}`)
    execSync(`git worktree add -q "${wtPath}" -b feat/bun-${Date.now()}`, { cwd: tmpDir, env: CLEAN_ENV })

    try {
      fs.mkdirSync(path.join(wtPath, 'tools'), { recursive: true })
      const scriptContent = runCompose(bunNeonCtx, 'setup')
      const scriptPath = path.join(wtPath, 'tools', 'worktree-setup.sh')
      fs.writeFileSync(scriptPath, scriptContent)
      fs.chmodSync(scriptPath, 0o755)

      const run1 = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: wtPath, env: CLEAN_ENV })
      expect(run1.status).toBe(0)

      const run2 = spawnSync('bash', ['tools/worktree-setup.sh'], { cwd: wtPath, env: CLEAN_ENV })
      expect(run2.status).toBe(0)
    } finally {
      try {
        execSync(`git worktree remove --force "${wtPath}"`, { cwd: tmpDir, stdio: 'ignore', env: CLEAN_ENV })
      } catch {
        /* ignore */
      }
    }
  })

  it.skipIf(!shellcheckAvailable)('compose teardown is shellcheck-clean', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(bunNeonCtx, checklist)
    const script = composeScript(selected, 'teardown')

    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // shellcheck emits nothing to stdout when the script is clean
    expect(result).toBe('')
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
