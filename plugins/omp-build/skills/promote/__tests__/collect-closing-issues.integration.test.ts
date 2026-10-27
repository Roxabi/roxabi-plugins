import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const COLLECT = fileURLToPath(new URL('../collect-closing-issues.sh', import.meta.url))
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'GH_REPO'),
    ),
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  }
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): void {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function promotionFixture(): { cwd: string; bin: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'collect-closing-issues-'))
  fixtures.push(root)
  const cwd = join(root, 'worktree')
  const bin = join(root, 'bin')
  const log = join(root, 'gh.log')
  const env = fixtureEnv()
  mkdirSync(cwd)
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
if [ "$1" = 'pr' ] && [ "$2" = 'list' ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = 'issue' ] && [ "$2" = 'view' ] && [ "$3" = '42' ]; then
  printf '%s\\n' "\${GH_REPO-unset}" >>"$GH_LOG"
  if [ -n "\${GH_REPO-}" ]; then printf 'CLOSED\\n'; else printf 'OPEN\\n'; fi
  exit 0
fi
exit 64
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  git(cwd, env, ['init', '--quiet', '--initial-branch=main'])
  git(cwd, env, ['config', 'user.email', 'fixture@example.com'])
  git(cwd, env, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(cwd, 'fixture.txt'), 'main\n')
  git(cwd, env, ['add', 'fixture.txt'])
  git(cwd, env, ['commit', '--quiet', '-m', 'base'])
  git(cwd, env, ['checkout', '--quiet', '-b', 'staging'])
  writeFileSync(join(cwd, 'fixture.txt'), 'staging\n')
  git(cwd, env, ['add', 'fixture.txt'])
  git(cwd, env, ['commit', '--quiet', '-m', 'collector regression', '-m', 'Closes #42'])
  writeFileSync(join(cwd, '.env'), 'GH_REPO=foreign/repo\n')
  return { cwd, bin, log, env }
}

describe('collect-closing-issues.sh environment isolation', () => {
  it.each([
    ['does not load a worktree .env into gh', undefined, '42\n', 'unset\n'],
    ['honors an explicit caller GH_REPO', 'caller/repo', '', 'caller/repo\n'],
  ])('%s', (_name, callerRepo, stdout, ghLog) => {
    const fixture = promotionFixture()
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      PATH: `${fixture.bin}:${fixture.env.PATH ?? ''}`,
      GH_LOG: fixture.log,
    }
    if (callerRepo !== undefined) env.GH_REPO = callerRepo
    const result = spawnSync('bash', [COLLECT, 'main', 'staging', '--list'], {
      cwd: fixture.cwd,
      env,
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(stdout)
    expect(result.stderr).toBe('')
    expect(readFileSync(fixture.log, 'utf8')).toBe(ghLog)
  })
})
