import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
    if [[ -f "$S/comment.fail" ]]; then echo "comment failed" >&2; exit 1; fi
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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
    expect(drive(['review', '--verdict', 'clean', '--coverage', 'a'.repeat(64)]).code).toBe(2)
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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

describe('epic-driver — a child that fix filed (#685)', () => {
  const FIX = readFileSync(path.resolve(import.meta.dirname, '..', 'fix', 'SKILL.md'), 'utf8')

  /** The first ```markdown fence after a lead-in line of fix § Filing: the body fix writes. */
  function template(leadIn: string): string {
    const at = FIX.indexOf(leadIn)
    if (at < 0) throw new Error(`fix/SKILL.md lost the lead-in: ${leadIn}`)
    const body = /```markdown\n([\s\S]*?)```/.exec(FIX.slice(at))?.[1]
    if (!body) throw new Error(`no markdown fence after: ${leadIn}`)
    return body
  }

  const templates: [string, string][] = [
    ['a filed cause', template('`{details}` template')],
    ['the deferral', template('Deferral body, one issue for the whole set')],
  ]
  const filed = (body: string, origin: 'OPEN' | 'CLOSED') => ({
    ...childNode(3, 'fix(x): filed cause', { blockedBy: [[2, origin]] }),
    body,
  })

  it.each(templates)('prints the /goal line while %s waits on its open origin', (_name, body) => {
    const { epic } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child'), filed(body, 'OPEN')])
    const run = drive(['objective'], { cwd: epic })
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('order: #2 → #3')
  })

  it.each(templates)('starts %s once its origin is closed', (_name, body) => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED' }), filed(body, 'CLOSED')])
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toEqual([])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3, branch: 'fix/3-filed-cause' })
  })

  it.each(templates)('refuses %s when it carries no size label', (_name, body) => {
    const { epic } = sandbox()
    const child = filed(body, 'OPEN')
    child.labels = { nodes: [] }
    serveEpic([childNode(2, 'feat(x): first child'), child])
    const run = drive(['objective'], { cwd: epic })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('#3')
    expect(run.stderr).not.toContain('#2')
    expect(run.stdout).not.toContain('/goal')
  })
})

describe('epic-driver — review bound', () => {
  type Comment = string | { body: string; author: string }
  function reviewed(number: number, history: Comment[]): void {
    const nodes = history.map((item) => {
      const { body, author } = typeof item === 'string' ? { body: item, author: ME } : item
      return { body, author: { login: author } }
    })
    const data = { data: { repository: { [`p${number}`]: { comments: { nodes } } } } }
    writeFileSync(path.join(sandboxOf().state, 'reviews.json'), JSON.stringify(data))
  }
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
    reviewed(11, [record('Request changes'), record('Request changes'), quoted])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(run.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })

  it('does not lift the bound when a later review approves', () => {
    openPrChild()
    reviewed(11, [record('Request changes'), record('Request changes'), record('Request changes'), record('Approve')])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(run.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })

  it('resumes a PR with a fix round left', () => {
    openPrChild()
    reviewed(11, [record('Request changes')])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })

  it('does not count review records posted by another login', () => {
    openPrChild()
    reviewed(11, [
      { body: record('Request changes'), author: 'mallory' },
      { body: record('Request changes'), author: 'mallory' },
      record('Request changes'),
    ])
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
    const coverage = createHash('sha256')
      .update(base + merge)
      .digest('hex')
    const review = `<!-- omp-build:epic-review run=${RUN} verdict=clean coverage=${coverage} -->\nclean`
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
  })
})

/**
 * Child #2 merged into origin/main by PR #10, whose commit also ships a hook that
 * leaves a proof file. Returns the coverage the final review is about, and the
 * merge sha beside it — never recovered by splitting a range.
 */
function landedEpic() {
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
  return {
    coverage: createHash('sha256')
      .update(base + merge)
      .digest('hex'),
    base,
    merge,
    merged,
    proof,
  }
}

const reviewMarker = (verdict: 'clean' | 'blocking', coverage: string): Comment => ({
  body: `<!-- omp-build:epic-review run=${RUN} verdict=${verdict} coverage=${coverage} -->\n${verdict}`,
  author: ME,
})

describe('epic-driver — final review and hook refusals', () => {
  it('refuses a clean review while the one fix ticket is still owed', () => {
    const { coverage, merged } = landedEpic()
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [reviewMarker('blocking', coverage)],
    )
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })

    const run = drive(['review', '--verdict', 'clean', '--coverage', coverage])
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a coverage the driver did not ask for, and records the exact one', () => {
    const { coverage, merged } = landedEpic()
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })])
    const run = drive(['review', '--verdict', 'clean', '--coverage', 'd'.repeat(64)])
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
    expect(drive(['review', '--verdict', 'clean', '--coverage', coverage]).code).toBe(0)
  })

  it('does not accept --range, even when a final review is owed', () => {
    const { coverage, base, merge, merged } = landedEpic()
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })])
    const run = drive(['review', '--verdict', 'clean', '--range', `${base}..${merge}`])
    expect(run.code).not.toBe(0)
    expect(writes()).toEqual([])
    expect(drive(['review', '--verdict', 'clean', '--coverage', coverage]).code).toBe(0)
  })

  it('does not certify an old range marker that ends at the same merge', () => {
    const { coverage, base, merge, merged } = landedEpic()
    const old = `<!-- omp-build:epic-review run=${RUN} verdict=clean range=${base}..${merge} -->\nclean`
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })], [{ body: old, author: ME }])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({
      action: 'final-review',
      stage: 'review',
      coverage,
    })
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
    const { coverage, merged } = landedEpic()
    const fix = (author: string) => ({
      ...childNode(3, 'fix(x): epic review', { state: 'CLOSED' }),
      body: '<!-- omp-build:epic-fix -->\n## Acceptance criteria\n- [ ] fixed\n',
      author: { login: author },
    })
    const done = childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })
    serveEpic([done, fix('mallory')], [reviewMarker('blocking', coverage)])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })
    serveEpic([done, fix(ME)], [reviewMarker('blocking', coverage)])
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
    const { coverage, merge, merged } = landedEpic()
    const earlier = { body: `<!-- omp-build:post-merge run=run00000 result=ok sha=${merge} -->\nok`, author: ME }
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [reviewMarker('clean', coverage), earlier],
    )

    const run = drive(['report', '--outcome', 'complete'])

    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`| Post-merge hook | ok at \`${merge}\` (run \`run00000\`) |`)
  })
})

type ForeignHistory = {
  epic: string
  parent1: string
  merge1: string
  second1: string
  tip1: string
  parent2: string
  merge2: string
  second2: string
  tip2: string
}

describe('epic-driver — exact coverage', () => {
  function foreignMerges(): ForeignHistory {
    const { principal, epic } = sandbox()
    git(principal, 'switch', '-q', '-c', 'feat/2-child-one')
    writeFileSync(path.join(principal, 'child1.txt'), 'one\n')
    git(principal, 'add', 'child1.txt')
    git(principal, 'commit', '-qm', 'feat(x): child one (#2)')
    const tip1 = git(principal, 'rev-parse', 'HEAD')
    git(principal, 'switch', '-q', 'main')
    git(principal, 'merge', '--no-ff', tip1, '-m', 'Merge child one')
    const merge1 = git(principal, 'rev-parse', 'HEAD')
    const parent1 = git(principal, 'rev-parse', `${merge1}^1`)
    const second1 = git(principal, 'rev-parse', `${merge1}^2`)

    writeFileSync(path.join(principal, 'foreign.txt'), 'foreign\n')
    git(principal, 'add', 'foreign.txt')
    git(principal, 'commit', '-qm', 'chore: foreign')

    git(principal, 'switch', '-q', '-c', 'feat/3-child-two')
    writeFileSync(path.join(principal, 'child2.txt'), 'two\n')
    git(principal, 'add', 'child2.txt')
    git(principal, 'commit', '-qm', 'feat(x): child two (#3)')
    const tip2 = git(principal, 'rev-parse', 'HEAD')
    git(principal, 'switch', '-q', 'main')
    git(principal, 'merge', '--no-ff', tip2, '-m', 'Merge child two')
    const merge2 = git(principal, 'rev-parse', 'HEAD')
    const parent2 = git(principal, 'rev-parse', `${merge2}^1`)
    const second2 = git(principal, 'rev-parse', `${merge2}^2`)
    git(principal, 'push', '-q', 'origin', 'main')
    return { epic, parent1, merge1, second1, tip1, parent2, merge2, second2, tip2 }
  }

  function serveForeign(history: ForeignHistory, epicComments: Comment[] = []): void {
    const first = prNode(10, 'feat/2-child-one', history.tip1, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: history.merge1, parents: { nodes: [{ oid: history.parent1 }] } },
    })
    const second = prNode(11, 'feat/3-child-two', history.tip2, {
      state: 'MERGED',
      mergedAt: '2026-09-30T12:00:00Z',
      mergeCommit: { oid: history.merge2, parents: { nodes: [{ oid: history.parent2 }] } },
    })
    serveEpic(
      [
        childNode(3, 'feat(x): child two', { state: 'CLOSED', prs: [second] }),
        childNode(2, 'feat(x): child one', { state: 'CLOSED', prs: [first] }),
      ],
      epicComments,
    )
  }

  function names(cwd: string, from: string, to: string): string[] {
    const out = git(cwd, 'diff', '--name-only', '--no-ext-diff', from, to, '--')
    return out ? out.split('\n') : []
  }

  it('returns pair diffs that exclude a foreign merge the old span includes', () => {
    const history = foreignMerges()
    serveForeign(history)
    const run = drive(['next'])
    expect(run.code).toBe(0)
    const exact = createHash('sha256')
      .update(history.parent1 + history.merge1 + history.parent2 + history.merge2)
      .digest('hex')
    const span = createHash('sha256')
      .update(history.parent1 + history.merge2)
      .digest('hex')
    const step = run.json().step
    expect(step).toMatchObject({
      action: 'final-review',
      stage: 'review',
      diffs: [
        { number: 2, firstParent: history.parent1, merge: history.merge1 },
        { number: 3, firstParent: history.parent2, merge: history.merge2 },
      ],
      coverage: exact,
    })
    expect(step).not.toHaveProperty('range')
    expect(step.coverage).not.toBe(span)
    expect(git(history.epic, 'rev-parse', `${history.merge1}^1`)).toBe(history.parent1)
    expect(git(history.epic, 'rev-parse', `${history.merge1}^2`)).toBe(history.second1)
    expect(history.parent1).not.toBe(history.second1)
    const diffs = step.diffs as { firstParent: string; merge: string }[]
    expect(names(history.epic, diffs[0]?.firstParent ?? '', diffs[0]?.merge ?? '')).toEqual(['child1.txt'])
    expect(names(history.epic, diffs[1]?.firstParent ?? '', diffs[1]?.merge ?? '')).toEqual(['child2.txt'])
    expect(names(history.epic, history.parent1, history.merge2)).toContain('foreign.txt')

    expect(drive(['review', '--verdict', 'clean', '--coverage', span]).code).toBe(2)
    expect(writes()).toEqual([])
    const ranged = drive(['review', '--verdict', 'clean', '--range', `${history.parent1}..${history.merge2}`])
    expect(ranged.code).not.toBe(0)
    expect(writes()).toEqual([])
    const accepted = drive(['review', '--verdict', 'clean', '--coverage', exact])
    expect(accepted.code).toBe(0)
    expect(comments()[0]).toContain(`coverage=${exact}`)
    expect(comments()[0]).not.toContain('range=')
  })

  it('does not certify an old range marker that ends at the last merge', () => {
    const history = foreignMerges()
    const old = `<!-- omp-build:epic-review run=${RUN} verdict=clean range=${history.parent1}..${history.merge2} -->`
    serveForeign(history, [{ body: `${old}\nclean`, author: ME }])
    const step = drive(['next']).json().step
    expect(step.action).toBe('final-review')
    expect(step.stage).toBe('review')
    expect(step.action).not.toBe('post-merge')
  })

  it('driver-errors a CLOSED MERGED child with no merge commit', () => {
    sandbox()
    serveEpic([
      childNode(2, 'feat(x): first child', {
        state: 'CLOSED',
        prs: [
          prNode(10, 'feat/2-first-child', 'a'.repeat(40), {
            state: 'MERGED',
            mergedAt: '2026-09-30T10:00:00Z',
            mergeCommit: null,
          }),
        ],
      }),
    ])
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'driver-error' })
    expect(run.json().step.action).not.toBe('complete')
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })

  it('driver-errors when a later CLOSED MERGED child has no merge commit', () => {
    const { merged } = landedEpic()
    serveEpic([
      childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] }),
      childNode(3, 'feat(y): second', {
        state: 'CLOSED',
        prs: [
          prNode(11, 'feat/3-second', 'b'.repeat(40), {
            state: 'MERGED',
            mergedAt: '2026-10-01T00:00:00Z',
            mergeCommit: null,
          }),
        ],
      }),
    ])
    const run = drive(['next'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'driver-error' })
    expect(run.json().step.action).not.toBe('complete')
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
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
    ['review', '--verdict', 'clean', '--coverage', 'a'.repeat(64)],
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
    expect(writes()).toEqual(['merge 10 --disable-auto', 'edit 10 --remove-label reviewed'])
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
      'merge 10 --disable-auto',
      'edit 10 --remove-label reviewed',
      'merge 14 --disable-auto',
      'edit 14 --remove-label reviewed',
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

  it('returns a drop and creates no branch when the epic query says MERGED and mergeCommit is null', () => {
    const { epic } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): first child', {
        comments: [{ body: '<!-- omp-build:goal-stop run=run00000 reason=review-bound -->\nstopped', author: ME }],
        prs: [
          prNode(10, 'feat/2-first-child', 'a'.repeat(40), {
            state: 'MERGED',
            mergedAt: '2026-10-01T00:00:00Z',
            mergeCommit: null,
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

  it('disarms both open armed PRs of one stopped child', () => {
    const epic = sandbox().epic
    const earlier = { body: '<!-- omp-build:goal-stop run=run00000 reason=review-bound -->\nstopped', author: ME }
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', {
        comments: [earlier],
        prs: [
          prNode(10, 'feat/2-first-child', 'a'.repeat(40), armed),
          prNode(14, 'feat/2-other-child', 'b'.repeat(40), armed),
        ],
      }),
      childNode(3, 'fix(y): second child'),
    ])
    servePr(10, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    servePr(14, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3 })
    expect(run.json().reconciled).toEqual([
      { ticket: 2, pr: 10, disarmed: 'disarmed' },
      { ticket: 2, pr: 14, disarmed: 'disarmed' },
    ])
    expect(writes()).toEqual([
      'merge 10 --disable-auto',
      'edit 10 --remove-label reviewed',
      'merge 14 --disable-auto',
      'edit 14 --remove-label reviewed',
    ])
    expect(git(epic, 'branch', '--show-current')).toBe('fix/3-second-child')
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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
    expect(writes().slice(0, 2)).toEqual(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed'])
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
    expect(writes().slice(0, 2)).toEqual(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed'])
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
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
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      'merge 12 --disable-auto',
      'edit 12 --remove-label reviewed',
      `comment 1 <!-- omp-build:goal-report run=${RUN} -->`,
    ])
    expect(JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '12.json'), 'utf8')).labels).toEqual([])
    expect(JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8')).labels).toEqual([
      { name: 'reviewed' },
    ])
  })

  it('names the PR still armed when posting the report fails', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
      childNode(3, 'fix(y): second child', { prs: [prNode(12, 'fix/3-second-child', 'd'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    servePr(12, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    writeFileSync(path.join(sandboxOf().state, 'comment.fail'), '')
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('#11')
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      'merge 12 --disable-auto',
      'edit 12 --remove-label reviewed',
    ])
  })
})
