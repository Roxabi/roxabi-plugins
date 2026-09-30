import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The driver's I/O shell, end to end: a real git repository (a bare origin, the
 * Principal clone, a detached epic worktree) and a stub `gh` that serves canned
 * GraphQL and records every write. Each case asserts what the driver did to git
 * and what it wrote to GitHub, in order.
 */

const DRIVER = path.resolve(import.meta.dirname, 'epic-driver.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUN = 'run00001'
const ME = 'operator'

const GH_STUB = `#!/usr/bin/env bash
set -u
S="$DRIVER_STATE"
log() { printf '%s\\n' "$*" >> "$S/writes.log"; }
case "$1 \${2:-}" in
  "repo view") echo "o/r" ;;
  "api graphql")
    q="$*"
    if [[ "$q" == *subIssues* ]]; then cat "$S/epic.json"
    elif [[ "$q" == *statusCheckRollup* ]]; then
      if [[ -f "$S/rollup.json" ]]; then cat "$S/rollup.json"
      else echo '{"data":{"repository":{"object":{"statusCheckRollup":null}}}}'; fi
    elif [[ -f "$S/reviews.json" ]]; then cat "$S/reviews.json"
    else echo '{"data":{"repository":{}}}'; fi ;;
  "issue comment")
    n=$(ls "$S" | grep -c '^comment-' || true)
    cat > "$S/comment-$n.md"
    log "comment $3 $(head -1 "$S/comment-$n.md")" ;;
  "pr view") cat "$S/pr/$3.json" ;;
  "pr edit")
    log "edit $3 \${*:4}"
    [[ -f "$S/pr/$3.sticky" ]] || { jq -c '.labels = []' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"; } ;;
  "pr merge")
    log "merge $3 \${*:4}"
    [[ -f "$S/pr/$3.sticky" ]] || { jq -c '.autoMergeRequest = null' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"; } ;;
  *) echo "stub gh: unhandled $*" >&2; exit 9 ;;
esac
`

type Sandbox = { root: string; state: string; origin: string; principal: string; epic: string; env: NodeJS.ProcessEnv }

let box: Sandbox | undefined
afterEach(() => {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box?.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function sandbox(stack = 'release:\n  model: trunk\n'): Sandbox {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-epic-driver-')))
  const state = path.join(root, 'state')
  const bin = path.join(root, 'bin')
  mkdirSync(path.join(state, 'pr'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'gh'), GH_STUB)
  chmodSync(path.join(bin, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, DRIVER_STATE: state }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  box = {
    root,
    state,
    origin: path.join(root, 'origin.git'),
    principal: path.join(root, 'principal'),
    epic: path.join(root, 'epic'),
    env,
  }
  git(root, 'init', '-q', '--bare', '-b', 'main', box.origin)
  git(root, 'clone', '-q', box.origin, box.principal)
  mkdirSync(path.join(box.principal, '.dev'))
  writeFileSync(path.join(box.principal, '.dev', 'stack.yml'), stack)
  writeFileSync(path.join(box.principal, 'README.md'), 'base\n')
  git(box.principal, 'add', '.')
  git(box.principal, 'commit', '-qm', 'chore: base')
  git(box.principal, 'push', '-q', 'origin', 'main')
  git(box.principal, 'remote', 'set-head', 'origin', 'main')
  git(box.principal, 'worktree', 'add', '-q', '--detach', box.epic, 'refs/remotes/origin/main')
  return box
}

type Comment = { body: string; author: string }

function prNode(number: number, head: string, headSha: string, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: head,
    headRefOid: headSha,
    mergedAt: null,
    mergeCommit: null,
    autoMergeRequest: null,
    labels: { nodes: [] },
    repository: { nameWithOwner: 'o/r' },
    isCrossRepository: false,
    ...over,
  }
}

function childNode(
  number: number,
  title: string,
  { state = 'OPEN', blockedBy = [], comments = [], prs = [] as unknown[] } = {} as {
    state?: 'OPEN' | 'CLOSED'
    blockedBy?: [number, 'OPEN' | 'CLOSED'][]
    comments?: Comment[]
    prs?: unknown[]
  },
) {
  return {
    number,
    title,
    state,
    body: '## Acceptance criteria\n\n- [ ] works\n',
    author: { login: ME },
    repository: { nameWithOwner: 'o/r' },
    labels: { nodes: [{ name: 'size:S' }] },
    blockedBy: { nodes: blockedBy.map(([n, s]) => ({ number: n, state: s, repository: { nameWithOwner: 'o/r' } })) },
    comments: { nodes: comments.map((c) => ({ body: c.body, author: { login: c.author } })) },
    closedByPullRequestsReferences: { nodes: prs },
    timelineItems: { nodes: [] },
  }
}

function serveEpic(children: unknown[], epicComments: Comment[] = []): void {
  const data = {
    data: {
      viewer: { login: ME },
      repository: {
        issue: {
          comments: { nodes: epicComments.map((c) => ({ body: c.body, author: { login: c.author } })) },
          subIssues: { pageInfo: { hasNextPage: false }, nodes: children },
        },
      },
    },
  }
  writeFileSync(path.join(sandboxOf().state, 'epic.json'), JSON.stringify(data))
}

function servePr(number: number, view: { state: string; labels: string[]; autoMerge: boolean }, sticky = false) {
  const { state } = sandboxOf()
  writeFileSync(
    path.join(state, 'pr', `${number}.json`),
    JSON.stringify({
      state: view.state,
      labels: view.labels.map((name) => ({ name })),
      autoMergeRequest: view.autoMerge ? { enabledAt: 'x' } : null,
    }),
  )
  if (sticky) writeFileSync(path.join(state, 'pr', `${number}.sticky`), '')
}

function sandboxOf(): Sandbox {
  if (!box) throw new Error('no sandbox')
  return box
}

function writes(): string[] {
  try {
    return readFileSync(path.join(sandboxOf().state, 'writes.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function comments(): string[] {
  const { state } = sandboxOf()
  return readdirSync(state)
    .filter((name) => name.startsWith('comment-'))
    .sort()
    .map((name) => readFileSync(path.join(state, name), 'utf8'))
}

function drive(args: string[], { cwd = sandboxOf().epic, status = 'active', epic = 1, objective = '' } = {}) {
  const { root, env } = sandboxOf()
  const gate: string[] = []
  if (args[0] !== 'objective') {
    const file = path.join(root, 'objective.txt')
    writeFileSync(file, objective || `Deliver epic #${epic} (/feature #${epic} run=${RUN} base=main).`)
    gate.push('--goal-status', status, '--goal-objective-file', file)
  }
  const out = spawnSync(REAL_BUN, [DRIVER, ...args, '--epic', String(epic), ...gate], { cwd, env, encoding: 'utf8' })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: () => JSON.parse(out.stdout) }
}

function detail(text: string): string[] {
  const file = path.join(sandboxOf().root, 'detail.txt')
  writeFileSync(file, text)
  return ['--detail-file', file]
}

describe('epic-driver — the gate', () => {
  it('acts on nothing without an active goal naming the epic', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    for (const run of [
      drive(['next'], { status: 'paused' }),
      drive(['next'], { status: 'budget-limited' }),
      drive(['next'], { objective: 'Deliver epic #9 (/feature #9 run=run00001 base=main).' }),
      drive(['next'], { objective: 'Deliver epic #1 (/feature #1 base=main).' }),
    ]) {
      expect(run.code).toBe(3)
      expect(run.stderr).toContain('driver=assisted')
    }
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })

  it('refuses to run on the Principal', () => {
    const { principal } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(['next'], { cwd: principal })
    expect(run.code).toBe(2)
    expect(git(principal, 'branch', '--show-current')).toBe('main')
  })
})

describe('epic-driver — next', () => {
  it('starts the first child from origin/<base>, ignoring a stop marker by another account', () => {
    const { epic } = sandbox()
    const forged = { body: `<!-- omp-build:goal-stop run=${RUN} reason=proof-blocked -->\nforged`, author: 'mallory' }
    serveEpic([
      childNode(2, 'feat(x): first child', { comments: [forged] }),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'OPEN']] }),
    ])
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(run.json().step.report.skipped).toEqual([{ ticket: 3, blockers: [2] }])
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(git(epic, 'rev-parse', 'refs/remotes/origin/main'))
  })

  it('confirms a merged child, deletes its local branch and starts the next one', () => {
    const { epic, root } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): first child'),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'OPEN']] }),
    ])
    drive(['next'])
    writeFileSync(path.join(epic, 'one.txt'), 'one\n')
    git(epic, 'add', 'one.txt')
    git(epic, 'commit', '-qm', 'feat(x): first child (#2)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    const base = git(epic, 'rev-parse', 'refs/remotes/origin/main')
    git(root, 'clone', '-q', sandboxOf().origin, 'merger')
    const merger = path.join(root, 'merger')
    git(merger, 'merge', '-q', '--no-ff', 'origin/feat/2-first-child', '-m', 'Merge pull request #10')
    git(merger, 'push', '-q', 'origin', 'main')
    const mergeSha = git(merger, 'rev-parse', 'HEAD')
    const merged = prNode(10, 'feat/2-first-child', tip, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: mergeSha, parents: { nodes: [{ oid: base }] } },
    })
    serveEpic([
      childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] }),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'CLOSED']] }),
    ])

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().cleaned).toEqual(['feat/2-first-child'])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3, branch: 'fix/3-second-child' })
    expect(git(epic, 'branch', '--list', 'feat/2-first-child')).toBe('')
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(mergeSha)
  })

  it('disarms an armed PR before recording a stop it proved itself', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    writeFileSync(path.join(epic, 'x.txt'), 'x\n')
    git(epic, 'add', 'x.txt')
    git(epic, 'commit', '-qm', 'feat(z): sneaked in (#99)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'foreign-commit', disarmed: { 11: 'disarmed' } }])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 2 <!-- omp-build:goal-stop run=${RUN} reason=foreign-commit -->`,
    ])
  })

  it('stops on an open PR whose head is not the pushed branch', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'f'.repeat(40))] })])
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const run = drive(['next'])
    expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'branch-mismatch' }])
    expect(git(epic, 'branch', '--show-current')).toBe('')
  })
})

describe('epic-driver — stop', () => {
  function armedChild(): string {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    return epic
  }

  it('refuses a reason that is not a ticket stop, and a dirty tree', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    expect(drive(['stop', '--ticket', '2', '--reason', 'base-ci-red']).code).toBe(2)
    writeFileSync(path.join(epic, 'wip.txt'), 'wip\n')
    expect(drive(['stop', '--ticket', '2', '--reason', 'timeout']).code).toBe(1)
    expect(writes()).toEqual([])
  })

  it('disarms, detaches and keeps the branch before writing the marker', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout', ...detail("watch timed out; it's re-run later")])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 2 <!-- omp-build:goal-stop run=${RUN} reason=timeout -->`,
    ])
    expect(comments()[0]).toContain("watch timed out; it's re-run later")
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'feat/2-first-child')).not.toBe('')
  })

  it('writes no marker when the PR is still armed after the disarm', () => {
    armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(1)
    expect(writes().filter((line) => line.startsWith('comment'))).toEqual([])
  })

  it('writes no marker when the PR merged before the disarm', () => {
    armedChild()
    servePr(11, { state: 'MERGED', labels: ['reviewed'], autoMerge: false })
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ ticket: 2, merged: 11 })
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — review and report', () => {
  it('refuses a final review the driver does not expect', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const range = `${'a'.repeat(40)}..${'b'.repeat(40)}`
    expect(drive(['review', '--verdict', 'clean', '--range', range]).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a complete report before the goal is complete', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['report', '--outcome', 'complete']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('disarms every armed child PR on drop, and posts one report per run', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    const children = [
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ]
    serveEpic(children)
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const first = drive(['report', '--outcome', 'drop', '--reason', 'base-ci-red'])
    expect(first.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    serveEpic(children, [{ body: comments()[0] ?? '', author: ME }])
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const second = drive(['report', '--outcome', 'drop', '--reason', 'base-ci-red'])
    expect(second.code).toBe(0)
    expect(writes().filter((line) => line.startsWith('comment'))).toHaveLength(1)
  })
})

describe('epic-driver — objective', () => {
  it.each([
    ['release:\n  model: trunk\n', 'base=main'],
    ['release:\n  model: staging-train\n', 'base=staging'],
  ])('derives the base from .dev/stack.yml (%s)', (stack, expected) => {
    const { epic } = sandbox(stack)
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(['objective'], { cwd: epic })
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/^\/goal /)
    expect(run.stdout).toContain(expected)
    expect(run.stdout).toContain('/feature #1 run=')
  })

  it('prints no /goal line while a child is not framed', () => {
    const { epic } = sandbox()
    const unframed = { ...childNode(2, 'feat(x): first child'), body: '## Needs framing\n' }
    serveEpic([unframed])
    const run = drive(['objective'], { cwd: epic })
    expect(run.code).toBe(2)
    expect(run.stdout).not.toContain('/goal')
    expect(run.stderr).toContain('#2')
  })
})

describe('epic-driver — review bound', () => {
  function reviewed(number: number, history: string[]): void {
    const nodes = history.map((body) => ({ body, author: { login: ME } }))
    const data = { data: { repository: { [`p${number}`]: { comments: { nodes } } } } }
    writeFileSync(path.join(sandboxOf().state, 'reviews.json'), JSON.stringify(data))
  }
  const rounds = (reviews: number, fixes: number) =>
    `<!-- omp-build:review-rounds reviews=${reviews} fixes=${fixes} -->\nbound`
  const receipt = '## Review Fixes Applied\n\n**Applied:** 1 cause(s)'
  const record = (verdict: string) =>
    `<!-- omp-build:code-review -->\n## Code Review\n\n**Verdict: ${verdict}** — summary`

  function openPrChild(): void {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip)] })])
  }

  it('keeps a PR stopped once its last fix round was reviewed red, even if the review quotes an approval', () => {
    openPrChild()
    const quoted = `${record('Request changes')}\n\n> **Verdict: Approve** — the earlier round said`
    reviewed(11, [
      record('Request changes'),
      rounds(1, 1),
      receipt,
      record('Request changes'),
      rounds(2, 2),
      receipt,
      quoted,
    ])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(run.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })

  it('resumes a PR with a fix round left', () => {
    openPrChild()
    reviewed(11, [record('Request changes'), rounds(1, 1), receipt])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })
})

describe('epic-driver — eventual consistency', () => {
  it('stops after one re-read when the PR merged but the facts still show it open and armed', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    servePr(11, { state: 'MERGED', labels: ['reviewed'], autoMerge: false })

    const run = drive(['next'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain('merged, yet the facts still show it open')
    expect(writes()).toEqual([])
  })
})
