import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * A git hook runs this suite with the env git exports to it: from a linked
 * worktree that includes GIT_DIR=<repo>/.git/worktrees/<id>; from the principal
 * checkout, no GIT_DIR at all. Both guards live in the suite's setup files, so
 * the only way to observe them is to run vitest under that env, here against a
 * decoy repository.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Inside node_modules: the fixtures resolve `vitest`, and the repo suite never collects them.
const scratch = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.git-hook-env-'))
const decoys = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-env-'))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.rmSync(decoys, { recursive: true, force: true })
})

// Free of every GIT_* the caller had, so no command here can reach the real repository.
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

// Takes setupFiles and globalSetup from the repo's own vitest.config.ts, so a
// guard dropped from that registration fails here as well.
const CONFIG = path.join(scratch, 'vitest.fixture.config.ts')
fs.writeFileSync(
  CONFIG,
  [
    "import * as path from 'node:path'",
    "import { defineConfig } from 'vitest/config'",
    `import repo from ${JSON.stringify(path.join(ROOT, 'vitest.config.ts'))}`,
    'const [setupFiles, globalSetup] = [repo.test.setupFiles, repo.test.globalSetup].map((files) =>',
    `  [files ?? []].flat().map((file) => path.resolve(${JSON.stringify(ROOT)}, file)),`,
    ')',
    'export default defineConfig({',
    '  test: {',
    `    root: ${JSON.stringify(scratch)},`,
    '    setupFiles,',
    '    globalSetup,',
    '  },',
    '})',
    '',
  ].join('\n'),
)
// The repo's own binary: `bunx` outside the repo would fetch vitest instead.
const VITEST = path.join(ROOT, 'node_modules', '.bin', 'vitest')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: CLEAN_ENV,
    encoding: 'utf8',
  }).trim()
}

/** A principal checkout plus one linked worktree: the layout a hook fired from that worktree sees. */
function decoy(name: string): { principal: string; config: string; hookGitDir: string } {
  const principal = path.join(decoys, name)
  git(decoys, ['init', '-q', '-b', 'main', principal])
  git(principal, ['commit', '-q', '--allow-empty', '-m', 'base'])
  git(principal, ['worktree', 'add', '-q', '-b', 'wt', path.join(decoys, `${name}-wt`)])
  return {
    principal,
    config: path.join(principal, '.git', 'config'),
    hookGitDir: path.join(principal, '.git', 'worktrees', `${name}-wt`),
  }
}

/** Runs the fixture files matching `filter` from `cwd`, with the GIT_* the hook exports. */
function runSuite(filter: string, cwd: string, hookEnv: NodeJS.ProcessEnv): { failed: boolean; output: string } {
  try {
    const output = execFileSync(VITEST, ['run', '--config', CONFIG, filter], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...CLEAN_ENV, ...hookEnv, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    return { failed: false, output }
  } catch (error) {
    const shape = error as { stdout?: string; stderr?: string }
    return { failed: true, output: `${shape.stdout ?? ''}${shape.stderr ?? ''}` }
  }
}

describe('a test suite run by a hook from a linked worktree', () => {
  it('lets a fixture that spreads the inherited env initialise its own repository', () => {
    const { config, hookGitDir } = decoy('inherits')
    const work = path.join(scratch, 'work')
    fs.writeFileSync(
      path.join(scratch, 'inherits.integration.test.ts'),
      [
        "import { execFileSync } from 'node:child_process'",
        "import { existsSync } from 'node:fs'",
        "import { expect, it } from 'vitest'",
        "it('inits a fixture repository', () => {",
        `  execFileSync('git', ['init', '-q', ${JSON.stringify(work)}])`,
        `  expect(existsSync(${JSON.stringify(path.join(work, '.git'))})).toBe(true)`,
        '})',
        '',
      ].join('\n'),
    )

    const run = runSuite('inherits', ROOT, { GIT_DIR: hookGitDir })

    // Under the hook's GIT_DIR, this `git init` reinitialises the worktree's git
    // dir instead, and git takes that path for a bare repository.
    expect(git(decoys, ['config', '--file', config, '--type=bool', '--get', 'core.bare'])).toBe('false')
    expect(run.output).toMatch(/1 passed/)
    expect(run.failed).toBe(false)
  })

  it('fails when core.bare of the hook repository changed during the run, and names the repair', () => {
    const { config, hookGitDir } = decoy('rewrites')
    fs.writeFileSync(
      path.join(scratch, 'rewrites.integration.test.ts'),
      [
        "import { execFileSync } from 'node:child_process'",
        "import { it } from 'vitest'",
        "it('rewrites the shared config', () => {",
        `  execFileSync('git', ['config', '--file', ${JSON.stringify(config)}, 'core.bare', 'true'])`,
        '})',
        '',
      ].join('\n'),
    )

    const run = runSuite('rewrites', ROOT, { GIT_DIR: hookGitDir })

    // The test itself passes: the failure is the run's, raised after it.
    expect(run.output).toMatch(/1 passed/)
    expect(run.failed).toBe(true)
    expect(run.output).toContain(`git config --file ${config} core.bare false`)
  })
})

describe('a test suite run by a hook from the principal checkout', () => {
  it('fails when core.bare of the checkout it runs in changed during the run', () => {
    const { principal, config } = decoy('principal')
    fs.writeFileSync(
      path.join(scratch, 'principal.integration.test.ts'),
      [
        "import { execFileSync } from 'node:child_process'",
        "import { it } from 'vitest'",
        "it('rewrites the checkout config', () => {",
        `  execFileSync('git', ['config', '--file', ${JSON.stringify(config)}, 'core.bare', 'true'])`,
        '})',
        '',
      ].join('\n'),
    )

    // No GIT_DIR: git finds the repository from the hook's working directory.
    const run = runSuite('principal', principal, {})

    expect(run.output).toContain('Tests  1 passed (1)')
    expect(run.failed).toBe(true)
    expect(run.output).toContain(`git config --file ${config} core.bare false`)
  })
})
