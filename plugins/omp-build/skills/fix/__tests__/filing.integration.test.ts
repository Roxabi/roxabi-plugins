import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IsolateIssue, IsolateState } from './fixtures/github-isolate'

/**
 * Operators paste the Filing fence after `# write … then:` and the Initial
 * worktree preflight fence. Run those fences unchanged: no ellipsis repair,
 * no copied dispatcher. Triage is the real CLI. Mutations go through fetch
 * (REST and GraphQL); the isolate answers them and refuses any other host.
 */
const FIX = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const TRIAGE = path.resolve(import.meta.dirname, '../../../../issue-triage/skills/issue-triage/triage.ts')
const TRIAGE_SKILL = readFileSync(path.join(path.dirname(TRIAGE), 'SKILL.md'), 'utf8')
const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/github-isolate.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function sectionFence(heading: string, source = FIX): string {
  const start = source.indexOf(heading)
  if (start < 0) throw new Error(`${heading} missing from skill`)
  const rest = source.slice(start + heading.length)
  const next = rest.search(/\n### |\n## /)
  const section = next < 0 ? rest : rest.slice(0, next)
  const block = /```bash\n([\s\S]*?)```/.exec(section)?.[1]
  if (!block) throw new Error(`${heading} bash fence missing`)
  if (block.includes('...')) throw new Error(`${heading} fence still has an ellipsis`)
  return block.trim()
}

/** Policy lines after the write marker. The mktemp prefix is operator setup. */
function filingBlockAfterWrite(): string {
  const block = sectionFence('### Filing')
  const lines = block.split('\n')
  const idx = lines.findIndex((line) => /#\s*write\b.*\bthen\s*:/.test(line))
  if (idx < 0) throw new Error('Filing "# write … then:" marker missing')
  const tail = lines
    .slice(idx + 1)
    .join('\n')
    .trim()
  if (!tail) throw new Error('Filing block empty after write marker')
  return tail
}

function preflightBlock(): string {
  return sectionFence('### Initial worktree preflight')
}

function writeRealpathStub(bin: string, ok: boolean) {
  writeFileSync(
    path.join(bin, 'realpath'),
    ok
      ? `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "skill://issue-triage/triage.ts" ]; then
  printf '%s\\n' ${JSON.stringify(TRIAGE)}
  exit 0
fi
exec /usr/bin/realpath "$@"
`
      : `#!/usr/bin/env bash
echo "realpath: $1: No such file or directory" >&2
exit 1
`,
    { mode: 0o755 },
  )
}

function seed(number: number, extra: Partial<IsolateIssue> = {}): IsolateIssue {
  return {
    number,
    node_id: `NODE_${number}`,
    state: 'OPEN',
    title: `issue ${number}`,
    body: `body-${number}`,
    parent: null,
    blockedBy: [],
    labels: ['size:S'],
    type: null,
    ...extra,
  }
}

function emptyState(issues: IsolateIssue[] = [], extra: Partial<IsolateState> = {}): IsolateState {
  return {
    next: 1000,
    issues,
    failGraphQL: null,
    failView: [],
    failPatch: false,
    log: [],
    ...extra,
  }
}

type Facts = Record<string, string | undefined>

function facts(over: Facts = {}): Record<string, string> {
  const merged: Facts = {
    DISPOSITION: 'nonblocking',
    SOURCE_SIZE: 'S',
    SOURCE_TYPE: 'fix',
    SOURCE_ISSUE: '396',
    SOURCE_PARENT: '720',
    ACTIVE_EPIC: '720',
    EXISTING_ISSUE: '',
    ...over,
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function writePayload(dir: string, body = '**Origin:** PR #9\n\n## Acceptance criteria\n\n- [ ] item\n') {
  writeFileSync(path.join(dir, 'title.txt'), 'Deferred non-blocking review findings\n')
  writeFileSync(path.join(dir, 'body.md'), body)
}

function runFiling(
  factEnv: Record<string, string>,
  state: IsolateState,
  opts: {
    realpathOk?: boolean
    markerBun?: boolean
    prepare?: (fileDir: string) => void
    prepareRepo?: (repo: string) => void
    recipe?: 'fix' | 'triage'
  } = {},
): { status: number | null; stdout: string; stderr: string; state: IsolateState; marker?: string; repo: string } {
  root = mkdtempSync(path.join(tmpdir(), 'omp-fix-filing-'))
  const repo = initRepo(root)
  opts.prepareRepo?.(repo)
  const bin = path.join(root, 'bin')
  const fileDir = path.join(root, 'files')
  const statePath = path.join(root, 'github.json')
  mkdirSync(bin)
  mkdirSync(fileDir)
  writeFileSync(statePath, JSON.stringify(state))
  writeRealpathStub(bin, opts.realpathOk !== false)
  const marker = path.join(root, 'bun-ran')
  if (opts.markerBun) {
    writeFileSync(
      path.join(bin, 'bun'),
      `#!/usr/bin/env bash
printf ran > ${JSON.stringify(marker)}
exit 42
`,
      { mode: 0o755 },
    )
  } else {
    writeFileSync(
      path.join(bin, 'bun'),
      `#!/usr/bin/env bash
exec "$REAL_BUN" --preload "$GITHUB_ISOLATE_FIXTURE" "$@"
`,
      { mode: 0o755 },
    )
  }
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
exec "$REAL_BUN" "$GITHUB_ISOLATE_FIXTURE" --gh "$@"
`,
    { mode: 0o755 },
  )
  writePayload(fileDir)
  opts.prepare?.(fileDir)
  const script =
    opts.recipe === 'triage'
      ? `T() { bun "$TRIAGE_ENTRY" "$@"; }\n${sectionFence('**Recipe — defer A', TRIAGE_SKILL)}`
      : filingBlockAfterWrite()
  const result = spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${path.dirname(REAL_BUN)}:/usr/bin:/bin`,
      HOME: root,
      REAL_BUN,
      GITHUB_ISOLATE_FIXTURE: FIXTURE,
      TRIAGE_ENTRY: TRIAGE,
      GITHUB_ISOLATE_STATE: statePath,
      GITHUB_TOKEN: 'isolate',
      GITHUB_REPO: 'Acme/app',
      FILE_DIR: fileDir,
      ...factEnv,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    state: JSON.parse(readFileSync(statePath, 'utf8')) as IsolateState,
    marker,
    repo,
  }
}

function created(state: IsolateState): IsolateIssue[] {
  return state.issues.filter((issue) => issue.number >= 1000)
}

function posts(state: IsolateState): string[] {
  return state.log.filter((line) => line.startsWith('rest:POST'))
}

function relations(state: IsolateState): string[] {
  return state.log.filter((line) => line.startsWith('graphql:add') || line.startsWith('graphql:remove'))
}

function gitEnv(cwd: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, ...extra }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: gitEnv(cwd), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

function initRepo(parent: string): string {
  const repo = path.join(parent, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 't@example.com'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(path.join(repo, 'README'), 'base\n')
  git(repo, ['add', 'README'])
  git(repo, ['commit', '-m', 'base'])
  return repo
}

function runPreflight(cwd: string, binParent: string, inherited: NodeJS.ProcessEnv = {}) {
  const bin = path.join(binParent, 'bin')
  mkdirSync(bin, { recursive: true })
  const marker = path.join(binParent, 'bun-ran')
  writeFileSync(
    path.join(bin, 'bun'),
    `#!/bin/sh
printf ran > ${JSON.stringify(marker)}
exit 99
`,
    { mode: 0o755 },
  )
  const result = spawnSync('bash', ['-c', preflightBlock()], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv(cwd, { PATH: `${bin}:/usr/bin:/bin` }), ...inherited },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', marker }
}

describe('fix Filing command', () => {
  it('refuses dirty final-review filing before any tracker access', () => {
    let head = ''
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '720', SOURCE_PARENT: '720', ACTIVE_EPIC: '720' }),
      emptyState([seed(720)]),
      {
        prepareRepo(repo) {
          head = git(repo, ['rev-parse', 'HEAD'])
          writeFileSync(path.join(repo, 'stray'), 'operator work\n')
          git(repo, ['config', 'status.showUntrackedFiles', 'no'])
        },
      },
    )
    expect(ran.status).not.toBe(0)
    expect(ran.state.log).toEqual([])
    expect(created(ran.state)).toEqual([])
    expect(readFileSync(path.join(ran.repo, 'stray'), 'utf8')).toBe('operator work\n')
    expect(git(ran.repo, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('refuses dirty filing despite inherited Git redirection to a clean repository', () => {
    const env = facts()
    let head = ''
    const ran = runFiling(env, emptyState([seed(396, { parent: 720 }), seed(720)]), {
      prepareRepo(repo) {
        const elsewhere = path.join(path.dirname(repo), 'elsewhere')
        mkdirSync(elsewhere)
        const clean = initRepo(elsewhere)
        env.GIT_DIR = path.join(clean, '.git')
        env.GIT_WORK_TREE = clean
        head = git(repo, ['rev-parse', 'HEAD'])
        writeFileSync(path.join(repo, 'stray'), 'operator work\n')
      },
    })
    expect(ran.status).not.toBe(0)
    expect(ran.state.log).toEqual([])
    expect(created(ran.state)).toEqual([])
    expect(readFileSync(path.join(ran.repo, 'stray'), 'utf8')).toBe('operator work\n')
    expect(git(ran.repo, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('refuses filing when worktree status cannot be read', () => {
    const ran = runFiling(facts(), emptyState([seed(396, { parent: 720 }), seed(720)]), {
      prepareRepo(repo) {
        rmSync(path.join(repo, '.git'), { recursive: true })
      },
    })
    expect(ran.status).not.toBe(0)
    expect(ran.state.log).toEqual([])
    expect(created(ran.state)).toEqual([])
  })

  it('creates a fresh nonblocking deferral outside the active epic', () => {
    const ran = runFiling(
      facts(),
      emptyState([seed(396, { parent: 720, body: 'origin' }), seed(720, { title: 'epic' })]),
    )
    expect(ran.status).toBe(0)
    const issue = created(ran.state)
    expect(issue).toHaveLength(1)
    expect(issue[0].parent).toBeNull()
    expect(issue[0].blockedBy).toEqual([396])
    expect(issue[0].body).toContain('**Origin:**')
    expect(issue[0].body).toContain('## Acceptance criteria')
    expect(issue[0].labels).toContain('size:S')
    expect(issue[0].type).toBe('TYPE_fix')
    expect(ran.state.log.some((line) => line.startsWith('fetch:POST /graphql'))).toBe(true)
    expect(ran.state.log.some((line) => line.startsWith('graphql:addSubIssue'))).toBe(false)
    expect(ran.state.log.every((line) => !line.includes('example.com'))).toBe(true)
  })

  it('keeps the delivery parent on a blocking filing', () => {
    const ran = runFiling(facts({ DISPOSITION: 'blocking' }), emptyState([seed(396, { parent: 720 }), seed(720)]))
    expect(ran.status).toBe(0)
    expect(created(ran.state)).toHaveLength(1)
    expect(created(ran.state)[0].parent).toBe(720)
    expect(created(ran.state)[0].blockedBy).toEqual([396])
  })

  it('uses the sibling parent when it is not the active epic', () => {
    const ran = runFiling(facts({ SOURCE_PARENT: '50' }), emptyState([seed(396, { parent: 50 }), seed(50)]))
    expect(ran.status).toBe(0)
    expect(created(ran.state)[0].parent).toBe(50)
  })

  it('keeps the sibling parent when no active epic was proved', () => {
    const ran = runFiling(
      facts({ ACTIVE_EPIC: '', SOURCE_PARENT: '50' }),
      emptyState([seed(396, { parent: 50 }), seed(50)]),
    )
    expect(ran.status).toBe(0)
    expect(created(ran.state)[0].parent).toBe(50)
  })

  it('omits parent and blocked-by when origin and parent are known absent', () => {
    const ran = runFiling(facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', ACTIVE_EPIC: '' }), emptyState())
    expect(ran.status).toBe(0)
    expect(created(ran.state)).toHaveLength(1)
    expect(created(ran.state)[0].parent).toBeNull()
    expect(created(ran.state)[0].blockedBy).toEqual([])
    expect(relations(ran.state)).toEqual([])
  })

  it('omits parent when the origin is the top-level epic filed as its own candidate parent', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '720', SOURCE_PARENT: '720', ACTIVE_EPIC: '720' }),
      emptyState([seed(720, { parent: null, title: 'epic' })]),
    )
    expect(ran.status).toBe(0)
    expect(created(ran.state)[0].parent).toBeNull()
    expect(created(ran.state)[0].blockedBy).toEqual([720])
    expect(ran.state.log.some((line) => line.startsWith('graphql:addSubIssue'))).toBe(false)
  })

  it('keeps the enclosing sibling parent for final review of a nested epic', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '720', SOURCE_PARENT: '720', ACTIVE_EPIC: '720' }),
      emptyState([seed(720, { parent: 50 }), seed(50)]),
    )
    expect(ran.status).toBe(0)
    expect(created(ran.state)[0].parent).toBe(50)
    expect(created(ran.state)[0].blockedBy).toEqual([720])
  })

  it('halts when the claimed parent disagrees with the live read', () => {
    const ran = runFiling(facts({ SOURCE_PARENT: '50' }), emptyState([seed(396, { parent: 720 })]))
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/disagrees/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts when the parent read fails and does not treat that as absence', () => {
    const ran = runFiling(facts(), emptyState([seed(396, { parent: 720 })], { failView: [396] }))
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/SOURCE_PARENT read failed/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts when a parent is claimed without an origin issue', () => {
    const ran = runFiling(facts({ SOURCE_ISSUE: '' }), emptyState())
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/without SOURCE_ISSUE/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts on an unresolved active epic instead of filing outside by default', () => {
    const ran = runFiling(facts({ ACTIVE_EPIC: 'failed' }), emptyState([seed(396, { parent: 720 })]))
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/ACTIVE_EPIC unresolved/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts when ACTIVE_EPIC is unset', () => {
    const ran = runFiling(facts({ ACTIVE_EPIC: undefined }), emptyState())
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/ACTIVE_EPIC unset/)
    expect(posts(ran.state)).toEqual([])
  })

  it('reuses an already detached open issue and writes no edges', () => {
    const ran = runFiling(
      facts({
        SOURCE_ISSUE: '',
        SOURCE_PARENT: '',
        EXISTING_ISSUE: '80',
        ITEM_COVERAGE: 'exact',
      }),
      emptyState([seed(80, { parent: null, body: 'HISTORY-LINE' })]),
    )
    expect(ran.status).toBe(0)
    expect(ran.stdout).toMatch(/reused #80/)
    expect(posts(ran.state)).toEqual([])
    expect(relations(ran.state)).toEqual([])
    expect(ran.state.issues.find((issue) => issue.number === 80)?.parent).toBeNull()
  })

  it('reuses a historical child without changing its parent', () => {
    const ran = runFiling(
      facts({
        SOURCE_ISSUE: '',
        SOURCE_PARENT: '',
        EXISTING_ISSUE: '81',
        ITEM_COVERAGE: 'exact',
      }),
      emptyState([seed(81, { parent: 720, body: 'still a child' })]),
    )
    expect(ran.status).toBe(0)
    expect(posts(ran.state)).toEqual([])
    expect(relations(ran.state)).toEqual([])
    expect(ran.state.issues.find((issue) => issue.number === 81)?.parent).toBe(720)
  })

  it('does not reuse a closed tracker and does not create another', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', EXISTING_ISSUE: '80', ITEM_COVERAGE: 'exact' }),
      emptyState([seed(80, { state: 'CLOSED' })]),
    )
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/not an open tracker/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts when the candidate cannot be read', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', EXISTING_ISSUE: '80', ITEM_COVERAGE: 'exact' }),
      emptyState([seed(80)], { failView: [80] }),
    )
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/unreadable/)
    expect(posts(ran.state)).toEqual([])
  })

  it('halts on a noncovering candidate and does not create', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', EXISTING_ISSUE: '80', ITEM_COVERAGE: 'noncovering' }),
      emptyState([seed(80, { body: 'unrelated title' })]),
    )
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/coverage noncovering/)
    expect(ran.stderr).toMatch(/no create/)
    expect(posts(ran.state)).toEqual([])
    expect(ran.state.log.some((line) => line.startsWith('rest:PATCH'))).toBe(false)
  })

  it('appends a reused finding without overwriting another writer', () => {
    const ran = runFiling(
      facts({
        SOURCE_ISSUE: '',
        SOURCE_PARENT: '',
        EXISTING_ISSUE: '80',
        ITEM_COVERAGE: 'exact',
      }),
      emptyState([seed(80, { parent: 720, body: 'HISTORY-LINE', comments: ['EARLIER ITEM'] })], {
        concurrentEdit: { body: 'HISTORY-LINE\nHUMAN EDIT', comment: 'CONCURRENT ITEM' },
      }),
      {
        prepare: (fileDir) => writeFileSync(path.join(fileDir, 'append.md'), 'NEW-ITEM\n'),
      },
    )
    const issue = ran.state.issues.find((row) => row.number === 80)
    expect(ran.status).toBe(0)
    expect(issue?.body).toBe('HISTORY-LINE\nHUMAN EDIT')
    expect(issue?.comments).toEqual(['EARLIER ITEM', 'CONCURRENT ITEM', 'NEW-ITEM\n'])
    expect(issue?.parent).toBe(720)
    expect(posts(ran.state)).toEqual([])
    expect(relations(ran.state)).toEqual([])
    expect(ran.state.log.some((line) => line.startsWith('rest:PATCH'))).toBe(false)
  })

  it.each(['fix', 'triage'] as const)('%s reports the existing issue after a partial create', (recipe) => {
    const ran = runFiling(facts(), emptyState([seed(396, { parent: 720 })], { failGraphQL: 'relations' }), {
      recipe,
    })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain('#1000')
    expect(posts(ran.state)).toHaveLength(1)
    expect(created(ran.state)).toHaveLength(1)
    expect(created(ran.state)[0].blockedBy).toEqual([])
  })

  it.each(['fix', 'triage'] as const)('%s reports a failed append without replacing the tracker', (recipe) => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', EXISTING_ISSUE: '80', ITEM_COVERAGE: 'exact' }),
      emptyState([seed(80, { body: 'HISTORY-LINE' })], { failCommentWrite: true }),
      {
        recipe,
        prepare: (fileDir) => writeFileSync(path.join(fileDir, 'append.md'), 'NEW-ITEM\n'),
      },
    )
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain('#80')
    expect(posts(ran.state)).toEqual([])
    expect(ran.state.issues.find((issue) => issue.number === 80)?.body).toBe('HISTORY-LINE')
    expect(ran.state.issues.find((issue) => issue.number === 80)?.comments ?? []).toEqual([])
  })

  it('halts reuse when complete comment history cannot be read', () => {
    const ran = runFiling(
      facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '', EXISTING_ISSUE: '80', ITEM_COVERAGE: 'exact' }),
      emptyState([seed(80)], { failCommentsRead: true }),
      { prepare: (fileDir) => writeFileSync(path.join(fileDir, 'append.md'), 'NEW-ITEM\n') },
    )
    expect(ran.status).not.toBe(0)
    expect(ran.state.issues).toEqual([seed(80)])
    expect(posts(ran.state)).toEqual([])
  })

  it('exits non-zero on a realpath miss and never reaches triage', () => {
    const ran = runFiling(facts({ SOURCE_ISSUE: '', SOURCE_PARENT: '' }), emptyState(), {
      realpathOk: false,
      markerBun: true,
    })
    expect(ran.status).not.toBe(0)
    expect(ran.status).not.toBe(42)
    expect(() => readFileSync(ran.marker ?? '', 'utf8')).toThrow()
    expect(`${ran.stdout}\n${ran.stderr}`).not.toContain('Module not found')
    expect(posts(ran.state)).toEqual([])
  })
})

describe('github isolate', () => {
  it('answers api.github.com from state and blocks every other host', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-isolate-'))
    const statePath = path.join(root, 'github.json')
    writeFileSync(statePath, JSON.stringify(emptyState([seed(80)])))
    const blocked = spawnSync(REAL_BUN, ['--preload', FIXTURE, '-e', 'await fetch("https://example.com/")'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ISOLATE_STATE: statePath },
    })
    expect(blocked.status).not.toBe(0)
    expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/external network blocked/)
    const local = spawnSync(
      REAL_BUN,
      [
        '--preload',
        FIXTURE,
        '-e',
        'const r = await fetch("https://api.github.com/repos/Acme/app/issues/80"); if (!r.ok) throw new Error(String(r.status)); const j = await r.json(); if (j.node_id !== "NODE_80") throw new Error("node")',
      ],
      { encoding: 'utf8', env: { ...process.env, GITHUB_ISOLATE_STATE: statePath } },
    )
    expect(local.status).toBe(0)
  })
})

describe('fix initial worktree preflight', () => {
  it('refuses a dirty delivery tree despite inherited Git redirection', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-preflight-redirect-'))
    const repo = initRepo(root)
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const clean = initRepo(elsewhere)
    const head = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(repo, 'sentinel'), 'operator work\n')
    const ran = runPreflight(repo, root, { GIT_DIR: path.join(clean, '.git'), GIT_WORK_TREE: clean })
    expect(ran.status).not.toBe(0)
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head)
    expect(readFileSync(path.join(repo, 'sentinel'), 'utf8')).toBe('operator work\n')
  })

  it('halts a dirty zero-apply tree and leaves sentinels uncommitted', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-preflight-'))
    const repo = initRepo(root)
    const head = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(repo, 'README'), 'changed\n')
    git(repo, ['add', 'README'])
    writeFileSync(path.join(repo, 'sentinel-untracked'), 'keep\n')
    const ran = runPreflight(repo, root)
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/dirty tree/)
    expect(readFileSync(path.join(repo, 'sentinel-untracked'), 'utf8')).toBe('keep\n')
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(repo, ['diff', '--cached', '--name-only'])).toContain('README')
    expect(git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toMatch(/sentinel-untracked/)
    expect(git(repo, ['remote'])).toBe('')
    expect(() => readFileSync(ran.marker, 'utf8')).toThrow()
  })

  it('accepts a clean tree and creates no commit', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-preflight-clean-'))
    const repo = initRepo(root)
    const head = git(repo, ['rev-parse', 'HEAD'])
    const ran = runPreflight(repo, root)
    expect(ran.status).toBe(0)
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => readFileSync(ran.marker, 'utf8')).toThrow()
  })

  it('treats a failed status as not clean', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-preflight-fail-'))
    const dir = path.join(root, 'not-a-repo')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'sentinel'), 'keep\n')
    const ran = runPreflight(dir, root)
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toMatch(/not clean/)
    expect(readFileSync(path.join(dir, 'sentinel'), 'utf8')).toBe('keep\n')
    expect(() => readFileSync(ran.marker, 'utf8')).toThrow()
  })
})
