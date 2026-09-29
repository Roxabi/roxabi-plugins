import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** GIT_DIR/GIT_WORK_TREE beat `cwd` and a hook exports them (#532) — strip them. */
export const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

export const SCAN = path.resolve(import.meta.dirname, '..', 'scan-orphan-worktree-shells.sh')

export function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...FIXTURE_ENV, HOME: home }, encoding: 'utf8' })
}

export function initRepo(dir: string, home: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, home, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), 'base\n')
  git(dir, home, 'add', 'README.md')
  git(dir, home, 'commit', '-q', '-m', 'chore: base')
}

export function commonDir(repo: string, home: string): string {
  return git(repo, home, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()
}

/** Scanner stdout, byte for byte — row forgery is only visible here. */
export function scanRaw(repo: string, env: NodeJS.ProcessEnv, args: string[] = []): string {
  return execFileSync('bash', [SCAN, ...args], {
    cwd: repo,
    env: { ...FIXTURE_ENV, ...env },
    encoding: 'utf8',
  })
}

export function scan(repo: string, env: NodeJS.ProcessEnv, args: string[] = []): string[] {
  return scanRaw(repo, env, args)
    .split('\n')
    .filter((line) => line.includes('|'))
}

export function scanStatus(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: scanRaw(repo, env, args), stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}
