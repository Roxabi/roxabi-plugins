import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #495 acceptance: both tail skills resolve their helpers inside omp-build.
 *
 * Integration, not unit: every probe here forks bash or git, and vitest.setup.ts
 * fails a unit test that forks (#502).
 */
const SKILLS = path.resolve(import.meta.dirname, '..', '..')
const PLUGIN = path.resolve(SKILLS, '..')
const ANALYZE = path.join(SKILLS, 'cleanup', 'analyze-branches.sh')
const GATHER = path.join(SKILLS, 'cleanup', 'gather-state.sh')
const CREATE_PR = path.join(SKILLS, 'promote', 'create-promote-pr.sh')

/**
 * Git reads GIT_DIR / GIT_WORK_TREE from the environment and they beat `cwd`.
 * Under a git hook — lefthook runs this suite on pre-push — they point at
 * whatever repository invoked the hook, so a probe would answer about the wrong
 * one (#532). Strip them, then force a fixture identity on top.
 */
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

/** A throwaway repo with `origin/staging` and `origin/main` as remote-tracking refs. */
function fixtureRepo(bases: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-build-tail-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: FIXTURE_ENV, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'root')
  for (const base of bases) git('update-ref', `refs/remotes/origin/${base}`, 'HEAD')
  return dir
}

/** Every `.sh` shipped by the two tail skills, discovered — never enumerated by
 *  hand, or a script added later escapes the containment check below. */
const TAIL_SCRIPTS = ['promote', 'cleanup'].flatMap((skill) =>
  readdirSync(path.join(SKILLS, skill), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
    .map((entry) => path.join(SKILLS, skill, entry.name)),
)

describe('tail skills resolve their helpers inside omp-build', () => {
  it('sources lib.sh from plugins/omp-build/skills/shared, proved by the trace', () => {
    // Read from the execution, not the source text: `bash -x` prints the `.`
    // command after expansion, so the assertion sees the path the process really
    // opened. Repointing the line at dev-core turns this red even though the
    // relative spelling `../shared/lib.sh` would be unchanged.
    const dir = fixtureRepo(['staging', 'main'])
    try {
      const r = spawnSync('bash', ['-x', ANALYZE, '--json', '--no-fetch'], {
        cwd: dir,
        env: FIXTURE_ENV,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
      expect(r.status).toBe(0)
      // Every absolute `…/lib.sh` token the traced process touched. Taking the
      // token rather than the line keeps `dirname "${BASH_SOURCE[0]}"` — traced
      // from inside lib.sh itself — in scope: it names the same file and must
      // resolve to the same place.
      const touched = new Set([...r.stderr.matchAll(/(\/\S*lib\.sh)\b/g)].map(([, p]) => path.resolve(p)))
      expect(touched.size).toBeGreaterThan(0)
      expect([...touched]).toEqual([path.join(SKILLS, 'shared', 'lib.sh')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the sourced detect_base_branch to pick the base', () => {
    // The helper is not merely loaded, it decides: with both remote bases present
    // the report must name `staging`, and with neither it must fall back to
    // `main`. A stubbed-out lib.sh passes the trace check above and fails here.
    for (const [bases, expected] of [
      [['staging', 'main'], 'staging'],
      [[], 'main'],
    ] as const) {
      const dir = fixtureRepo([...bases])
      try {
        const out = execFileSync('bash', [ANALYZE, '--json', '--no-fetch'], {
          cwd: dir,
          env: FIXTURE_ENV,
          encoding: 'utf8',
        })
        expect(JSON.parse(out).base_branch).toBe(expected)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('reaches its sibling scripts from gather-state and create-promote-pr', () => {
    // Both wrappers resolve a sibling through `$SCRIPT_DIR`, and both degrade
    // rather than crash when it is missing — so a broken path would go unnoticed
    // in normal output. Assert the resolved siblings exist where the wrappers
    // look for them, and that each wrapper still names the one it needs.
    const gather = readFileSync(GATHER, 'utf8')
    const createPr = readFileSync(CREATE_PR, 'utf8')
    expect(gather).toContain('scan-orphan-worktree-shells.sh')
    expect(createPr).toContain('collect-closing-issues.sh')
    for (const sibling of [
      path.join(SKILLS, 'cleanup', 'scan-orphan-worktree-shells.sh'),
      path.join(SKILLS, 'promote', 'collect-closing-issues.sh'),
      path.join(SKILLS, 'promote', 'lib', 'hotfix-density.ts'),
      path.join(SKILLS, 'promote', 'lib', 'closing-issues-cli.ts'),
      path.join(SKILLS, 'promote', 'lib', 'finalize.ts'),
    ]) {
      expect(statSync(sibling).isFile()).toBe(true)
    }
  })

  it('never resolves a path out of the plugin', () => {
    // ADR-020 §3: uninstall every sibling plugin and omp-build still works. A
    // `../../` in a skill script escapes `skills/`, and one more escapes the
    // plugin — which is how a snapshot silently keeps eating from its source.
    const escaping: string[] = []
    for (const script of TAIL_SCRIPTS) {
      for (const [, ref] of readFileSync(script, 'utf8').matchAll(/\$\{?SCRIPT_DIR\}?(\/[^"'\s]*)/g)) {
        const resolved = path.resolve(path.dirname(script), `.${ref}`)
        if (!resolved.startsWith(`${PLUGIN}${path.sep}`)) escaping.push(`${path.basename(script)} → ${ref}`)
      }
    }
    expect(escaping).toEqual([])
  })
})

describe('analyze-branches.sh cannot act on the principal', () => {
  /** Principal on `main`, a linked worktree on a merged feature branch. */
  function principalAndWorktree(): { principal: string; linked: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'omp-build-principal-'))
    const principal = path.join(root, 'repo')
    const linked = path.join(root, 'wt')
    mkdirSync(principal)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: principal, env: FIXTURE_ENV, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(principal, 'README.md'), 'base\n')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'chore: base')
    git('checkout', '-q', '-b', 'feat/19-auth')
    git('commit', '-q', '--allow-empty', '-m', 'feat: auth (#19)')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', 'feat/19-auth', '-m', 'Merge pull request #19 from feat/19-auth')
    git('worktree', 'add', '-q', linked, 'feat/19-auth')
    return { principal, linked }
  }

  it('never offers the principal’s branch for deletion, even when it is fully merged', () => {
    // Run from the linked worktree — the normal posture. `main` is the principal's
    // branch and is trivially "merged into itself", so an analyser that classified
    // it would hand the operator a `git branch -d main`. Protected branches are
    // dropped before classification; delete that filter and this goes red.
    const { principal, linked } = principalAndWorktree()
    try {
      const out = execFileSync('bash', [ANALYZE, '--json', '--no-fetch'], {
        cwd: linked,
        env: FIXTURE_ENV,
        encoding: 'utf8',
      })
      const report = JSON.parse(out)
      expect(report.safe_local).not.toContain('main')
      expect(report.local_branches.map((b: { name: string }) => b.name)).not.toContain('main')
      // The principal is still *reported* — cleanup must be able to show it as the
      // worktree to keep; it is classification for deletion that is out of reach.
      expect(report.worktrees.map((w: { path: string }) => w.path)).toContain(principal)
    } finally {
      rmSync(path.dirname(principal), { recursive: true, force: true })
    }
  })

  it('carries no deletion command at all', () => {
    // The Step 4 confirmation is the only gate before a delete, and it lives in
    // SKILL.md — which means the analyser must not be able to delete on its own,
    // whatever the operator answered.
    const src = readFileSync(ANALYZE, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    for (const verb of [/git\s+branch\s+-[dD]\b/, /push\s+\S*\s*--delete\b/, /worktree\s+remove\b/, /\brm\s+-rf\b/]) {
      expect(src).not.toMatch(verb)
    }
  })
})
