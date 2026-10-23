import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type CanonicalRecord, decodeHistory, encodeRecord, type History, type Json } from '../../contracts.ts'
import { submission } from '../../testing/record-builders.ts'
import { epicReviewGraph, reviewGraph } from '../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'

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
const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { childSnapshot, epicMandate, framedBodies } = roxabiWorkflowFixtures()

const GH_STUB = `#!/usr/bin/env bash
set -u
S="$DRIVER_STATE"
ME="operator"
log() { printf '%s\\n' "$*" >> "$S/writes.log"; printf '%s\\n' "$*" >> "$S/trace.log"; printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$S/cwd.log"; }
query() { printf 'query %s\\n' "$1" >> "$S/trace.log"; }
case "$1 \${2:-}" in
  "repo view")
    if [[ "$*" == *defaultBranchRef* ]]; then echo "develop"; else echo "o/r"; fi ;;
  "api user") echo "$ME" ;;
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
    else query other; echo '{"data":{"repository":{}}}'; fi ;;
  "api repos/"*)
    resource="$2"
    comments_path='^repos/o/r/issues/([0-9]+)/comments[?]per_page=100[&]page=([0-9]+)$'
    if [[ "$resource" =~ $comments_path ]]; then
      issue="\${BASH_REMATCH[1]}"
      page="\${BASH_REMATCH[2]}"
      file="$S/comments-$issue.json"
      [[ -f "$file" ]] || echo '[]' > "$file"
      jq -c --argjson page "$page" '.[(($page - 1) * 100):($page * 100)]' "$file"
    else
      echo "stub gh: unhandled $*" >&2
      exit 9
    fi ;;
  "api --method")
    [[ "$3" == "POST" && "$4" =~ ^repos/o/r/issues/([0-9]+)/comments$ && "$5" == "-f" && "$6" == body=* ]] || {
      echo "stub gh: unhandled $*" >&2
      exit 9
    }
    issue="\${BASH_REMATCH[1]}"
    body="\${6#body=}"
    file="$S/comments-$issue.json"
    [[ -f "$file" ]] || echo '[]' > "$file"
    id=$(( $(jq 'length' "$file") + 1001 ))
    posted="$(jq -cn --arg author "$ME" --argjson id "$id" --arg body "$body" '{id: $id, body: $body, user: {login: $author}, created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z"}')"
    jq -c --argjson posted "$posted" '. + [$posted]' "$file" > "$S/tmp" && mv "$S/tmp" "$file"
    first="\${body%%$'\\n'*}"
    log "comment $issue $first"
    printf '%s\n' "$posted" ;;
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

function recordHistory(issue: number, comments: Comment[] = []): History {
  return {
    scope: { repository: 'o/r', target: `o/r#${issue}` },
    expectedAuthor: ME,
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `o/r#${issue}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: '2026-10-21T10:00:00Z',
    })),
    diagnostics: [],
  }
}

function framedRecords(issue: number, records: CanonicalRecord[]): Comment[] {
  const comments: Comment[] = []
  for (const record of records) {
    const encoded = encodeRecord(
      { ...record, repository: 'o/r', target: `o/r#${issue}` },
      recordHistory(issue, comments),
      TEST_PROJECTION_CONFIG,
    )
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; '))
    comments.push(...encoded.value.map((body) => ({ body, author: ME })))
  }
  return comments
}

function epicEvent(issue: number, id: string, payload: Record<string, Json>, inputs: string[] = []): CanonicalRecord {
  return {
    version: 1,
    recordId: id,
    runId: RUN,
    operationId: `op-${id}`,
    inputs,
    repository: 'o/r',
    target: `o/r#${issue}`,
    kind: 'epic-event',
    payload,
  }
}

function issueComments(issue: number): Comment[] {
  const raw = JSON.parse(readFileSync(path.join(sandboxOf().state, `comments-${issue}.json`), 'utf8')) as {
    body: string
    user: { login: string }
  }[]
  return raw.map((comment) => ({ body: comment.body, author: comment.user.login }))
}

function eventPayloads(issue: number): Record<string, unknown>[] {
  return decodeHistory(recordHistory(issue, issueComments(issue))).operations.flatMap((operation) =>
    operation.record?.kind === 'epic-event' ? [operation.record.payload as Record<string, unknown>] : [],
  )
}

function epicDecisionHistory(range: string, blocking: boolean): Comment[] {
  const head = range.slice(range.indexOf('..') + 2)
  const graph = epicReviewGraph({ prefix: `epic-${head.slice(0, 8)}`, head })
  const root = {
    ...graph.root,
    payload: { ...graph.root.payload, subject: { kind: 'epic-range' as const, range } },
  }
  const panel = blocking
    ? graph.panel
    : {
        ...graph.panel,
        payload: {
          ...graph.panel.payload,
          rawAttempts: [
            submission({
              id: `child-${graph.panel.recordId}`,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            }),
          ],
          structured: { findings: [] },
          findings: [],
        },
      }
  const decision = blocking
    ? graph.decision
    : {
        ...graph.decision,
        payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, findings: [] } },
      }
  const synthesisContribution = blocking
    ? graph.synthesisContribution
    : {
        ...graph.synthesisContribution,
        payload: {
          ...graph.synthesisContribution.payload,
          rawAttempts: [
            submission({
              id: `child-${graph.synthesisContribution.recordId}`,
              structuredOutput: { status: 'valid', data: decision.payload.judgment },
            }),
          ],
          structured: decision.payload.judgment,
        },
      }
  const records = graph.records.map((record) => {
    if (record.recordId === root.recordId) return root
    if (record.recordId === panel.recordId) return panel
    if (record.recordId === synthesisContribution.recordId) return synthesisContribution
    if (record.recordId === decision.recordId) return decision
    return record
  }) as CanonicalRecord[]
  return framedRecords(1, [
    ...records,
    epicEvent(
      1,
      `${root.recordId}-event`,
      {
        event: 'epic-review',
        run: RUN,
        decisionId: decision.recordId,
        inventoryIds: [root.recordId, graph.synthesis.recordId],
        range,
      },
      [decision.recordId, root.recordId, graph.synthesis.recordId],
    ),
  ])
}

function serveComments(issue: number, comments: Comment[]): void {
  writeFileSync(
    path.join(sandboxOf().state, `comments-${issue}.json`),
    JSON.stringify(
      comments.map((comment, index) => ({
        id: index + 1,
        body: comment.body,
        user: { login: comment.author },
        created_at: '2026-10-21T10:00:00Z',
        updated_at: '2026-10-21T10:00:00Z',
      })),
    ),
  )
}

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
    closedByPullRequestsReferences: { nodes: prs },
    comments: { nodes: [] },
    fixtureComments: comments,
    timelineItems: { nodes: [] },
  }
}

function serveEpic(
  children: { number: number; body?: string; specBody?: string; fixtureComments?: Comment[] }[],
  epicComments: Comment[] = [],
  options: { mandate?: boolean } = {},
): void {
  const framedBody = '## Acceptance criteria\n\n- [ ] works\n'
  const mandate =
    options.mandate === false
      ? []
      : framedBodies(
          [
            epicMandate(
              { repository: 'o/r', target: 'o/r#1' },
              children.map((child) =>
                childSnapshot(
                  { repository: 'o/r', target: `o/r#${child.number}` },
                  // Accepted Spec is authority; live issue body may diverge (unframed/drift).
                  child.specBody ?? child.body ?? framedBody,
                ),
              ),
              { runId: RUN },
            ),
          ],
          ME,
        ).map((body) => ({ body, author: ME }))
  serveComments(1, [...mandate, ...epicComments])
  for (const child of children) serveComments(child.number, child.fixtureComments ?? [])
  const data = {
    data: {
      viewer: { login: ME },
      repository: {
        issue: {
          comments: { nodes: [] },
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

function drive(args: string[], { cwd = sandboxOf().epic, epic = 1 } = {}) {
  const { env } = sandboxOf()
  const command = env.DRIVER_STRACE
    ? ['strace', '-f', '-e', 'trace=openat,write', '-o', env.DRIVER_STRACE, REAL_BUN]
    : [REAL_BUN]
  const out = spawnSync(command[0], [...command.slice(1), DRIVER, ...args, '--epic', String(epic)], {
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
  it('acts on nothing without a confirmed mandate', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')], [], { mandate: false })
    const run = drive(['next'])
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('driver=assisted no confirmed mandate authorizes epic #1')
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
  it('starts the first child from origin/<base>, ignoring a foreign canonical stop event', () => {
    const { epic } = sandbox()
    const forged = framedRecords(2, [
      epicEvent(2, 'foreign-stop', { event: 'goal-stop', run: RUN, reason: 'proof-blocked', detail: '' }),
    ]).map((comment) => ({ ...comment, author: 'mallory' }))
    serveEpic([
      childNode(2, 'feat(x): first child', { comments: forged }),
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
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'foreign-commit' }),
    )
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

  it('disarms, detaches and keeps the branch before recording a canonical stop event', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout', ...detail("watch timed out; it's re-run later")])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({
        event: 'goal-stop',
        run: RUN,
        reason: 'timeout',
        detail: "watch timed out; it's re-run later",
      }),
    )
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'feat/2-first-child')).not.toBe('')
  })

  it('writes no event when the PR is still armed after the disarm', () => {
    armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(1)
    expect(writes().filter((line) => line.startsWith('comment'))).toEqual([])
  })

  it('writes no event when the PR merged before the disarm', () => {
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
    expect(drive(['review', '--range', range]).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a complete report before the goal is complete', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['report', '--outcome', 'complete']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('disarms every armed child PR on drop and posts one canonical report event per run', () => {
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
      expect.stringMatching(/^comment 1 <!-- omp-build-record /),
    ])
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'base-ci-red' }),
    )
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const second = drive(['report', '--outcome', 'drop', '--reason', 'base-ci-red'])
    expect(second.code).toBe(0)
    expect(writes().filter((line) => line.startsWith('comment'))).toHaveLength(1)
  })
})

describe('epic-driver — unframed child', () => {
  it('does not start a child that has no scope', () => {
    const { epic } = sandbox()
    // Genuine unframed: accepted Spec and live body both lack framing.
    // Policy (epic.ts TICKET_STOPS / nextStep → epic-driver ticketStop): record
    // durable goal-stop:no-scope, do not start a branch. Exit 0 after recording
    // is success of that stop receipt — not execution approval.
    const unframed = { ...childNode(2, 'feat(x): first child'), body: '## Needs framing\n' }
    serveEpic([unframed])
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'no-scope' }])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([expect.stringMatching(/^comment 2 <!-- omp-build-record /)])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'no-scope' }),
    )
  })

  it('refuses when live body drifts from the framed accepted Spec', () => {
    const { epic } = sandbox()
    const drifted = {
      ...childNode(2, 'feat(x): first child'),
      body: '## Needs framing\n',
      specBody: '## Acceptance criteria\n\n- [ ] works\n',
    }
    serveEpic([drifted])
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('issue body differs from the approved spec snapshot')
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — review bound', () => {
  function reviewed(number: number, outcomes: { blocking: boolean; author?: string }[]): void {
    const comments = outcomes.flatMap((outcome, index) => {
      const graph = reviewGraph({ prefix: `bound-${number}-${index}`, empty: !outcome.blocking })
      return framedRecords(number, graph.records).map((comment) => ({ ...comment, author: outcome.author ?? ME }))
    })
    serveComments(number, comments)
  }

  function openPrChild(): void {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip)] })])
  }

  it('keeps a PR stopped once its third canonical review is blocking', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }, { blocking: true }, { blocking: true }])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(run.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })

  it('does not lift the bound when a later canonical review is clean', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }, { blocking: true }, { blocking: true }, { blocking: false }])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
  })

  it('resumes a PR with a fix round left', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })

  it('does not count canonical records posted by another login', () => {
    openPrChild()
    reviewed(11, [{ blocking: true, author: 'mallory' }, { blocking: true, author: 'mallory' }, { blocking: true }])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })

  it('reads a canonical review graph after the first 100 REST comment records', () => {
    openPrChild()
    const padding: Comment[] = Array.from({ length: 100 }, (_, index) => ({
      author: ME,
      body: `ordinary historical comment ${index}`,
    }))
    const graph = reviewGraph({ prefix: 'pagination-review' })
    serveComments(11, [...padding, ...framedRecords(11, graph.records)])

    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
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
  it('records canonical hook events without publishing hook output', () => {
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
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      epicDecisionHistory(`${base}..${merge}`, false),
    )

    const run = drive(['hook', '--repo', epic], { cwd: root })

    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ result: 'ok', sha: merge, output: expect.stringContaining('s3cr3t-value') })
    expect(eventPayloads(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'post-merge', run: RUN, result: 'started', sha: merge }),
        expect.objectContaining({ event: 'post-merge', run: RUN, result: 'ok', sha: merge }),
      ]),
    )
    expect(
      issueComments(1)
        .map((comment) => comment.body)
        .join('\n'),
    ).not.toContain('s3cr3t-value')
  })
})

describe('epic-driver — unreadable landing', () => {
  it('drops on it, disarms, and reports through one canonical event', () => {
    sandbox('release:\n  model: trunk\nlanding:\n  mode: squash\n')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const next = drive(['next'])
    expect(next.code).toBe(0)
    expect(next.json().step).toMatchObject({ action: 'drop', stop: 'bad-landing' })

    const report = drive(['report', '--outcome', 'drop', '--reason', 'bad-landing'])
    expect(report.code).toBe(0)
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'bad-landing' }),
    )
  })
})

function landedEpic(files: Record<string, string> = {}): {
  range: string
  merged: Record<string, unknown>
  proof: string
} {
  const { principal, epic, root } = sandbox()
  const proof = path.join(root, 'hook-ran')
  mkdirSync(path.join(principal, 'scripts'))
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), `#!/bin/sh\ntouch '${proof}'\n`)
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
  )
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(principal, name), text)
  const base = git(principal, 'rev-parse', 'HEAD')
  git(principal, 'add', '.')
  git(principal, 'commit', '-qm', 'feat(x): first child (#2)')
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  git(epic, 'fetch', '-q', 'origin')
  if (Object.keys(files).length) git(epic, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
  const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
    state: 'MERGED',
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
  })
  return { range: `${base}..${merge}`, merged, proof }
}

describe('epic-driver — canonical final review history', () => {
  it('uses the exact epic range, complete decision graph, and no free verdict', () => {
    const { range, merged } = landedEpic()
    const history = epicDecisionHistory(range, true)
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })], history)

    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({
        event: 'epic-review',
        run: RUN,
        range,
        inventoryIds: expect.any(Array),
        decisionId: expect.any(String),
      }),
    )
    expect(eventPayloads(1)[0]).not.toHaveProperty('verdict')
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })
    expect(drive(['mark-fix', '--ticket', '999']).code).toBe(2)
    const marked = drive(['mark-fix', '--ticket', '2'])
    expect(marked.code).toBe(0)
    expect(eventPayloads(2)).toContainEqual(expect.objectContaining({ event: 'epic-fix', run: RUN }))
    expect(drive(['review', '--range', range]).code).toBe(2)
  })

  it('refuses to resume a historically stopped child from canonical history', () => {
    sandbox()
    const historical = {
      ...epicEvent(2, 'historic-stop', { event: 'goal-stop', run: 'run00000', reason: 'review-bound', detail: '' }),
      runId: 'run00000',
    }
    serveEpic([
      childNode(2, 'feat(x): first child', { comments: framedRecords(2, [historical]) }),
      childNode(3, 'fix(y): independent child'),
    ])

    const next = drive(['next', '--dry-run'])
    expect(next.json().step).toMatchObject({ action: 'start', ticket: 3 })
    expect(next.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
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
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'ci-blocked' }),
    )
  })

  it('touches nothing on a PR that was never armed', () => {
    child2Pr({})
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    drive(['stop', '--ticket', '2', '--reason', 'proof-blocked'])
    expect(writes()).toEqual([expect.stringMatching(/^comment 2 <!-- omp-build-record /)])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'proof-blocked' }),
    )
  })
})

describe('epic-driver — report', () => {
  it('reports the hook result that completed the goal, even from an earlier run', () => {
    const { range, merged } = landedEpic()
    const merge = range.split('..')[1] ?? ''
    const earlier = framedRecords(1, [
      {
        ...epicEvent(1, 'earlier-hook', {
          event: 'post-merge',
          run: 'run00000',
          result: 'ok',
          sha: merge,
          exitCode: 0,
        }),
        runId: 'run00000',
      },
    ])
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [...epicDecisionHistory(range, false), ...earlier],
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

  it('refuses to stop a ticket that is not a sub-issue', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['stop', '--ticket', '7', '--reason', 'timeout']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it.each([
    ['stop', '--ticket', '2', '--reason', 'timeout'],
    ['review', '--decision-record', 'decision', '--range', `${'a'.repeat(40)}..${'b'.repeat(40)}`],
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

describe('epic-driver — drop disarms without the dashboard', () => {
  it('disarms every armed PR when the base-CI rollup query fails and records the report event', () => {
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
      expect.stringMatching(/^comment 1 <!-- omp-build-record /),
    ])
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'driver-error' }),
    )
  })
})
