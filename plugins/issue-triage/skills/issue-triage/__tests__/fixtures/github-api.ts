/**
 * Isolates GitHub for tests that run a pasteable triage recipe with the real
 * Bun and the real CLI (#762). Nothing on the startup path is replaced: Bun is
 * the one on PATH, and it discovers `bunfig.toml` and `.env` exactly as it does
 * for an operator. Only the transport is redirected:
 *
 * - `HTTPS_PROXY` points Bun's fetch at an in-process CONNECT proxy, which
 *   terminates TLS for `api.github.com` with a throwaway certificate trusted
 *   through `NODE_EXTRA_CA_CERTS`, and answers the REST and GraphQL calls
 *   triage makes. Any other host is refused.
 * - `gh` on PATH is a stub that logs its cwd, `ENV_SENTINEL` and argv. It
 *   answers repository, auth, and init label-list/create calls without replacing Bun.
 *
 * The proxy lives in the test process, so a child must be awaited (`run`), not
 * spawned synchronously: a sync spawn would block the server it talks to.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

const SKILLS = path.resolve(import.meta.dirname, '../../..')
export const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

export type Issue = {
  repo: string
  number: number
  nodeId: string
  title: string
  body: string
  type?: string
  parent?: number
  parentRepo?: string
  blockedBy: number[]
}

export type Call = { method: string; path: string; authorization: string; op: string }

export type GitHubFake = {
  /** `HTTPS_PROXY` value. */
  proxy: string
  /** PEM file to trust through `NODE_EXTRA_CA_CERTS`. */
  ca: string
  /** Every issue, seeded and created, keyed `owner/repo#n`. */
  issues: Map<string, Issue>
  /** Issues created through `POST /repos/:o/:r/issues`, in order. */
  created: Issue[]
  calls: Call[]
  /** GraphQL operations that always answer with an error (e.g. `addSubIssue`). */
  fail: Set<string>
  /** GraphQL operation invocation numbers that answer with an error. */
  failOnCall: Map<string, number>
  close(): Promise<void>
}

const ISSUE_TYPES = ['feat', 'fix', 'docs', 'chore'].map((name) => ({
  id: `IT_${name}`,
  name,
  color: 'GRAY',
  isEnabled: true,
}))

function certificate(dir: string): { key: string; cert: string } {
  const key = path.join(dir, 'api.github.com.key')
  const cert = path.join(dir, 'api.github.com.pem')
  // biome-ignore format: one openssl invocation
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=api.github.com', '-addext', 'subjectAltName=DNS:api.github.com'],
    { stdio: 'pipe' })
  return { key, cert }
}

/** Starts the fake; `seed` lists existing issues as `owner/repo#n`. */
export async function startGitHub(dir: string, seed: string[]): Promise<GitHubFake> {
  const { key, cert } = certificate(dir)
  const issues = new Map<string, Issue>()
  const created: Issue[] = []
  const calls: Call[] = []
  const fail = new Set<string>()
  const failOnCall = new Map<string, number>()
  const operationCalls = new Map<string, number>()
  const byNode = (id: unknown): Issue | undefined => {
    for (const issue of issues.values()) {
      if (issue.nodeId === id) return issue
    }
    return undefined
  }
  const add = (repo: string, number: number, title = '', body = ''): Issue => {
    const issue: Issue = { repo, number, nodeId: `I_${repo}#${number}`, title, body, blockedBy: [] }
    issues.set(`${repo}#${number}`, issue)
    return issue
  }
  for (const ref of seed) {
    const [repo, n] = ref.split('#')
    add(repo, Number(n), `seed ${ref}`)
  }
  let next = 100

  function graphql(op: string, vars: Record<string, unknown>, query: string): { status: number; data: unknown } {
    const call = (operationCalls.get(op) ?? 0) + 1
    operationCalls.set(op, call)
    if (fail.has(op) || failOnCall.get(op) === call) {
      return { status: 200, data: { errors: [{ message: `${op} refused by the fixture` }] } }
    }
    if (op === 'parent') {
      const issue = issues.get(`${vars.owner}/${vars.repo}#${vars.number}`)
      if (!issue) return { status: 200, data: { errors: [{ message: 'unknown issue' }] } }
      const parent = issue.parent
        ? {
            number: issue.parent,
            ...(/\brepository\s*{\s*nameWithOwner\b/.test(query)
              ? { repository: { nameWithOwner: issue.parentRepo ?? issue.repo } }
              : {}),
          }
        : null
      return { status: 200, data: { data: { repository: { issue: { parent } } } } }
    }
    if (op === 'issueTypes') {
      return { status: 200, data: { data: { organization: { id: 'O', issueTypes: { nodes: ISSUE_TYPES } } } } }
    }
    if (op === 'updateIssueIssueType') {
      const issue = byNode(vars.issueId)
      const type = ISSUE_TYPES.find((t) => t.id === vars.issueTypeId)
      if (!issue || !type) return { status: 200, data: { errors: [{ message: 'unknown node' }] } }
      issue.type = type.name
      return { status: 200, data: { data: { updateIssueIssueType: { issue: { id: issue.nodeId } } } } }
    }
    if (op === 'addSubIssue') {
      const parent = byNode(vars.parentId)
      const child = byNode(vars.childId)
      if (!parent || !child) return { status: 200, data: { errors: [{ message: 'unknown node' }] } }
      child.parent = parent.number
      if (parent.repo === child.repo) delete child.parentRepo
      else child.parentRepo = parent.repo
      return { status: 200, data: { data: { addSubIssue: { issue: { number: parent.number } } } } }
    }
    if (op === 'removeSubIssue') {
      const parent = byNode(vars.parentId)
      const child = byNode(vars.childId)
      if (!parent || !child || child.parent !== parent.number || (child.parentRepo ?? child.repo) !== parent.repo) {
        return { status: 200, data: { errors: [{ message: 'unknown parent relationship' }] } }
      }
      delete child.parent
      delete child.parentRepo
      return { status: 200, data: { data: { removeSubIssue: { issue: { number: parent.number } } } } }
    }
    if (op === 'addBlockedBy') {
      const issue = byNode(vars.issueId)
      const blocking = byNode(vars.blockingId)
      if (!issue || !blocking) return { status: 200, data: { errors: [{ message: 'unknown node' }] } }
      if (!issue.blockedBy.includes(blocking.number)) issue.blockedBy.push(blocking.number)
      return { status: 200, data: { data: { addBlockedBy: { issue: { number: issue.number } } } } }
    }
    return { status: 400, data: { message: `the fixture does not answer the ${op} operation` } }
  }

  const api = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const url = req.url ?? ''
      const reply = (status: number, data: unknown, op: string) => {
        calls.push({ method: req.method ?? '', path: url, authorization: req.headers.authorization ?? '', op })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const rest = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/.exec(url)
      if (rest && req.method === 'POST' && !rest[2]) {
        const payload = JSON.parse(raw) as { title: string; body?: string }
        const issue = add(rest[1], ++next, payload.title, payload.body ?? '')
        created.push(issue)
        return reply(
          201,
          {
            number: issue.number,
            html_url: `https://github.com/${rest[1]}/issues/${issue.number}`,
            node_id: issue.nodeId,
          },
          'create',
        )
      }
      if (rest && req.method === 'GET' && rest[2]) {
        const issue = issues.get(`${rest[1]}#${rest[2]}`)
        return issue
          ? reply(200, { number: issue.number, node_id: issue.nodeId }, 'node')
          : reply(404, { message: 'Not Found' }, 'node')
      }
      if (url === '/graphql' && req.method === 'POST') {
        const { query, variables } = JSON.parse(raw) as { query: string; variables: Record<string, unknown> }
        const op =
          /\b(addSubIssue|removeSubIssue|addBlockedBy|updateIssueIssueType|issueTypes)\b/.exec(query)?.[1] ??
          (query.includes('issue(number:') ? 'parent' : 'unknown')
        const { status, data } = graphql(op, variables, query)
        return reply(status, data, op)
      }
      return reply(404, { message: `no fixture route ${req.method} ${url}` }, 'unknown')
    })
  })
  const tlsOptions = { key: readFileSync(key), cert: readFileSync(cert) }
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  proxy.on('connect', (req, socket) => {
    if (req.url !== 'api.github.com:443') {
      calls.push({ method: 'CONNECT', path: req.url ?? '', authorization: '', op: 'refused' })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    api.emit('connection', new tls.TLSSocket(socket, { isServer: true, ...tlsOptions }))
  })
  const listening = Promise.withResolvers<void>()
  proxy.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const { port } = proxy.address() as AddressInfo
  return {
    proxy: `http://127.0.0.1:${port}`,
    ca: cert,
    issues,
    created,
    calls,
    fail,
    failOnCall,
    close: () => {
      const closed = Promise.withResolvers<void>()
      proxy.closeAllConnections()
      proxy.close(() => closed.resolve())
      return closed.promise
    },
  }
}

/** One stub `gh` call: its cwd, the `ENV_SENTINEL` it inherited, and its argv. */
export type GhCall = { cwd: string; env: string; args: string }

const GH = `#!/usr/bin/env bash
set -u
printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${ENV_SENTINEL:-}" "$*" >> "$GH_LOG"
case "$1 \${2:-}" in
  "repo view")
    url=$(git remote get-url origin 2>/dev/null) || { echo "gh: no git remote here" >&2; exit 1; }
    url=\${url%.git}; printf '%s\\n' "\${url#https://github.com/}" ;;
  "api graphql")
    if [ -n "\${GH_PARENT_LOOKUP_EXIT:-}" ]; then
      echo "gh: parent lookup failed" >&2
      exit "$GH_PARENT_LOOKUP_EXIT"
    fi
    query= filter=
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -f|-F) case "$2" in query=*) query=\${2#query=} ;; esac; shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    repo_pattern='repository\\(owner:"([^"]*)",name:"([^"]*)"\\)'
    if [[ "$query" =~ $repo_pattern ]]; then
      parent_repo=\${GH_PARENT_REPO:-\${BASH_REMATCH[1]}/\${BASH_REMATCH[2]}}
    else
      echo "gh: fixture parent query has no explicit repository" >&2
      exit 9
    fi
    compact=\${query//[[:space:]]/}
    repository_requested=false
    case "$compact" in *parent\\{numberrepository\\{nameWithOwner\\}\\}*) repository_requested=true ;; esac
    jq -cn --arg repo "$parent_repo" --argjson number "\${GH_PARENT:-null}" \\
      --argjson repository_requested "$repository_requested" \\
      '{data:{repository:{issue:{parent:(if $number == null then null else ({number:$number} + (if $repository_requested then {repository:{nameWithOwner:$repo}} else {} end)) end)}}}}' |
      jq -r "$filter" ;;
  "auth token") printf '%s\\n' "\${GH_AUTH_TOKEN:-fixture}" ;;
  "label list") if [ -n "\${GH_LABELS_FILE:-}" ] && [ -f "$GH_LABELS_FILE" ]; then cat "$GH_LABELS_FILE"; fi ;;
  "label create")
    if [ -n "\${GH_LABELS_FILE:-}" ]; then
      printf '%s\\n' "$3" >> "$GH_LABELS_FILE"
    fi ;;
  "issue list") printf '[]\\n' ;;
  "issue edit") ;;
  *) echo "stub gh: unhandled $*" >&2; exit 9 ;;
esac
`

export function writeGh(bin: string): void {
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'gh'), GH)
  chmodSync(path.join(bin, 'gh'), 0o755)
}

export function ghCalls(log: string): GhCall[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [cwd, env, args] = line.split('\t')
      return { cwd, env, args }
    })
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): void {
  // biome-ignore format: one git invocation
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: { PATH: '/usr/bin:/bin', ...GIT_ENV }, stdio: 'pipe' })
}

/**
 * A committed, clean checkout whose `origin` is `https://github.com/<slug>.git`.
 * `files` are committed with it (startup configuration included).
 */
export function checkout(dir: string, slug: string, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`)
  writeFileSync(path.join(dir, 'README.md'), 'checkout\n')
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return realpathSync(dir)
}

/**
 * Checkout-controlled Bun startup: a tracked `bunfig.toml` preload that appends
 * `<cwd>\t<ENV_SENTINEL>` to `sentinel`, prints `forged` and exits 0 before the
 * script it precedes, plus a `.env` that sets `ENV_SENTINEL=checkout-dotenv`.
 */
export function hostileStartup(sentinel: string, forged: string, extra = ''): Record<string, string> {
  return {
    'bunfig.toml': 'preload = ["./startup.ts"]\n',
    'startup.ts': [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(sentinel)}, \`\${process.cwd()}\\t\${process.env.ENV_SENTINEL ?? ''}\\n\`)`,
      extra,
      `console.log(${JSON.stringify(forged)})`,
      'process.exit(0)',
      '',
    ].join('\n'),
    '.env': 'ENV_SENTINEL=checkout-dotenv\n',
  }
}

/**
 * Plants Bun startup files in a trusted directory copy: a preload that only
 * records `<cwd>\t<ENV_SENTINEL>` to `$BUN_STARTUP_LOG` and lets the script run,
 * and a `.env` that sets `ENV_SENTINEL=trusted-dotenv`. The log shows where Bun
 * started and whether it loaded an env file; it is empty when Bun started
 * anywhere else.
 */
export function observeStartup(dir: string): void {
  writeFileSync(path.join(dir, 'bunfig.toml'), 'preload = ["./observe-startup.ts"]\n')
  writeFileSync(
    path.join(dir, 'observe-startup.ts'),
    [
      "import { appendFileSync } from 'node:fs'",
      "const line = [process.cwd(), process.env.ENV_SENTINEL ?? ''].join('\\t')",
      "if (process.env.BUN_STARTUP_LOG) appendFileSync(process.env.BUN_STARTUP_LOG, line + '\\n')",
      '',
    ].join('\n'),
  )
  writeFileSync(path.join(dir, '.env'), 'ENV_SENTINEL=trusted-dotenv\n')
}

export function startupLog(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * A copy of this plugin's `skills/` tree under `<dir>/issue-triage/skills`,
 * tests excluded, as an installed plugin would hold it: its own git checkout
 * whose origin is `Trusted/plugins`, with startup observed in the triage
 * directory. Returns the plugin root and the real path of `triage.ts`.
 */
export function trustedTriage(dir: string): { pluginRoot: string; script: string } {
  const pluginRoot = path.join(dir, 'issue-triage')
  cpSync(SKILLS, path.join(pluginRoot, 'skills'), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('__tests__'),
  })
  checkout(pluginRoot, 'Trusted/plugins')
  const script = realpathSync(path.join(pluginRoot, 'skills', 'issue-triage', 'triage.ts'))
  observeStartup(path.dirname(script))
  return { pluginRoot: realpathSync(pluginRoot), script }
}

/** The environment of a recipe run: nothing inherited from the test process. */
export function recipeEnv(fake: GitHubFake, bin: string, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${bin}:${path.dirname(REAL_BUN)}:/usr/bin:/bin`,
    HOME: path.dirname(bin),
    GITHUB_TOKEN: 'fixture',
    HTTPS_PROXY: fake.proxy,
    NODE_EXTRA_CA_CERTS: fake.ca,
    ...GIT_ENV,
    ...extra,
  }
}

export type Ran = { code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }

/**
 * Runs `script` under an owned Bash process group. A deadline reports SIGKILL
 * for the owned run even when Bash had already exited while a descendant held a
 * pipe open; a normal close preserves Bash's code and signal.
 */
export function run(script: string, cwd: string, env: Record<string, string>, timeoutMs = 10_000): Promise<Ran> {
  const { promise, resolve, reject } = Promise.withResolvers<Ran>()
  const child = spawn('bash', ['-c', script], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let settled = false

  const cleanup = () => {
    clearTimeout(deadline)
    child.removeListener('error', onError)
    child.removeListener('close', onClose)
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  const settle = (result: Ran) => {
    if (settled) return
    settled = true
    cleanup()
    resolve(result)
  }
  const rejectOnce = (error: Error) => {
    if (settled) return
    settled = true
    cleanup()
    reject(error)
  }
  const disposeGroup = () => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const onError = (error: Error) => {
    try {
      disposeGroup()
    } catch (cleanupError) {
      rejectOnce(cleanupError as Error)
      return
    }
    rejectOnce(error)
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    try {
      disposeGroup()
    } catch (error) {
      rejectOnce(error as Error)
      return
    }
    settle({ code, stdout, stderr, signal })
  }
  const deadline = setTimeout(() => {
    try {
      disposeGroup()
    } catch (error) {
      rejectOnce(error as Error)
      return
    }
    settle({ code: null, stdout, stderr, signal: 'SIGKILL' })
  }, timeoutMs)

  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  child.once('error', onError)
  child.once('close', onClose)
  return promise
}

/**
 * The lines of the first ```bash fence after `anchor` in `markdown` that follow
 * its `… then:` comment — the part an operator runs once the payload files exist.
 */
export function recipeAfterWrite(markdown: string, anchor: string): string[] {
  const start = markdown.indexOf(anchor)
  if (start < 0) throw new Error(`${anchor} missing`)
  const fence = /```bash\n([\s\S]*?)```/.exec(markdown.slice(start))?.[1]
  if (!fence) throw new Error(`no bash fence after ${anchor}`)
  const lines = fence.split('\n')
  const marker = lines.findIndex((line) => /^#.*\bthen:\s*$/.test(line))
  if (marker < 0) throw new Error(`no "… then:" comment in the fence after ${anchor}`)
  return lines.slice(marker + 1).filter((line) => line.trim() !== '')
}
