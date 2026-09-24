import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// ─── Paths ───────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const EXCLUDE_PATHS = path.join(REPO_ROOT, 'scripts/trufflehog-exclude-paths.txt')

// This repo's own hook, and the copy dev-init seeds into every fleet repo
// (seed-trufflehog.ts). The fix once landed in the first only, so the fleet kept
// committing empty trees from linked worktrees.
const SCRIPTS = {
  'scripts/trufflehog-check.sh': path.join(REPO_ROOT, 'scripts/trufflehog-check.sh'),
  'plugins/dev-core/scripts/trufflehog-check.sh': path.join(
    REPO_ROOT,
    'plugins/dev-core/scripts/trufflehog-check.sh',
  ),
}

// ─── Clean env (isolate from the outer git context) ──────────────────────────

const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = CLEAN_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
}

/**
 * A repo whose HEAD is ahead of its base branch, so the commit-range scan (the
 * branch that shells out to a clone) actually runs. `argvLog` records every
 * invocation of the stubbed scanner.
 */
function makeRepo(script: string): { dir: string; argvLog: string; fakeBin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-index-'))
  tmpDirs.push(dir)

  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  fs.writeFileSync(path.join(dir, 'kept.txt'), 'base\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'chore: base'], dir)

  // main stays here; HEAD moves ahead → detect_base_ref resolves to `main`
  git(['checkout', '-q', '-b', 'feature'], dir)
  fs.writeFileSync(path.join(dir, 'ahead.txt'), 'ahead\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'chore: ahead'], dir)

  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(script, path.join(dir, 'scripts/trufflehog-check.sh'))
  fs.chmodSync(path.join(dir, 'scripts/trufflehog-check.sh'), 0o755)
  fs.copyFileSync(EXCLUDE_PATHS, path.join(dir, 'scripts/trufflehog-exclude-paths.txt'))

  // Stub scanner. The real trufflehog clones `file://…` for its git source; the
  // clone is the subprocess that inherits our git env, so the stub clones too.
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'th-bin-'))
  tmpDirs.push(fakeBin)
  const argvLog = path.join(fakeBin, 'argv.log')
  fs.writeFileSync(
    path.join(fakeBin, 'trufflehog'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
      'if [ "$1" = "git" ]; then',
      '  url=$2',
      '  dest=$(mktemp -d)',
      '  git clone --quiet "${url#file://}" "$dest" >/dev/null 2>&1 || true',
      '  rm -rf "$dest"',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  )

  return { dir, argvLog, fakeBin }
}

function runCheck(repo: { dir: string; fakeBin: string }): { code: number; stderr: string } {
  const result = spawnSync('bash', ['scripts/trufflehog-check.sh'], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: {
      ...CLEAN_ENV,
      PATH: `${repo.fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      // Exactly what git exports to a hook inside a linked worktree: an
      // ABSOLUTE path to the index of the commit in flight.
      GIT_INDEX_FILE: path.join(repo.dir, '.git/index'),
    },
  })
  return { code: result.status ?? -1, stderr: result.stderr ?? '' }
}

// ─── The contract ────────────────────────────────────────────────────────────

describe.each(Object.entries(SCRIPTS))('%s', (_name, script) => {
  it('leaves the staged index untouched when the scanner shells out to git', () => {
    const repo = makeRepo(script)
    fs.writeFileSync(path.join(repo.dir, 'kept.txt'), 'staged change\n')
    git(['add', 'kept.txt'], repo.dir)

    expect(git(['diff', '--cached', '--name-only'], repo.dir)).toBe('kept.txt')

    const { code } = runCheck(repo)
    expect(code).toBe(0)

    // Pre-fix this is empty: the nested clone inherited GIT_INDEX_FILE and wrote
    // its own index over ours, so the commit in flight would land empty.
    expect(git(['diff', '--cached', '--name-only'], repo.dir)).toBe('kept.txt')
  })

  it('still scans the staged files after the git env is stripped', () => {
    const repo = makeRepo(script)
    fs.writeFileSync(path.join(repo.dir, 'kept.txt'), 'staged change\n')
    git(['add', 'kept.txt'], repo.dir)

    runCheck(repo)

    const argv = fs.readFileSync(repo.argvLog, 'utf8')
    expect(argv).toMatch(/^git file:\/\//m)
    expect(argv).toMatch(/^filesystem .*kept\.txt$/m)
  })
})
