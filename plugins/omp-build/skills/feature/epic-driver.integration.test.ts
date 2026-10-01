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
log() { printf '%s\\n' "$*" >> "$S/writes.log"; printf '%s\\n' "$*" >> "$S/trace.log"; }
query() { printf 'query %s\\n' "$1" >> "$S/trace.log"; }
case "$1 \${2:-}" in
  "repo view")
    if [[ "$*" == *defaultBranchRef* ]]; then echo "develop"; else echo "o/r"; fi ;;
  "api graphql")
    q="$*"
    if [[ "$q" == *subIssues* ]]; then
      query subIssues
      n=$(( $(cat "$S/reads" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/reads"
      if [[ -f "$S/epic.json.$n" ]]; then cat "$S/epic.json.$n"; else cat "$S/epic.json"; fi
    elif [[ "$q" == *statusCheckRollup* ]]; then
      query statusCheckRollup
      if [[ -f "$S/rollup.json" ]]; then cat "$S/rollup.json"
      else echo '{"data":{"repository":{"object":{"statusCheckRollup":null}}}}'; fi
    elif [[ -f "$S/reviews.json" ]]; then
      query reviews
      cat "$S/reviews.json"
    else query other; echo '{"data":{"repository":{}}}'; fi ;;
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
  const command = env.DRIVER_STRACE
    ? ['strace', '-f', '-e', 'trace=openat,write', '-o', env.DRIVER_STRACE, REAL_BUN]
    : [REAL_BUN]
  const out = spawnSync(command[0], [...command.slice(1), DRIVER, ...args, '--epic', String(epic), ...gate], {
    cwd,
    env,
    encoding: 'utf8',
  })
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

  it('refuses a reason that is not a ticket stop', () => {
    armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    expect(drive(['stop', '--ticket', '2', '--reason', 'base-ci-red']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a dirty tree', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
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
  const reads = () => Number(readFileSync(path.join(sandboxOf().state, 'reads'), 'utf8'))

  function armedOnOrigin(): string {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    servePr(11, { state: 'MERGED', labels: ['reviewed'], autoMerge: false })
    return tip
  }

  it('reads GitHub once more when the PR merged during its disarm, and moves on', () => {
    const tip = armedOnOrigin()
    const { state } = sandboxOf()
    const merged = prNode(11, 'feat/2-first-child', tip, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: 'd'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } },
    })
    // The first read is the stale one; every later read shows the merge.
    writeFileSync(path.join(state, 'epic.json.1'), readFileSync(path.join(state, 'epic.json')))
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })])

    const run = drive(['next'])

    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'final-review', stage: 'review' })
    expect(reads()).toBeGreaterThanOrEqual(2)
  })

  it('stops after exactly one re-read when the facts stay stale', () => {
    armedOnOrigin()

    const run = drive(['next'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain('merged, yet the facts still show it open')
    expect(reads()).toBe(2)
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — hook', () => {
  it('posts the hook result without its output, which reaches only the caller', () => {
    const { principal, epic, root } = sandbox()
    mkdirSync(path.join(principal, 'scripts'))
    writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), '#!/bin/sh\necho "token=s3cr3t-value"\n')
    chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
    writeFileSync(
      path.join(principal, '.dev', 'stack.yml'),
      'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
    )
    const base = git(principal, 'rev-parse', 'HEAD')
    git(principal, 'add', '.')
    git(principal, 'commit', '-qm', 'chore: hook (#2)')
    git(principal, 'push', '-q', 'origin', 'main')
    const merge = git(principal, 'rev-parse', 'HEAD')
    git(epic, 'fetch', '-q', 'origin')
    const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
    })
    const review = `<!-- omp-build:epic-review run=${RUN} verdict=clean range=${base}..${merge} -->\nclean`
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [{ body: review, author: ME }],
    )

    // The runner refuses a cwd inside the repository; the caller runs it from outside.
    const run = drive(['hook', '--repo', epic], { cwd: root })

    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ result: 'ok', sha: merge, output: expect.stringContaining('s3cr3t-value') })
    expect(writes()).toEqual([
      `comment 1 <!-- omp-build:post-merge run=${RUN} result=started sha=${merge} -->`,
      `comment 1 <!-- omp-build:post-merge run=${RUN} result=ok sha=${merge} -->`,
    ])
    expect(comments().join('\n')).not.toContain('s3cr3t-value')
  })
})

describe('epic-driver — unreadable landing', () => {
  it('drops on it, and the drop still disarms and reports', () => {
    const { epic } = sandbox('release:\n  model: trunk\nlanding:\n  mode: squash\n')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const next = drive(['next'])
    expect(next.code).toBe(0)
    expect(next.json().step).toMatchObject({ action: 'drop', stop: 'bad-landing' })
    expect(git(epic, 'branch', '--show-current')).toBe('')

    const report = drive(['report', '--outcome', 'drop', '--reason', 'bad-landing'])
    expect(report.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
  })
})

/**
 * Child #2 merged into origin/main by PR #10, whose commit also ships a hook that
 * leaves a proof file. Returns the cumulative range the final review is about.
 */
function landedEpic(): { range: string; merged: ReturnType<typeof prNode>; proof: string } {
  const { principal, epic, root } = sandbox()
  const proof = path.join(root, 'hook-ran')
  mkdirSync(path.join(principal, 'scripts'))
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), `#!/bin/sh\ntouch '${proof}'\n`)
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
  )
  const base = git(principal, 'rev-parse', 'HEAD')
  git(principal, 'add', '.')
  git(principal, 'commit', '-qm', 'feat(x): first child (#2)')
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  git(epic, 'fetch', '-q', 'origin')
  const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
    state: 'MERGED',
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
  })
  return { range: `${base}..${merge}`, merged, proof }
}

const reviewMarker = (verdict: 'clean' | 'blocking', range: string): Comment => ({
  body: `<!-- omp-build:epic-review run=${RUN} verdict=${verdict} range=${range} -->\n${verdict}`,
  author: ME,
})

describe('epic-driver — final review and hook refusals', () => {
  it('refuses a clean review while the one fix ticket is still owed', () => {
    const { range, merged } = landedEpic()
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [reviewMarker('blocking', range)],
    )
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })

    const run = drive(['review', '--verdict', 'clean', '--range', range])
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a review of a range the driver did not ask for', () => {
    const { range, merged } = landedEpic()
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })])
    const [from] = range.split('..')
    const run = drive(['review', '--verdict', 'clean', '--range', `${from}..${'d'.repeat(40)}`])
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
    expect(drive(['review', '--verdict', 'clean', '--range', range]).code).toBe(0)
  })

  it('refuses to run the hook before the final review is clean', () => {
    const { merged, proof } = landedEpic()
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })])
    const run = drive(['hook', '--repo', sandboxOf().epic], { cwd: sandboxOf().root })
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
    expect(() => readFileSync(proof)).toThrow()
  })

  it('counts the fix round only for an epic-fix child this account wrote', () => {
    const { range, merged } = landedEpic()
    const fix = (author: string) => ({
      ...childNode(3, 'fix(x): epic review', { state: 'CLOSED' }),
      body: '<!-- omp-build:epic-fix -->\n## Acceptance criteria\n- [ ] fixed\n',
      author: { login: author },
    })
    const done = childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })
    serveEpic([done, fix('mallory')], [reviewMarker('blocking', range)])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })
    serveEpic([done, fix(ME)], [reviewMarker('blocking', range)])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'drop', stop: 'final-review-blocking' })
  })
})

describe('epic-driver — fork PRs', () => {
  it('ignores a fork PR carrying the child branch name, found through a cross-reference', () => {
    const { epic } = sandbox()
    const fork = prNode(66, 'feat/2-first-child', 'e'.repeat(40), {
      isCrossRepository: true,
      labels: { nodes: [{ name: 'reviewed' }] },
    })
    const node = childNode(2, 'feat(x): first child')
    node.timelineItems = { nodes: [{ source: fork }] } as typeof node.timelineItems
    serveEpic([node])

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toEqual([])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })
})

describe('epic-driver — disarm modes', () => {
  function child2Pr(armed: Record<string, unknown>): void {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
  }

  it('removes a merge-on-green label with no auto-merge to disable', () => {
    child2Pr({ labels: { nodes: [{ name: 'reviewed' }] } })
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: false })
    const run = drive(['stop', '--ticket', '2', '--reason', 'ci-blocked'])
    expect(run.code).toBe(0)
    expect(run.json().disarmed).toEqual({ 11: 'disarmed' })
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      `comment 2 <!-- omp-build:goal-stop run=${RUN} reason=ci-blocked -->`,
    ])
  })

  it('touches nothing on a PR that was never armed', () => {
    child2Pr({})
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const run = drive(['stop', '--ticket', '2', '--reason', 'proof-blocked'])
    expect(run.code).toBe(0)
    expect(run.json().disarmed).toEqual({ 11: 'unarmed' })
    expect(writes()).toEqual([`comment 2 <!-- omp-build:goal-stop run=${RUN} reason=proof-blocked -->`])
  })
})

describe('epic-driver — report', () => {
  it('reports the hook result that completed the goal, even from an earlier run', () => {
    const { range, merged } = landedEpic()
    const merge = range.split('..')[1]
    const earlier = { body: `<!-- omp-build:post-merge run=run00000 result=ok sha=${merge} -->\nok`, author: ME }
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [reviewMarker('clean', range), earlier],
    )

    const run = drive(['report', '--outcome', 'complete'])

    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`| Post-merge hook | ok at \`${merge}\` (run \`run00000\`) |`)
  })
})

describe('epic-driver — base CI', () => {
  function serveRollup(nodes: unknown[]): void {
    const data = { data: { repository: { object: { statusCheckRollup: { contexts: { nodes } } } } } }
    writeFileSync(path.join(sandboxOf().state, 'rollup.json'), JSON.stringify(data))
  }
  const check = (name: string, conclusion: string) => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    startedAt: '2026-09-30T09:00:00Z',
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  })

  it('drops on a red base before switching to any child', () => {
    const { epic } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    serveRollup([check('test', 'FAILURE'), check('lint', 'SUCCESS')])
    const run = drive(['next'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'base-ci-red' })
    expect(run.json().step.report.baseCi).toMatchObject({ state: 'red', failed: ['test'] })
    expect(git(epic, 'branch', '--show-current')).toBe('')
  })

  it('reads only the check set the landing declares', () => {
    const { epic } = sandbox('release:\n  model: trunk\nlanding:\n  required_checks: [lint]\n')
    serveEpic([childNode(2, 'feat(x): first child')])
    serveRollup([check('test', 'FAILURE'), check('lint', 'SUCCESS')])
    const run = drive(['next'])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2 })
    expect(run.json().step.report.baseCi).toMatchObject({ state: 'green', failed: [] })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })
})

describe('epic-driver — remaining branches', () => {
  it('resumes a branch that exists only on origin, tracking it', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    writeFileSync(path.join(epic, 'one.txt'), 'one\n')
    git(epic, 'add', 'one.txt')
    git(epic, 'commit', '-qm', 'feat(x): first child (#2)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    git(epic, 'branch', '-q', '-D', 'feat/2-first-child')
    serveEpic([childNode(2, 'feat(x): first child')])

    const run = drive(['next'])

    expect(run.json().step).toMatchObject({ action: 'resume', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(tip)
    expect(git(epic, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat/2-first-child')
  })

  it('asks GitHub for the default branch when origin/HEAD is not set', () => {
    const { principal, epic } = sandbox()
    git(principal, 'remote', 'set-head', 'origin', '-d')
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(['objective'], { cwd: epic })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('base=develop')
  })

  it('prints the order and the children held by a blocker outside the epic', () => {
    const { epic } = sandbox()
    const outside = { number: 900, state: 'OPEN', repository: { nameWithOwner: 'o/r' } }
    const held = childNode(4, 'feat(z): held')
    held.blockedBy = { nodes: [outside] } as typeof held.blockedBy
    serveEpic([childNode(3, 'feat(y): second', { blockedBy: [[2, 'OPEN']] }), childNode(2, 'feat(x): first'), held])
    const run = drive(['objective'], { cwd: epic })
    expect(run.stdout).toContain('order: #2 → #3')
    expect(run.stdout).toContain('blocked: #4 by #900')
  })

  it('refuses to stop a ticket that is not a sub-issue', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['stop', '--ticket', '7', '--reason', 'timeout']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it.each([
    ['stop', '--ticket', '2', '--reason', 'timeout'],
    ['review', '--verdict', 'clean', '--range', `${'a'.repeat(40)}..${'b'.repeat(40)}`],
    ['hook'],
    ['report', '--outcome', 'drop', '--reason', 'x'],
  ])('refuses %s on the Principal', (...args) => {
    const { principal } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(args, { cwd: principal })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Principal')
    expect(writes()).toEqual([])
  })
})

/**
 * A stopped child whose PR stayed armed, plus an independent child the goal can start.
 * `earlier` is a durable goal-stop from another run; the viewer wrote it.
 */
function stoppedArmedAndIndependent(sticky = false): string {
  const { epic } = sandbox()
  const earlier = {
    body: `<!-- omp-build:goal-stop run=run00000 reason=review-bound -->\nstopped`,
    author: ME,
  }
  const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
  serveEpic([
    childNode(2, 'feat(x): first child', {
      comments: [earlier],
      prs: [prNode(10, 'feat/2-first-child', 'a'.repeat(40), armed)],
    }),
    childNode(3, 'fix(y): second child'),
  ])
  servePr(10, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, sticky)
  return epic
}

describe('epic-driver — reconcile a stopped armed PR', () => {
  it('disarms a stopped child before starting an independent one, and lists it under reconciled', () => {
    const epic = stoppedArmedAndIndependent()
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3, branch: 'fix/3-second-child' })
    expect(run.json().disarmed).toBeNull()
    expect(run.json().reconciled).toEqual([{ ticket: 2, pr: 10, disarmed: 'disarmed' }])
    expect(writes()).toEqual(['edit 10 --remove-label reviewed', 'merge 10 --disable-auto'])
    expect(git(epic, 'branch', '--show-current')).toBe('fix/3-second-child')
  })

  it('returns a drop and creates no branch when that disarm fails', () => {
    const epic = stoppedArmedAndIndependent(true)
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step.action).toBe('drop')
    expect(run.json().step.stop).toBe('driver-error')
    expect(run.json().step.reason).toContain('#10')
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'fix/3-second-child')).toBe('')
  })

  it('returns a drop and creates no branch when the stopped PR already merged', () => {
    const epic = stoppedArmedAndIndependent()
    servePr(10, { state: 'MERGED', labels: [], autoMerge: false })
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step.action).toBe('drop')
    expect(run.json().step.stop).toBe('driver-error')
    expect(run.json().step.reason).toContain('#10')
    expect(run.json().reconciled).toEqual([{ ticket: 2, pr: 10, disarmed: 'merged' }])
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'fix/3-second-child')).toBe('')
  })

  it('disarms the later stopped PR when the first disarm fails, and creates no branch', () => {
    const epic = sandbox().epic
    const earlier = { body: '<!-- omp-build:goal-stop run=run00000 reason=review-bound -->\nstopped', author: ME }
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', {
        comments: [earlier],
        prs: [prNode(10, 'feat/2-first-child', 'a'.repeat(40), armed)],
      }),
      childNode(3, 'fix(y): second child'),
      childNode(4, 'chore(z): third child', {
        comments: [earlier],
        prs: [prNode(14, 'chore/4-third-child', 'b'.repeat(40), armed)],
      }),
    ])
    servePr(10, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    servePr(14, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step.action).toBe('drop')
    expect(run.json().step.reason).toContain('#10')
    expect(writes()).toEqual([
      'edit 10 --remove-label reviewed',
      'merge 10 --disable-auto',
      'edit 14 --remove-label reviewed',
      'merge 14 --disable-auto',
    ])
    expect(git(epic, 'branch', '--list', 'fix/3-second-child')).toBe('')
  })

  it('returns a drop and creates no branch when the epic query already says the stopped PR merged', () => {
    const { epic } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): first child', {
        comments: [{ body: '<!-- omp-build:goal-stop run=run00000 reason=review-bound -->\nstopped', author: ME }],
        prs: [
          prNode(10, 'feat/2-first-child', 'a'.repeat(40), {
            state: 'MERGED',
            mergedAt: '2026-10-01T00:00:00Z',
            mergeCommit: { oid: 'e'.repeat(40), parents: { nodes: [{ oid: 'f'.repeat(40) }] } },
          }),
        ],
      }),
      childNode(3, 'fix(y): second child'),
    ])
    servePr(10, { state: 'MERGED', labels: [], autoMerge: false })
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step.action).toBe('drop')
    expect(run.json().step.stop).toBe('driver-error')
    expect(run.json().step.reason).toContain('#10')
    expect(writes()).toEqual([])
    expect(git(epic, 'branch', '--list', 'fix/3-second-child')).toBe('')
  })

  it('dry-run reports the PR it would disarm and makes no write', () => {
    const epic = stoppedArmedAndIndependent()
    const run = drive(['next', '--dry-run'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3 })
    expect(run.json().reconciled).toEqual([{ ticket: 2, pr: 10, disarmed: 'dry-run' }])
    expect(writes()).toEqual([])
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'fix/3-second-child')).toBe('')
  })
})

describe('epic-driver — drop disarms without the dashboard', () => {
  it('disarms every armed PR when the base-CI rollup query fails', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    writeFileSync(
      path.join(sandboxOf().state, 'rollup.json'),
      JSON.stringify({ data: null, errors: [{ message: 'statusCheckRollup failed' }] }),
    )
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    expect(run.stdout).toContain('| Base CI | unread |')
    expect(run.stdout).not.toContain('| Base CI | none |')
    expect(run.stdout).not.toContain('| Base CI | green |')
    expect(comments()[0]).toContain('| Base CI | unread |')
  })

  it('disarms every armed PR when the landing cannot be read', () => {
    sandbox('release:\n  model: trunk\nlanding:\n  mode: squash\n')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const straceLog = path.join(sandboxOf().state, 'strace.log')
    sandboxOf().env.DRIVER_STRACE = straceLog
    const run = drive(['report', '--outcome', 'drop', '--reason', 'bad-landing'])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    const seen = readFileSync(straceLog, 'utf8').split('\n')
    const editAt = seen.findIndex((line) => line.includes('edit 11'))
    const readAt = seen.findIndex((line) => line.includes('stack.yml'))
    const rollupAt = seen.findIndex((line) => line.includes('statusCheckRollup'))
    expect(editAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeGreaterThan(editAt)
    expect(rollupAt === -1 || rollupAt > editAt).toBe(true)
    expect(run.stdout).toContain('| Base CI | unread |')
    expect(run.stdout).not.toContain('| Base CI | none |')
    expect(run.stdout).not.toContain('| Base CI | green |')
  })

  it('disarms when git rev-parse of the base fails', () => {
    const epic = sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    git(epic.epic, 'update-ref', '-d', 'refs/remotes/origin/main')
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).toBe(0)
    expect(writes().slice(0, 2)).toEqual(['edit 11 --remove-label reviewed', 'merge 11 --disable-auto'])
  })

  it('disarms when the review-comments query fails', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    writeFileSync(
      path.join(sandboxOf().state, 'reviews.json'),
      JSON.stringify({ data: null, errors: [{ message: 'reviews failed' }] }),
    )
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).toBe(0)
    expect(writes().slice(0, 2)).toEqual(['edit 11 --remove-label reviewed', 'merge 11 --disable-auto'])
  })

  it('does not list an open unarmed PR or a closed armed PR as disarmed', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    const quiet = { labels: { nodes: [] }, autoMergeRequest: null }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
      childNode(3, 'fix(y): second child', { prs: [prNode(12, 'fix/3-second-child', 'd'.repeat(40), quiet)] }),
      childNode(4, 'chore(z): third child', {
        prs: [prNode(13, 'chore/4-third-child', 'e'.repeat(40), { ...armed, state: 'CLOSED' })],
      }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    servePr(12, { state: 'OPEN', labels: [], autoMerge: false })
    servePr(13, { state: 'CLOSED', labels: ['reviewed'], autoMerge: true })
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    expect(run.stdout).toContain('| Disarmed | #11 disarmed |')
    expect(run.stdout).not.toContain('#12')
    expect(run.stdout).not.toContain('#13')
  })

  it('disarms the second PR when the first disarm fails, and exits non-zero naming the PR still armed', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
      childNode(3, 'fix(y): second child', { prs: [prNode(12, 'fix/3-second-child', 'd'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    servePr(12, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('#11')
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      'merge 11 --disable-auto',
      'edit 12 --remove-label reviewed',
      'merge 12 --disable-auto',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    expect(JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '12.json'), 'utf8')).labels).toEqual([])
    expect(JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8')).labels).toEqual([
      { name: 'reviewed' },
    ])
  })
})
