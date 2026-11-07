import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'ci-watch.sh')
const owned = new Set<string>()

export type WatchFixture = {
  root: string
  bin: string
  cwd: string
  home: string
}

export type WatchResult = {
  code: number
  stdout: string
  stderr: string
}

type RunOptions = {
  env?: Record<string, string>
  timeout?: string
  mode?: 'merge-on-green' | 'native' | null
  extra?: string[]
  cwd?: string
  interval?: string
}

type Probe = {
  snapshots: string[]
  runs?: string[]
  annotations?: Record<number, string>
  authorized?: boolean
  failRuns?: boolean
}

afterEach(() => {
  for (const root of owned) rmSync(root, { recursive: true, force: true })
  owned.clear()
})

export function fixture(label: string): WatchFixture {
  const root = mkdtempSync(join(tmpdir(), `ci-watch-${label}-`))
  owned.add(root)
  const bin = join(root, 'bin')
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  mkdirSync(bin)
  mkdirSync(cwd)
  mkdirSync(home)
  return { root, bin, cwd, home }
}

export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if ((!key.startsWith('GIT_') || key === 'GIT_CONFIG_GLOBAL') && value !== undefined) env[key] = value
  }
  return env
}

export function plantBase(cwd: string, files: Record<string, string> = {}): void {
  const env = gitEnv()
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd, env })
  execFileSync('git', ['config', 'user.email', 'ci-watch@test'], { cwd, env })
  execFileSync('git', ['config', 'user.name', 'ci-watch'], { cwd, env })
  for (const [relative, content] of Object.entries(files)) {
    const path = join(cwd, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  execFileSync('git', ['add', '-A'], { cwd, env })
  execFileSync('git', ['commit', '-qm', 'base', '--allow-empty'], { cwd, env })
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd, env })
}

export function installGh(box: WatchFixture, script: string): void {
  const path = join(box.bin, 'gh')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

export function installProbeGh(box: WatchFixture, probe: Probe): void {
  const runs = probe.runs ?? [page()]
  const annotations = probe.annotations ?? {}
  const head = 'a'.repeat(40)
  const base = 'b'.repeat(40)
  const record = {
    version: 1,
    kind: 'grant',
    operationId: 'watch-fixture',
    repositoryId: 1,
    pullRequestId: 2,
    pullRequest: 7,
    headSha: head,
    baseRef: 'main',
    baseSha: base,
    lane: 'reviewed',
    source: 'native',
    previous: null,
    evidence: 'review:fixture',
  }
  const comments =
    probe.authorized === false
      ? []
      : [
          {
            id: 3,
            node_id: 'COMMENT',
            user: { id: 101, type: 'User' },
            performed_via_github_app: null,
            body: `<!-- kit-head-authorization:v1 -->\n${JSON.stringify(record)}`,
          },
        ]
  writeFileSync(join(box.root, 'auth-repo.json'), JSON.stringify({ id: 1 }))
  writeFileSync(
    join(box.root, 'auth-pr.json'),
    JSON.stringify({
      id: 2,
      number: 7,
      user: { id: 101 },
      head: { sha: head },
      base: { sha: base, ref: 'main', repo: { id: 1 } },
    }),
  )
  writeFileSync(join(box.root, 'auth-comments.json'), JSON.stringify(comments))
  writeFileSync(
    join(box.root, 'auth-proof.json'),
    JSON.stringify({
      data: {
        node: {
          id: 'COMMENT',
          fullDatabaseId: '3',
          lastEditedAt: null,
          repository: { fullDatabaseId: '1' },
          pullRequest: { number: 7, fullDatabaseId: '2' },
        },
      },
    }),
  )
  writeSequence(box.root, 'snap', probe.snapshots)
  writeSequence(box.root, 'runs', runs)
  for (const [id, body] of Object.entries(annotations)) writeFileSync(join(box.root, `annotations.${id}.json`), body)
  installGh(
    box,
    `#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")/.."
next() {
  local n=0 f="$d/$1.count"
  if [[ -f "$f" ]]; then n=$(cat "$f"); fi
  n=$((n + 1))
  echo "$n" > "$f"
  if (( n > $2 )); then n=$2; fi
  cat "$d/$1.$n.json"
}
if [[ "$1" == "pr" && "$2" == "view" ]]; then next snap ${probe.snapshots.length}; exit 0; fi
if [[ "$1" == "run" && "$2" == "list" ]]; then exit 0; fi
if [[ "$1" == "run" && "$2" == "view" ]]; then exit 0; fi
if [[ "$1" == "api" ]]; then
  args="$*"
  echo "$args" >> "$d/api.log"
  case "$args" in
    *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) ${probe.failRuns ? 'exit 1' : `next runs ${runs.length}`} ;;
    "api --include repos/acme/app/actions/variables?per_page=100&page=1") printf 'HTTP/2 200\\r\\nContent-Type: application/json\\r\\n\\r\\n%s\\n' '{"total_count":4,"variables":[{"name":"HEAD_AUTH_REPOSITORY_ID","value":"1"},{"name":"HEAD_AUTH_OPERATOR_IDS","value":"[101]"},{"name":"HEAD_AUTH_APP_ID","value":"200"},{"name":"HEAD_AUTH_BOT_USER_ID","value":"201"}]}' ;;
    "api repos/acme/app") cat "$d/auth-repo.json" ;;
    "api repos/acme/app/pulls/7") cat "$d/auth-pr.json" ;;
    "api repos/acme/app/git/ref/heads/main") printf '%s\\n' '{"ref":"refs/heads/main","object":{"sha":"${base}"}}' ;;
    *issues/7/comments*) printf 'HTTP/2 200\\r\\nContent-Type: application/json\\r\\n\\r\\n'; cat "$d/auth-comments.json" ;;
    "api graphql "*) cat "$d/auth-proof.json" ;;
    *check-runs/*/annotations*) id="\${args#*check-runs/}"; cat "$d/annotations.\${id%%/*}.json" ;;
    *) echo "unexpected gh api: $args" >&2; exit 70 ;;
  esac
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 70
`,
  )
}

function writeSequence(root: string, name: string, values: string[]): void {
  for (const [index, value] of values.entries()) writeFileSync(join(root, `${name}.${index + 1}.json`), value)
}

export function runWatch(box: WatchFixture, options: RunOptions = {}): WatchResult {
  const modeArgs = options.mode === null ? [] : ['--merge-mode', options.mode ?? 'merge-on-green']
  const extra = options.extra ?? []
  const baseArgs = extra.includes('--base') ? [] : ['--base', 'main']
  const args = [
    '7',
    '--interval',
    options.interval ?? '0',
    '--timeout',
    options.timeout ?? '30s',
    ...modeArgs,
    ...baseArgs,
    '--repo',
    'acme/app',
    ...extra,
  ]
  const cwd = options.cwd ?? box.cwd
  if (!existsSync(join(cwd, '.git'))) plantBase(cwd)
  const env = {
    ...process.env,
    HEAD_AUTH_REPOSITORY_ID: '1',
    HEAD_AUTH_OPERATOR_IDS: '[101]',
    HEAD_AUTH_APP_ID: '200',
    HEAD_AUTH_BOT_USER_ID: '201',
    HOME: box.home,
    PATH: `${box.bin}:${process.env.PATH}`,
    ...options.env,
  }
  try {
    const stdout = execFileSync(SCRIPT, args, { encoding: 'utf8', env, cwd })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
      const failed = error as { status: number; stdout?: string; stderr?: string }
      return { code: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
    }
    throw error
  }
}

export function startWatch(box: WatchFixture, options: RunOptions = {}): ChildProcess {
  const extra = options.extra ?? []
  const modeArgs = options.mode === null ? [] : ['--merge-mode', options.mode ?? 'merge-on-green']
  const args = [
    '7',
    '--interval',
    options.interval ?? '1',
    '--timeout',
    options.timeout ?? '30s',
    ...modeArgs,
    '--base',
    'main',
    '--repo',
    'acme/app',
    ...extra,
  ]
  if (!existsSync(join(box.cwd, '.git'))) plantBase(box.cwd)
  return spawn(SCRIPT, args, {
    cwd: options.cwd ?? box.cwd,
    env: {
      ...process.env,
      HEAD_AUTH_REPOSITORY_ID: '1',
      HEAD_AUTH_OPERATOR_IDS: '[101]',
      HEAD_AUTH_APP_ID: '200',
      HEAD_AUTH_BOT_USER_ID: '201',
      HOME: box.home,
      PATH: `${box.bin}:${process.env.PATH}`,
      ...options.env,
    },
    stdio: 'pipe',
  })
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}

export async function waitFor(path: string, expected: string, milliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim() === expected) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${path} to contain ${expected}`)
}

export function read(box: WatchFixture, name: string): string {
  const path = join(box.root, name)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}

export function page(
  ...runs: { id: number; status: string; started_at: string | null; conclusion?: string | null }[]
): string {
  return JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map((run) => ({
      name: 'merge-on-green',
      conclusion: run.status === 'completed' ? 'success' : null,
      ...run,
    })),
  })
}

export { snapshot } from './ci-watch-snapshot.ts'
