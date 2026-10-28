import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The driver's I/O shell, end to end: a real git repository (a bare origin, the
 * Principal clone, a detached epic worktree) and a stub `gh` that serves canned
 * GraphQL and records every write. Each case asserts what the driver did to git
 * and what it wrote to GitHub, in order.
 */

const DRIVER = path.resolve(import.meta.dirname, '..', '..', 'epic-driver.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

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
    if [[ "$q" == *EpicContainmentBranch* ]]; then
      query containment-branch
      branch=""
      for arg in "$@"; do
        [[ "$arg" == head=* ]] && branch="\${arg#head=}"
      done
      [[ ! -f "$S/branch-unavailable" ]] || { echo "stub gh: branch discovery unavailable" >&2; exit 9; }
      jq -s --arg branch "$branch" '{data:{repository:{pullRequests:{pageInfo:{hasNextPage:false},nodes:[.[][] | select(.headRefName == $branch and (.state == "OPEN" or .state == "CLOSED" or .state == "MERGED"))]}}}}' "$S"/branch-prs-*.json
    elif [[ "$q" == *EpicContainmentPullRequest* ]]; then
      query containment-pull-request
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ ]] || { echo "stub gh: invalid PR number" >&2; exit 9; }
      if [[ -f "$S/pr/$number.native.json" ]]; then
        jq -c '{data:{repository:{pullRequest:.}}}' "$S/pr/$number.native.json"
      else
        jq -s --argjson number "$number" '{data:{repository:{pullRequest:([.[][] | select(.number == $number)] | first // null)}}}' "$S"/branch-prs-*.json
      fi
    elif [[ "$q" == *EpicContainmentIssue* ]]; then
      query containment-issue
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ && -f "$S/uw-$number.json" && -f "$S/containment-$number.json" ]] || {
        echo "stub gh: missing containment issue $number" >&2
        exit 9
      }
      cat "$S/containment-$number.json"
    elif [[ "$q" == *stateReason* && "$q" == *blockedBy* ]]; then
      query uw-graph
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ && -f "$S/uw-$number.json" ]] || {
        echo "stub gh: missing strict graph for $number" >&2
        exit 9
      }
      cat "$S/uw-$number.json"
    elif [[ "$q" == *subIssues* ]]; then
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
    if [[ -f "$S/pr/$3.merge-on-edit.json" ]]; then
      cp "$S/pr/$3.merge-on-edit.json" "$S/pr/$3.native.json"
      jq -c '{state, labels: [.labels.nodes[]], autoMergeRequest}' "$S/pr/$3.native.json" > "$S/pr/$3.json"
      for staged in "$S"/containment-*.json.after-edit "$S"/branch-prs-*.json.after-edit "$S"/uw-*.json.after-edit; do
        [[ -f "$staged" ]] || continue
        cp "$staged" "\${staged%.after-edit}"
        rm "$staged"
      done
      rm "$S/pr/$3.merge-on-edit.json"
    elif [[ ! -f "$S/pr/$3.sticky" ]]; then
      jq -c '.labels = []' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"
    fi ;;
  "pr merge")
    log "merge $3 \${*:4}"
    [[ -f "$S/pr/$3.sticky" ]] || { jq -c '.autoMergeRequest = null' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"; } ;;
  *) echo "stub gh: unhandled $*" >&2; exit 9 ;;
esac
`

export type Sandbox = {
  root: string
  state: string
  origin: string
  principal: string
  epic: string
  env: NodeJS.ProcessEnv
}

let box: Sandbox | undefined
export function cleanupSandbox(): void {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box?.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function sandbox(stack = 'release:\n  model: trunk\n'): Sandbox {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-epic-driver-')))
  const state = path.join(root, 'state')
  const bin = path.join(root, 'bin')
  mkdirSync(path.join(state, 'pr'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'gh'), GH_STUB)
  chmodSync(path.join(bin, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, DRIVER_STATE: state }
  env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL
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

export function sandboxOf(): Sandbox {
  if (!box) throw new Error('no sandbox')
  return box
}

export function writes(): string[] {
  try {
    return readFileSync(path.join(sandboxOf().state, 'writes.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function drive(args: string[], { cwd = sandboxOf().epic, epic = 1 } = {}) {
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

export function detail(text: string): string[] {
  const file = path.join(sandboxOf().root, 'detail.txt')
  writeFileSync(file, text)
  return ['--detail-file', file]
}
