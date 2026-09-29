/**
 * Deterministic core `/feature` uses: open a PR, bound the review loop, and land.
 * `detectPrincipal` names the base when `landPr` has none. No worktree driver.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Absolute real path of `ci-watch.sh` next to this module — runnable without `skill://`. */
function ciWatchSh() {
  return realpathSync(fileURLToPath(new URL('../ci-watch/ci-watch.sh', import.meta.url)))
}

const PRINCIPALS = ['staging', 'main', 'master']

/** Hook vars that redirect git. Same set as check-principal-branch.sh git_probe. */
const GIT_HOOK_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
]

function stripGitHookEnv(env = process.env) {
  const out = { ...env }
  for (const key of GIT_HOOK_VARS) delete out[key]
  return out
}

async function git(cwd, args) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    cwd,
    env: stripGitHookEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
  }
  return stdout.trim()
}

const fetched = new Set()

export function pickPrincipal(present) {
  for (const b of PRINCIPALS) {
    if (present.has(b)) return b
  }
  return null
}

async function refExists(cwd, ref) {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function fetchOrigin(cwd) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (fetched.has(root)) return
  await git(cwd, ['fetch', 'origin', '--prune'])
  fetched.add(root)
}

export async function detectPrincipal(cwd) {
  await fetchOrigin(cwd)
  const present = new Set()
  for (const b of PRINCIPALS) {
    if ((await refExists(cwd, `refs/remotes/origin/${b}`)) || (await refExists(cwd, `refs/heads/${b}`))) {
      present.add(b)
    }
  }
  const name = pickPrincipal(present)
  if (!name) throw new Error('no principal branch (staging|main|master)')
  return name
}

/**
 * The `gh` client. A non-zero exit throws an error carrying the *payload* —
 * `exitCode`, `stderr`, `stdout` — next to the rendered message, because a caller that
 * has to classify a failure (`openPr`'s duplicate-head race) must read what GitHub
 * answered rather than the argv it was handed.
 */
async function gh(cwd, args) {
  const proc = Bun.spawn(['gh', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    const error = new Error(`gh ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
    throw Object.assign(error, { exitCode: code, stderr, stdout })
  }
  return stdout.trim()
}

/** First 200 characters of a client response, for an error message that names what arrived. */
function preview(raw) {
  const text = String(raw ?? '')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || '(empty)'
}

/** GitHub's own wording when a head→base pair already has an open PR. */
const DUPLICATE_HEAD = /\ba pull request already exists\b/i

/**
 * What a failed `gh` call *answered*: its HTTP status and its output — never the argv.
 *
 * `gh()` renders `gh <argv> failed (<code>): <stderr>`, and the argv of a create carries
 * `title=` and `body=` — strings the caller supplied. Any predicate that matches the
 * rendered message is therefore reading its own input back: a PR titled
 * "fix: a pull request already exists on re-entry" would satisfy it. So the payload is
 * read from the structured fields when the client provides them, and otherwise from the
 * stderr tail only — everything after the *last* `failed (N):` marker, which is where
 * `gh()` puts the client's output and past anything the caller wrote.
 *
 * @param {unknown} error
 * @returns {{ status: number | null, text: string } | null}
 */
function ghFailurePayload(error) {
  if (error !== null && typeof error === 'object') {
    const fields = ['stderr', 'stdout', 'body']
      .map((key) => /** @type {Record<string, unknown>} */ (error)[key])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
    if (fields.length) {
      const text = fields.join('\n')
      return { status: httpStatus(error, text), text }
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const tail = message.match(/^[\s\S]*\sfailed \(\d+\):[ \t]*([\s\S]*)$/)
  if (!tail) return null
  return { status: httpStatus(error, tail[1]), text: tail[1] }
}

/** @param {unknown} error @param {string} text */
function httpStatus(error, text) {
  const declared = Number(/** @type {Record<string, unknown> | null | undefined} */ (error)?.status)
  if (Number.isInteger(declared) && declared > 0) return declared
  const found = text.match(/\bHTTP[\s:]*(\d{3})\b/i) || text.match(/\((?:HTTP\s*)?(\d{3})\)/)
  return found ? Number(found[1]) : null
}

/** `errors[].message` out of a JSON error body embedded in the client's output, if any. */
function apiErrorMessages(text) {
  const start = text.indexOf('{')
  if (start === -1) return []
  try {
    const parsed = JSON.parse(text.slice(start))
    if (!Array.isArray(parsed?.errors)) return []
    return parsed.errors.map((e) => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * `true` only when GitHub itself refused the create because the head already has an open
 * PR: status 422, and a duplicate-head message among `errors[].message` or, failing a
 * JSON body, in the client's output. Classified on the answer, never on the request.
 *
 * @param {unknown} error
 */
function isDuplicateHeadFailure(error) {
  const payload = ghFailurePayload(error)
  if (payload === null) return false
  if (payload.status !== null && payload.status !== 422) return false
  const messages = apiErrorMessages(payload.text)
  if (messages.length) return messages.some((m) => DUPLICATE_HEAD.test(m))
  return DUPLICATE_HEAD.test(payload.text)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireField(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`openPr: ${label} is required, got ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/** GitHub's own closing grammar — `skills/promote/lib/closing-issues.ts` is the SSOT for reading it back. */
function closesIssue(text, issue) {
  return new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#${issue}\b`, 'i').test(text)
}

/**
 * The body always carries `Closes #<issue>`: that keyword is the only machine-readable
 * link from the merged PR back to its ticket, and `/promote` re-emits exactly it on the
 * staging→main PR. A body written without it silently leaves the ticket open forever.
 */
function bodyFor(body, issue) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (closesIssue(text, issue)) return text
  return text ? `${text}\n\nCloses #${issue}` : `Closes #${issue}`
}

/**
 * The open PR for `head`→`base`, or `null`. Never guesses: a response that is not a
 * JSON array throws rather than reading as "none open", because "none open" is the
 * answer that opens a second PR on a branch that already has one.
 *
 * Exported so `/feature` re-entry can look up an existing PR before §6.2 without
 * creating one via `openPr`.
 *
 * @param {string} cwd
 * @param {string} head
 * @param {string} base
 * @param {(cwd: string, args: string[]) => Promise<string>} [ghFn]
 * @returns {Promise<number | null>}
 */
export async function findOpenPr(cwd, head, base, ghFn = gh) {
  const raw = await ghFn(cwd, ['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'number'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned no JSON — ${preview(raw)}`)
  }
  if (!Array.isArray(data)) {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned no array — ${preview(raw)}`)
  }
  const numbers = data.map((entry) => entry?.number).filter((n) => Number.isInteger(n) && n > 0)
  if (numbers.length !== data.length) {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned an entry with no PR number — ${preview(raw)}`)
  }
  if (numbers.length === 0) return null
  // Degenerate but possible (a PR reopened against the same pair): the oldest is the
  // one the branch's history belongs to, and picking it is deterministic.
  return Math.min(...numbers)
}

/**
 * Open the pull request for a feature branch — as a call, not as a sentence.
 *
 * The number is the `number` field of the client's own response, or nothing at
 * all. A reply's wording is never parsed for a PR id.
 *
 * Client injection follows `landPr(cwd, pr, { gh })`: the tests drive a stub, never a
 * real `gh`, so no test can open, label or merge a real pull request.
 *
 * Contract:
 *
 * | Case | Result |
 * |---|---|
 * | no open PR for `head`→`base` | `{ number, status: 'created' }` |
 * | one already open for that pair | `{ number, status: 'existing' }` — idempotent; re-running mode 2 after a crash never opens a second PR |
 * | the create races another opener | `{ number, status: 'existing' }` — GitHub's 422 is re-read as a lookup, not swallowed. The race is classified on the client's exit payload (status + `errors[].message`, or its stderr), never on the rendered message, which embeds this caller's own `title=` and `body=` |
 * | the client fails | **throws** the client's own error, unchanged |
 * | the response is not the shape promised | **throws**, naming the call and quoting what arrived |
 * | `issue`/`branch`/`base`/`title` missing | **throws** `TypeError` before any call is made |
 *
 * It returns a record rather than a bare number because the caller has to *say* which
 * happened — "opened #512" and "reusing #512" are different operator-facing facts — and
 * a number cannot carry that. The number is `result.number`.
 *
 * @param {string} cwd
 * @param {{ issue: number | string, branch: string, base: string, title: string, body?: string }} input
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
 * @returns {Promise<{ number: number, status: 'created' | 'existing' }>}
 */
export async function openPr(cwd, { issue, branch, base, title, body } = {}, { gh: ghFn = gh } = {}) {
  const n = Number(issue)
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`openPr: issue must be a positive issue number, got ${JSON.stringify(issue)}`)
  }
  const head = requireField(branch, 'branch')
  const baseRef = requireField(base, 'base')
  const prTitle = requireField(title, 'title')

  const already = await findOpenPr(cwd, head, baseRef, ghFn)
  if (already !== null) return { number: already, status: 'existing' }

  let created
  try {
    created = await ghFn(cwd, [
      'api',
      '--method',
      'POST',
      'repos/{owner}/{repo}/pulls',
      '-f',
      `head=${head}`,
      '-f',
      `base=${baseRef}`,
      '-f',
      `title=${prTitle}`,
      '-f',
      `body=${bodyFor(body, n)}`,
    ])
  } catch (error) {
    // GitHub answers a duplicate head with 422 "A pull request already exists for …".
    // Between the lookup above and this call another opener may have won; re-read rather
    // than fail — but only when *GitHub* said so. `isDuplicateHeadFailure` reads the exit
    // payload, never the argv, which carries this caller's own title and body.
    if (isDuplicateHeadFailure(error)) {
      const raced = await findOpenPr(cwd, head, baseRef, ghFn)
      if (raced !== null) return { number: raced, status: 'existing' }
    }
    throw error
  }

  let data
  try {
    data = JSON.parse(created)
  } catch {
    throw new Error(`openPr: \`gh api … pulls\` returned no JSON — ${preview(created)}`)
  }
  const number = data?.number
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`openPr: \`gh api … pulls\` carried no PR number — ${preview(created)}`)
  }
  return { number, status: 'created' }
}

/** @param {string} apiJson */
export function parseRequiredContexts(apiJson) {
  const out = new Set()
  try {
    const data = JSON.parse(apiJson)
    if (!data || typeof data !== 'object') return out

    if (Array.isArray(data)) {
      for (const rule of data) {
        if (rule?.type === 'required_status_checks' && Array.isArray(rule?.parameters?.required_status_checks)) {
          for (const rsc of rule.parameters.required_status_checks) {
            if (rsc && typeof rsc.context === 'string') out.add(rsc.context)
          }
        }
      }
      return out
    }

    const rsc = data.required_status_checks ?? data
    if (Array.isArray(rsc.contexts)) {
      for (const ctx of rsc.contexts) {
        if (typeof ctx === 'string') out.add(ctx)
      }
    }
    if (Array.isArray(rsc.checks)) {
      for (const ch of rsc.checks) {
        if (ch && typeof ch.context === 'string') out.add(ch.context)
      }
    }
  } catch {
    /* parse failure → ∅ */
  }
  return out
}

/** @param {string} cwd @param {string | number} pr @param {(cwd: string, args: string[]) => Promise<string>} ghFn */
async function resolveRequiredContexts(cwd, pr, ghFn) {
  const out = new Set()
  try {
    const { nameWithOwner } = JSON.parse(await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    const [owner, repo] = (nameWithOwner || '').split('/')
    if (!owner || !repo) return []

    let base
    try {
      const prJson = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'baseRefName']))
      base = prJson.baseRefName
    } catch {
      base = null
    }
    if (!base) base = await detectPrincipal(cwd)
    if (!base) return []

    try {
      const classic = await ghFn(cwd, [
        'api',
        `repos/${owner}/${repo}/branches/${base}/protection/required_status_checks`,
      ])
      for (const ctx of parseRequiredContexts(classic)) out.add(ctx)
    } catch {
      /* fail-open */
    }
    try {
      const rules = await ghFn(cwd, ['api', `repos/${owner}/${repo}/rules/branches/${base}`])
      for (const ctx of parseRequiredContexts(rules)) out.add(ctx)
    } catch {
      /* fail-open */
    }
  } catch {
    /* fail-open */
  }
  return [...out]
}

/**
 * `landing` from stack text, parsed with `Bun.YAML`. Absent `landing.mode`: a
 * merge-on-green workflow means that mode, otherwise native. Anything that is not
 * a valid landing throws: invalid YAML, a non-map document or `landing`, a mode
 * other than native/merge-on-green, `required_checks` not a list of names.
 *
 * @param {string} stackText
 * @param {{ mergeOnGreenWorkflow?: boolean }} [opts]
 * @returns {{ mode: 'native' | 'merge-on-green', required_checks: string[] }}
 */
function parseLanding(stackText, { mergeOnGreenWorkflow = false } = {}) {
  const fallback = mergeOnGreenWorkflow ? 'merge-on-green' : 'native'
  if (!stackText.trim()) return { mode: fallback, required_checks: [] }
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('.dev/stack.yml: reading it needs bun >= 1.2.21 (Bun.YAML)')
  }
  let doc
  try {
    doc = Bun.YAML.parse(stackText)
  } catch (e) {
    throw new Error(`.dev/stack.yml is not valid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (doc == null) return { mode: fallback, required_checks: [] }
  if (!isMap(doc)) throw new Error('.dev/stack.yml: the document is not a map')
  const landing = doc.landing
  if (landing == null) return { mode: fallback, required_checks: [] }
  if (!isMap(landing)) throw new Error('.dev/stack.yml: landing is not a map')
  const mode = landing.mode ?? fallback
  if (mode !== 'native' && mode !== 'merge-on-green') {
    throw new Error(`.dev/stack.yml: landing.mode must be native or merge-on-green, got ${JSON.stringify(mode)}`)
  }
  const checks = landing.required_checks ?? []
  if (!Array.isArray(checks) || !checks.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new Error('.dev/stack.yml: landing.required_checks must be a list of check names')
  }
  return { mode, required_checks: checks }
}

/**
 * The one landing resolver: `<cwd>/.dev/stack.yml` (absent → no landing block)
 * and `<cwd>/.github/workflows/merge-on-green.yml` as the mode fallback. `landPr`
 * and `ci-watch.sh` both resolve through it. Throws on an invalid landing.
 *
 * @param {string} cwd
 */
export function readLanding(cwd) {
  const stackPath = join(cwd, '.dev', 'stack.yml')
  const stackText = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : ''
  const mergeOnGreenWorkflow = existsSync(join(cwd, '.github', 'workflows', 'merge-on-green.yml'))
  return parseLanding(stackText, { mergeOnGreenWorkflow })
}

/** Attempts to read a labeled-reviewed time newer than the pre-add snapshot. */
const SINCE_ATTEMPTS = 5
/** Delay between post-add events reads (tests inject a no-op `sleep`). */
const SINCE_RETRY_MS = 200

/**
 * Arm `reviewed` and hand the wait to `/ci-watch`. No in-process poll.
 * Without an explicit `landing`, the mode comes from `readLanding(cwd)`; an
 * invalid landing returns `bad-landing` before any gh call.
 * Native also enables merge-commit auto-merge. merge-on-green never returns
 * `no-required-checks` — the workflow, not the rules API, is the gate. Under
 * merge-on-green a `reviewed` already on the PR is removed and re-added, so a
 * fresh labeled run exists. `--since` is always GitHub's `created_at` of that
 * new labeled event (no local clock): read the pre-add time, re-label, then
 * retry until a strictly newer time appears. If the event stays unreadable,
 * return `watch-failed` — never watch without `--since` under merge-on-green.
 * `watch` is `bash '<real path of ci-watch.sh>' …` — the OMP shell does not
 * resolve `skill://` for a bare `bash` argv.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {{
 *   gh?: (cwd: string, args: string[]) => Promise<string>,
 *   requiredContexts?: string[],
 *   landing?: { mode: string, required_checks: string[] },
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export async function landPr(
  cwd,
  pr,
  { gh: ghFn = gh, requiredContexts, landing, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  let resolved = landing
  if (!resolved) {
    try {
      resolved = readLanding(cwd)
    } catch (e) {
      return { status: 'bad-landing', error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (resolved.mode === 'native') {
    const required =
      requiredContexts !== undefined
        ? [...requiredContexts]
        : resolved.required_checks.length
          ? resolved.required_checks
          : await resolveRequiredContexts(cwd, pr, ghFn)
    if (required.length === 0) return { status: 'no-required-checks' }
  }

  /** @type {string} */
  let since = ''
  if (resolved.mode === 'merge-on-green') {
    const before = await labeledReviewedAt(cwd, pr, ghFn)
    const { labels = [] } = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'labels']))
    if (labels.some((label) => label?.name === 'reviewed')) {
      await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
    }
    await ghFn(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
    since = await waitLabeledSince(cwd, pr, ghFn, before, sleep)
    if (!since) {
      return {
        status: 'watch-failed',
        error: 'could not read the labeled reviewed event after re-label — merge-on-green needs --since from GitHub',
      }
    }
  } else {
    await ghFn(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
  }
  if (resolved.mode === 'native') {
    try {
      await ghFn(cwd, ['pr', 'merge', String(pr), '--auto', '--merge'])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/already enabled/i.test(msg)) return { status: 'auto-merge-failed', armed: true }
    }
  }
  const sinceArg = since ? ` --since ${since}` : ''
  return {
    status: 'watching',
    mode: resolved.mode,
    watch: `bash ${shellQuote(ciWatchSh())} ${shellQuote(String(pr))} --merge-mode ${resolved.mode}${sinceArg}`,
  }
}

/**
 * GitHub's time of the newest `reviewed` label on the PR. Empty when the read
 * fails or finds nothing.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function labeledReviewedAt(cwd, pr, ghFn) {
  try {
    const { nameWithOwner } = JSON.parse(await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    const [owner, repo] = (nameWithOwner || '').split('/')
    if (!owner || !repo) return ''
    const out = await ghFn(cwd, [
      'api',
      `repos/${owner}/${repo}/issues/${pr}/events`,
      '--paginate',
      '--jq',
      '.[] | select(.event == "labeled" and .label.name == "reviewed") | .created_at',
    ])
    const last = String(out).trim().split('\n').filter(Boolean).at(-1)
    if (!last) return ''
    const since = last.replace(/\.\d+Z$/, 'Z')
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since) ? since : ''
  } catch {
    return ''
  }
}

/**
 * After re-label, wait for a labeled-reviewed time that is strictly newer than
 * `before` (or any non-empty time when `before` was empty). Empty when retries
 * exhaust.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {string} before
 * @param {(ms: number) => Promise<void>} sleep
 */
async function waitLabeledSince(cwd, pr, ghFn, before, sleep) {
  for (let attempt = 0; attempt < SINCE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SINCE_RETRY_MS)
    const since = await labeledReviewedAt(cwd, pr, ghFn)
    if (since && (before === '' || since > before)) return since
  }
  return ''
}

async function watchPrState(cwd, pr, ghFn) {
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'state,autoMergeRequest'])
  return JSON.parse(raw)
}

/**
 * Map a `/ci-watch` exit. 4 stops. 5 is re-attachable. 6 is evaluate-only: the
 * kit-ci App is not configured, so the gate stays armed and the operator merges
 * by hand. 0–3 re-read state: MERGED is merged, CLOSED or an unmerged 0 is
 * stopped, otherwise 1–3 disarm. 70 and any other code leave the gate armed.
 */
export async function applyCiWatchExit(cwd, pr, code, { mode = 'native', gh: ghFn = gh } = {}) {
  if (code === 4) return { status: 'stopped' }
  if (code === 5) return { status: 'timeout' }
  if (code === 6) return { status: 'evaluate-only' }
  if (code === 0 || code === 1 || code === 2 || code === 3) {
    const view = await watchPrState(cwd, pr, ghFn)
    if (view?.state === 'MERGED') return { status: 'merged' }
    if (view?.state === 'CLOSED' || code === 0) return { status: 'stopped' }
    await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
    if (mode === 'native') {
      try {
        await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
      } catch (error) {
        const again = await watchPrState(cwd, pr, ghFn)
        if (again?.state === 'MERGED') return { status: 'merged' }
        if (again?.autoMergeRequest == null) {
          return { status: code === 1 ? 'ci-failed' : code === 2 ? 'ci-cancelled' : 'ci-blocked', disarmed: true }
        }
        throw error
      }
    }
    if (code === 1) return { status: 'ci-failed', disarmed: true }
    if (code === 2) return { status: 'ci-cancelled', disarmed: true }
    return { status: 'ci-blocked', disarmed: true }
  }
  return { status: 'watch-failed', code }
}

/**
 * A push after `reviewed` must drop the label first. metalyde does not revoke
 * it on synchronize, so the push would merge without a re-review.
 */
export async function disarmReviewedBeforePush(cwd, pr, { gh: ghFn = gh, push } = {}) {
  await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
  await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
  if (push) await push()
  return { disarmed: true }
}

/** ADR-020 §3 / #488 / #633: at most two review→fix rounds. Residual blockers after those rounds stop. */
export const MAX_FIX_ROUNDS = 2

/**
 * The durable half of the bound.
 *
 * `createReviewLoop` on its own is a counter in one agent's process: it binds an agent
 * that keeps the handle and nothing else, and ADR-020 names that agent untrustworthy.
 * So the count is also written on the PR, in a line a machine can read back — a PR
 * comment carrying `<!-- omp-build:review-rounds reviews=N fixes=M -->`, and when the
 * loop has stopped, a sticky `<!-- omp-build:review-stop reason=… -->` beside it.
 * A fresh loop built with `resumeReviewLoop` starts from what the PR says, not from zero.
 */
const ROUNDS_MARKER = /<!--\s*omp-build:review-rounds\s+reviews=(\d+)\s+fixes=(\d+)\s*-->/g
const STOP_MARKER = /<!--\s*omp-build:review-stop\s+reason=([a-z0-9-]+)\s*-->/g
const ROUNDS_FIRST_LINE = /^<!--\s*omp-build:review-rounds\s+reviews=\d+\s+fixes=\d+\s*-->\s*$/
const CODE_REVIEW_FIRST_LINE = /^<!--\s*omp-build:code-review\s*-->\s*$/
const FIX_RECEIPT_FIRST_LINE = /^## Review Fixes Applied\s*$/
const VERDICT_LINE = /^\*\*Verdict:\s*(Request changes|Approve with comments|Approve \(clean\)|Approve)\*\*/m

/**
 * @param {string} body
 * @returns {string}
 */
function commentFirstLine(body) {
  const line = String(body ?? '').split('\n')[0] ?? ''
  return line.trimEnd()
}

/**
 * Highest round counts and any sticky stop reason in `text`, or `null` when there is no
 * rounds marker and no stop marker.
 *
 * Highest counts, not latest: re-posting an older count must not hand a round back.
 * Any observed stop is sticky: a later count-only comment cannot erase it.
 *
 * @param {string} text
 * @returns {{ reviews: number, fixes: number, stopReason?: string } | null}
 */
export function parseReviewRounds(text) {
  const source = String(text ?? '')
  let found = null
  for (const [, reviews, fixes] of source.matchAll(ROUNDS_MARKER)) {
    const seen = { reviews: Number(reviews), fixes: Number(fixes) }
    found = found ? { reviews: Math.max(found.reviews, seen.reviews), fixes: Math.max(found.fixes, seen.fixes) } : seen
  }
  /** @type {string | undefined} */
  let stopReason
  for (const [, reason] of source.matchAll(STOP_MARKER)) {
    stopReason = stopReason ?? reason
  }
  if (!found && stopReason === undefined) return null
  const result = found ?? { reviews: 0, fixes: 0 }
  return stopReason === undefined ? result : { ...result, stopReason }
}

/**
 * Reconstruct spent rounds from PR comment records by the automation account.
 *
 * Only comments whose `author.login === me` count (same binding `fix` uses for its
 * review record). Missing/empty `me` throws. Others are ignored entirely — forged
 * count/stop markers and foreign review/receipt lookalikes never move the bound.
 *
 * Comments are read in array order (`gh pr view --json comments` returns creation
 * order). Non-object entries throw. Top-level records are recognised by **first
 * line** only:
 * - accounting = first line matches the rounds marker `persist` writes; its stop
 *   marker is honoured only inside an accounting record (parsed via `parseReviewRounds`)
 * - code-review = first line `<!-- omp-build:code-review -->`
 * - receipt = first line `## Review Fixes Applied`
 *
 * Markers already account for spent allocations, so receipts must not be added on
 * top of marker fixes. Ambiguous histories (receipts ahead of markers/code-reviews,
 * or an unrecognised terminal verdict) return `stopReason: 'history-ambiguous'` with
 * conservative counts so callers reach enforceStop — they do not throw. Transport
 * and shape errors still throw from `readReviewRounds`.
 *
 * Legacy code-review-only history (no marker, no receipt) is `{ reviews: codeReviews,
 * fixes: 0 }` — zero receipts means zero completed remote fix rounds.
 *
 * Marker-only and marker-ahead-of-receipts histories are still valid **count** reads —
 * they never construct an in-memory `pendingFix` / replay token. Two *completed*
 * rounds still allow a later blocker-free green to land when no stop applies.
 *
 * Terminal-red derivation (no durable stop marker): when `fixes >= maxFixRounds` and
 * the latest code-review record is posted **after** the latest receipt, read its
 * `**Verdict:**` line. `Request changes` → `stopReason: 'review-bound'` with
 * `reviews: max(counts.reviews, codeReviews)`; any `Approve*` → leave open;
 * missing/unrecognised → `history-ambiguous`. A review before the last receipt never
 * stops (the pending third review stays reachable). Any exit between allocating and
 * receipting fix #2 at `fixes === maxFixRounds` therefore derives stop when that
 * latest review is still Request changes — fail closed, no replay.
 *
 * @param {Array<{ body?: unknown, author?: { login?: unknown }, createdAt?: unknown }>} comments
 * @param {{ me: string, maxFixRounds?: number }} options
 * @returns {{ reviews: number, fixes: number, stopReason?: string }}
 */
export function interpretReviewHistory(comments, { me, maxFixRounds = MAX_FIX_ROUNDS } = {}) {
  if (!Array.isArray(comments)) {
    throw new TypeError(`interpretReviewHistory: comments must be an array, got ${JSON.stringify(comments)}`)
  }
  const who = typeof me === 'string' ? me.trim() : ''
  if (!who) {
    throw new TypeError(`interpretReviewHistory: me (automation login) is required, got ${JSON.stringify(me)}`)
  }
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0) {
    throw new TypeError(
      `interpretReviewHistory: maxFixRounds must be a non-negative integer, got ${JSON.stringify(maxFixRounds)}`,
    )
  }

  let markerReviews = 0
  let markerFixes = 0
  let hasMarker = false
  /** @type {string | undefined} */
  let stopReason
  let receipts = 0
  let codeReviews = 0
  /** @type {{ body: string, order: number }[]} */
  const codeReviewRecords = []
  /** @type {number[]} */
  const receiptOrders = []
  let order = 0

  for (const entry of comments) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`interpretReviewHistory: each comment must be an object, got ${JSON.stringify(entry)}`)
    }
    const login = typeof entry.author?.login === 'string' ? entry.author.login : ''
    if (login !== who) continue

    const body = typeof entry.body === 'string' ? entry.body : ''
    const first = commentFirstLine(body)
    const thisOrder = order++

    if (ROUNDS_FIRST_LINE.test(first)) {
      const parsed = parseReviewRounds(body)
      if (parsed) {
        hasMarker = true
        markerReviews = Math.max(markerReviews, parsed.reviews)
        markerFixes = Math.max(markerFixes, parsed.fixes)
        if (parsed.stopReason !== undefined) stopReason = stopReason ?? parsed.stopReason
      }
      continue
    }

    if (CODE_REVIEW_FIRST_LINE.test(first)) {
      codeReviews += 1
      codeReviewRecords.push({ body, order: thisOrder })
      continue
    }

    if (FIX_RECEIPT_FIRST_LINE.test(first)) {
      receipts += 1
      receiptOrders.push(thisOrder)
    }
  }

  /** @param {{ reviews: number, fixes: number }} counts */
  const withStop = (counts, reason = stopReason) => (reason === undefined ? counts : { ...counts, stopReason: reason })

  /** @type {{ reviews: number, fixes: number }} */
  let counts
  /** @type {boolean} */
  let ambiguous = false
  if (hasMarker) {
    if (receipts > markerFixes) {
      ambiguous = true
      counts = {
        reviews: Math.max(markerReviews, codeReviews),
        fixes: Math.max(markerFixes, receipts),
      }
    } else {
      counts = { reviews: markerReviews, fixes: markerFixes }
    }
  } else if (receipts === 0 && codeReviews === 0) {
    counts = { reviews: 0, fixes: 0 }
  } else if (receipts === 0 && codeReviews > 0) {
    // Legacy: code-review records with no marker and no receipt → zero completed remote fixes.
    counts = { reviews: codeReviews, fixes: 0 }
  } else if (codeReviews > 0 && codeReviews < receipts) {
    ambiguous = true
    counts = { reviews: Math.max(codeReviews, receipts), fixes: receipts }
  } else {
    // Legacy receipts document completed fix invocations, not an unspent allocation.
    counts = { reviews: Math.max(codeReviews, receipts), fixes: receipts }
  }

  if (ambiguous) return withStop(counts, 'history-ambiguous')
  if (stopReason !== undefined) return withStop(counts)

  if (counts.fixes >= maxFixRounds && codeReviewRecords.length > 0) {
    const latestReview = codeReviewRecords[codeReviewRecords.length - 1]
    const latestReceiptOrder = receiptOrders.length > 0 ? receiptOrders[receiptOrders.length - 1] : -1
    // A review before the last receipt never stops — the pending third review stays reachable.
    // Any exit between allocating and receipting fix #2 leaves the allocating review after the
    // last receipt, so Request changes derives stop (fail closed, no replay).
    if (latestReview.order > latestReceiptOrder) {
      const match = latestReview.body.match(VERDICT_LINE)
      if (!match) {
        return withStop({ reviews: Math.max(counts.reviews, codeReviews), fixes: counts.fixes }, 'history-ambiguous')
      }
      if (match[1] === 'Request changes') {
        return withStop({ reviews: Math.max(counts.reviews, codeReviews), fixes: counts.fixes }, 'review-bound')
      }
      // Approve / Approve (clean) / Approve with comments → leave open for gated landing.
    }
  }

  return withStop(counts)
}

/**
 * Read the rounds already spent on `pr`. `{ reviews: 0, fixes: 0 }` when the PR carries
 * no recognisable history — that is a PR whose first review has not happened yet.
 *
 * Fails closed, like `findOpenPr`: a response that is not the promised shape throws
 * rather than reading as "no rounds spent", because "no rounds spent" is the answer
 * that refunds the bound. Ambiguous comment history returns
 * `stopReason: 'history-ambiguous'` from `interpretReviewHistory` (not a throw).
 *
 * Resolves the automation login via `gh api user --jq .login` and passes it to
 * `interpretReviewHistory` so only that account's comments move the bound.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string>, maxFixRounds?: number }} [deps]
 * @returns {Promise<{ reviews: number, fixes: number, stopReason?: string }>}
 */
export async function readReviewRounds(cwd, pr, { gh: ghFn = gh, maxFixRounds = MAX_FIX_ROUNDS } = {}) {
  const meRaw = await ghFn(cwd, ['api', 'user', '--jq', '.login'])
  const me = String(meRaw ?? '').trim()
  if (!me) {
    throw new Error(`createReviewLoop: \`gh api user --jq .login\` returned empty login — ${preview(meRaw)}`)
  }
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'comments'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`createReviewLoop: \`gh pr view ${pr} --json comments\` returned no JSON — ${preview(raw)}`)
  }
  if (!Array.isArray(data?.comments)) {
    throw new Error(`createReviewLoop: \`gh pr view ${pr} --json comments\` carried no comments — ${preview(raw)}`)
  }
  return interpretReviewHistory(data.comments, { me, maxFixRounds })
}

/**
 * The loop for a PR that may already have spent rounds — the constructor to use in
 * `/feature` §6.4, so that re-entering mode 2 (or re-creating the loop mid-session)
 * **resumes** the bound instead of restarting it. A sticky stopReason reopens closed.
 * A resumed loop never carries a live fix grant — only a fresh `record`/`reopen` in this
 * process allocates one.
 *
 * @param {string} cwd
 * @param {{ pr: number | string, maxFixRounds?: number, gh?: (cwd: string, args: string[]) => Promise<string> }} options
 */
export async function resumeReviewLoop(cwd, { pr, maxFixRounds = MAX_FIX_ROUNDS, gh: ghFn = gh } = {}) {
  if (pr === null || pr === undefined || pr === '') {
    throw new TypeError(`resumeReviewLoop: pr is required — there is nothing to resume from, got ${JSON.stringify(pr)}`)
  }
  const spent = await readReviewRounds(cwd, pr, { gh: ghFn, maxFixRounds })
  return createReviewLoop({ pr, maxFixRounds, ...spent, gh: ghFn })
}

/**
 * The review→fix bound, as a counter rather than a sentence.
 *
 * The bound is the one rule of mode 2 a driver made of prose cannot be trusted with:
 * "at most two rounds" read from a skill body is a number an agent carries in its head
 * across three reviews, several fix passes and a compaction. So the count lives here.
 * The loop object is created once, before the first review, and it — not the agent —
 * decides what happens after each verdict. `land` is reachable only through it, and
 * only from a green verdict that did not follow a sticky stop.
 *
 * Rounds, on the ticket's wording: review → red → fix → review → red → fix → review.
 * Two fix rounds; residual blockers after those rounds return `stop`, and `stop` means
 * the PR keeps no `reviewed` label and no auto-merge — `landPr` is never called.
 * `enforceStop` makes that true of the PR rather than of this object. A terminal
 * `stopReason` is persisted beside the counts so a fresh session stays stopped even
 * when a later review is green. After a stop, automation on that PR is finished —
 * resumption is a NEW superseding PR or the operator finishing by hand.
 * `fixes === maxFixRounds` with no stop still permits a final blocker-free green to land.
 *
 * ```js
 * const loop = await resumeReviewLoop(cwd, { pr })   // resumes rounds + sticky/derived stop
 * if (loop.closed === 'stop') { print((await loop.enforceStop(cwd)).message); return }
 * let step = loop.record(verdict)
 * if (step.action === 'stop') print((await loop.enforceStop(cwd)).message)
 * else await loop.persist(cwd)
 * while (step.action === 'fix') {
 *   loop.assertFixAllowed(step)
 *   …run fix --no-label, re-review…
 *   step = loop.record(verdict)
 *   if (step.action === 'stop') { print((await loop.enforceStop(cwd)).message); break }
 *   else await loop.persist(cwd)
 * }
 * if (step.action === 'land') {
 *   const land = await landPr(cwd, pr)
 *   if (land.status === 'ci-failed') {
 *     step = loop.reopen('ci-failed')
 *     if (step.action === 'stop') print((await loop.enforceStop(cwd)).message)
 *     else await loop.persist(cwd)
 *   }
 * }
 * ```
 *
 * @param {{
 *   pr?: number | string | null,
 *   maxFixRounds?: number,
 *   reviews?: number,
 *   fixes?: number,
 *   stopReason?: string,
 *   gh?: (cwd: string, args: string[]) => Promise<string>,
 * }} [options]
 */
export function createReviewLoop({
  pr = null,
  maxFixRounds = MAX_FIX_ROUNDS,
  reviews: seedReviews = 0,
  fixes: seedFixes = 0,
  stopReason: seedStopReason,
  gh: ghDefault = gh,
} = {}) {
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0) {
    throw new TypeError(
      `createReviewLoop: maxFixRounds must be a non-negative integer, got ${JSON.stringify(maxFixRounds)}`,
    )
  }
  for (const [label, seed] of [
    ['reviews', seedReviews],
    ['fixes', seedFixes],
  ]) {
    if (!Number.isInteger(seed) || seed < 0) {
      throw new TypeError(`createReviewLoop: ${label} must be a non-negative integer, got ${JSON.stringify(seed)}`)
    }
  }
  if (seedStopReason !== undefined && seedStopReason !== null) {
    if (typeof seedStopReason !== 'string' || !/^[a-z0-9-]+$/.test(seedStopReason)) {
      throw new TypeError(
        `createReviewLoop: stopReason must be a kebab-case reason string, got ${JSON.stringify(seedStopReason)}`,
      )
    }
  }
  const subject = pr === null || pr === undefined || pr === '' ? 'The PR' : `PR #${pr}`
  let reviews = seedReviews
  let fixes = seedFixes
  /** @type {'land' | 'stop' | null} */
  let closed = seedStopReason ? 'stop' : null
  /** @type {string} */
  let closedReason = seedStopReason || 'review-bound'
  /**
   * Live in-process allocation from the latest `record('red')` / `reopen('ci-failed')`.
   * `assertFixAllowed` requires this true and consumes it once. Never seeded from
   * durable history — a resumed loop has no live execution grant.
   */
  let pendingFix = false

  const STOP_GUIDANCE =
    'Publish the escalation dossier (dev-review Phase 8), then wait for recorded human guidance selecting a revised diagnostic or design plan. Automation on this PR is finished: resumption is either a NEW superseding PR from a revised ticket, or the operator finishing this PR by hand. Generic retry, counter reset, or a new session does not resume the automatic loop. The bound is per automation account; records by other accounts, and edited/deleted comments of that account, are not detected.'

  /** @param {string} reason */
  function stopWhy(reason) {
    return reason === 'ci-failed'
      ? `A required check failed after the panel approved, and no fix round is left: ${reviews} reviews, ${fixes} fix rounds spent/allocated.`
      : `Review bound reached: ${reviews} reviews, ${fixes} fix rounds spent/allocated, still red.`
  }

  /** @param {string} reason */
  function stopStep(reason) {
    closed = 'stop'
    closedReason = reason
    pendingFix = false
    return {
      action: /** @type {'stop'} */ ('stop'),
      reason,
      reviews,
      fixes,
      // Gate disarm claim belongs only on enforceStop's fully successful path.
      message: `${stopWhy(reason)} ${STOP_GUIDANCE}`,
    }
  }

  /** @param {string} method */
  function requirePr(method) {
    if (pr === null || pr === undefined || pr === '') {
      throw new TypeError(
        `createReviewLoop: ${method} needs the PR number the loop was created with, got ${JSON.stringify(pr)}`,
      )
    }
    return String(pr)
  }

  function persistBody() {
    const lines = [`<!-- omp-build:review-rounds reviews=${reviews} fixes=${fixes} -->`]
    if (closed === 'stop') {
      lines.push(`<!-- omp-build:review-stop reason=${closedReason} -->`)
    }
    lines.push(
      `Review bound: ${reviews} review(s), ${fixes} of ${maxFixRounds} fix round(s) spent (\`/feature\` §6.6).`,
    )
    return lines.join('\n')
  }

  return {
    get reviews() {
      return reviews
    },
    get fixes() {
      return fixes
    },
    get closed() {
      return closed
    },
    get stopReason() {
      return closed === 'stop' ? closedReason : undefined
    },
    get remaining() {
      return Math.max(0, maxFixRounds - fixes)
    },
    /**
     * True only while this live process holds an unconsumed allocation from
     * `record('red')` / `reopen('ci-failed')`. Always false on a resumed loop.
     */
    get pendingFix() {
      return pendingFix
    },
    /**
     * Record one `dev-review` verdict and get the next move.
     *
     * `verdict` is the panel's word — `green` or `red`, nothing else. A sentence, a
     * missing value or a third word throws: reading a verdict out of prose is the
     * failure this slice exists to remove, and a defaulted verdict would either burn
     * a round for free or land an unreviewed PR.
     *
     * A red verdict allocates/spends a fix round before the operator's Fix choice.
     * Choosing Stop does not refund that allocation. The returned fix step is the only
     * live permission for `assertFixAllowed` in this process — single-use via `pendingFix`.
     *
     * @param {string} verdict
     * @returns {{ action: 'land' | 'fix' | 'stop', reviews: number, fixes: number, remaining?: number, reason?: string, message?: string }}
     */
    record(verdict) {
      if (closed) {
        throw new Error(
          `createReviewLoop: the loop already closed with "${closed}" after ${reviews} reviews — a further verdict has nowhere to go`,
        )
      }
      const v = typeof verdict === 'string' ? verdict.trim().toLowerCase() : ''
      if (v !== 'green' && v !== 'red') {
        throw new TypeError(`createReviewLoop: verdict must be "green" or "red", got ${JSON.stringify(verdict)}`)
      }
      reviews += 1
      if (v === 'green') {
        closed = 'land'
        pendingFix = false
        return { action: 'land', reviews, fixes }
      }
      if (fixes >= maxFixRounds) {
        return stopStep('review-bound')
      }
      fixes += 1
      pendingFix = true
      return { action: 'fix', reviews, fixes, remaining: maxFixRounds - fixes }
    },
    /**
     * Guard execution of a fix round already allocated by this live loop.
     *
     * Requires live unconsumed `pendingFix` (set by `record`/`reopen` in this process
     * only), `step.action === 'fix'`, matching live `reviews`/`fixes`, and an open
     * (non-stopped) loop. Consumes the grant exactly once — repeating the same step
     * refuses. A sticky stop always refuses. Round two has already raised `fixes` to 2
     * and must still run — this is not `fixes >= 2`.
     *
     * @param {{ action?: string, reviews?: number, fixes?: number, reason?: string }} step
     * @returns {{ action: 'fix', reviews: number, fixes: number, remaining?: number, reason?: string }}
     */
    assertFixAllowed(step) {
      if (closed === 'stop') {
        throw new Error(
          `createReviewLoop: assertFixAllowed refused — the loop is stopped (${closedReason}); automation on this PR is finished`,
        )
      }
      if (!pendingFix) {
        throw new Error(
          `createReviewLoop: assertFixAllowed refused — no live unconsumed fix allocation (pendingFix=false); a resumed loop never replays a prior grant`,
        )
      }
      if (!step || step.action !== 'fix') {
        throw new Error(
          `createReviewLoop: assertFixAllowed needs a step with action "fix", got ${JSON.stringify(step?.action)}`,
        )
      }
      if (step.reviews !== reviews || step.fixes !== fixes) {
        throw new Error(
          `createReviewLoop: assertFixAllowed refused — step reviews=${step.reviews} fixes=${step.fixes} does not match the live loop reviews=${reviews} fixes=${fixes}`,
        )
      }
      pendingFix = false
      return {
        action: /** @type {'fix'} */ ('fix'),
        reviews,
        fixes,
        remaining: maxFixRounds - fixes,
        ...(step.reason !== undefined ? { reason: step.reason } : {}),
      }
    },
    /**
     * The one way back out of `land`: the panel approved, `landPr` came back
     * `ci-failed`, and the branch has to be fixed and re-reviewed.
     *
     * It clears `closed` **without refunding a fix round** — it spends one, exactly as a
     * red verdict would. A CI failure after a green review therefore costs a round and
     * cannot push the PR past the bound; when none is left it returns `stop`. Without
     * this, §6.7's `ci-failed` row is unreachable prose: `record` on a closed loop
     * throws, and the only way forward an agent can find is a brand-new loop, which
     * hands the same PR two fresh rounds.
     *
     * @param {string} reason — `'ci-failed'`, the only failure that re-opens a landing
     * @returns {{ action: 'fix' | 'stop', reviews: number, fixes: number, remaining?: number, reason?: string, message?: string }}
     */
    reopen(reason) {
      if (reason !== 'ci-failed') {
        throw new TypeError(`createReviewLoop: reopen takes "ci-failed", got ${JSON.stringify(reason)}`)
      }
      if (closed !== 'land') {
        throw new Error(
          closed === 'stop'
            ? `createReviewLoop: reopen("ci-failed") cannot lift a sticky stop — automation on this PR is finished`
            : `createReviewLoop: reopen("ci-failed") only follows a green verdict that closed the loop with "land", not ${JSON.stringify(closed)}`,
        )
      }
      closed = null
      if (fixes >= maxFixRounds) {
        return stopStep('ci-failed')
      }
      fixes += 1
      pendingFix = true
      return { action: 'fix', reviews, fixes, remaining: maxFixRounds - fixes, reason: 'ci-failed' }
    },
    /**
     * Write the rounds spent onto the PR, so the bound survives this process.
     *
     * Called after every `record` / `reopen`. Persists counts and, when closed is
     * `stop`, the sticky stop reason beside them. A re-entry resumes through
     * `resumeReviewLoop` at that state. Helpers here do **not** unlock a sticky stop —
     * automation on a stopped PR is finished; resumption is a NEW superseding PR or
     * the operator finishing by hand.
     *
     * @param {string} cwd
     * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
     */
    async persist(cwd, { gh: ghFn = ghDefault } = {}) {
      const number = requirePr('persist')
      await ghFn(cwd, ['pr', 'comment', number, '--body', persistBody()])
      return closed === 'stop' ? { reviews, fixes, stopReason: closedReason } : { reviews, fixes }
    },
    /**
     * Make `stop` true of the PR, not just of this object.
     *
     * Attempts to write the durable stop marker first, then independently disarms
     * `reviewed` and native auto-merge. A publication failure does not skip disarm;
     * a disarm failure does not erase a published marker; a label read-back failure
     * still attempts both disarms and reports `readError`. Never claim a durable stop
     * or guaranteed unlabelled/unmerged state when the matching step failed.
     * Escalation-dossier publication is caller-owned and must not skip this disarm.
     *
     * @param {string} cwd
     * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
     * @returns {Promise<{ removed: boolean, autoMergeDisabled: boolean, labels: string[], message: string, disarmErrors: string[], publishError: string | null, published: boolean, readError: string | null }>}
     */
    async enforceStop(cwd, { gh: ghFn = ghDefault } = {}) {
      if (closed !== 'stop') {
        throw new Error(`createReviewLoop: enforceStop only follows a stop, not ${JSON.stringify(closed)}`)
      }
      const number = requirePr('enforceStop')
      /** @type {string | null} */
      let publishError = null
      let published = false
      try {
        await ghFn(cwd, ['pr', 'comment', number, '--body', persistBody()])
        published = true
      } catch (e) {
        publishError = e instanceof Error ? e.message : String(e)
      }

      /** @type {string | null} */
      let readError = null
      /** @type {string[]} */
      let labels = []
      let autoMergeWasEnabled = false
      let readOk = false
      try {
        const raw = await ghFn(cwd, ['pr', 'view', number, '--json', 'labels,autoMergeRequest'])
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error(
            `createReviewLoop: \`gh pr view ${number} --json labels,autoMergeRequest\` returned no JSON — ${preview(raw)}`,
          )
        }
        if (!Array.isArray(data?.labels)) {
          throw new Error(
            `createReviewLoop: \`gh pr view ${number} --json labels,autoMergeRequest\` carried no labels — ${preview(raw)}`,
          )
        }
        labels = data.labels.map((l) => (typeof l?.name === 'string' ? l.name : '')).filter(Boolean)
        autoMergeWasEnabled = Boolean(data.autoMergeRequest)
        readOk = true
      } catch (e) {
        readError = e instanceof Error ? e.message : String(e)
      }

      /** @type {string[]} */
      const disarmErrors = []
      let removed = false
      let autoMergeDisabled = false

      const tryRemoveReviewed = async () => {
        try {
          await ghFn(cwd, ['pr', 'edit', number, '--remove-label', 'reviewed'])
          removed = true
        } catch (e) {
          disarmErrors.push(`remove-label reviewed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const tryDisableAuto = async () => {
        try {
          await ghFn(cwd, ['pr', 'merge', number, '--disable-auto'])
          autoMergeDisabled = true
        } catch (e) {
          disarmErrors.push(`disable-auto: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!readOk) {
        // Read-back failed — still attempt both disarms; never claim guaranteed.
        await tryRemoveReviewed()
        await tryDisableAuto()
      } else {
        if (labels.includes('reviewed')) await tryRemoveReviewed()
        if (autoMergeWasEnabled) await tryDisableAuto()
      }

      const guaranteed = published && readOk && disarmErrors.length === 0
      /** @type {string[]} */
      const parts = [
        guaranteed
          ? `${stopWhy(closedReason)} ${subject} stays unlabelled and unmerged — no \`reviewed\` label, no auto-merge. ${STOP_GUIDANCE}`
          : `${stopWhy(closedReason)} ${subject} is not guaranteed unlabelled and unmerged — publication and/or disarm did not fully succeed. ${STOP_GUIDANCE}`,
      ]
      if (publishError) {
        parts.push(
          `Durable stop marker was NOT published on ${subject}: ${publishError}. Durable stop across sessions is not guaranteed.`,
        )
      }
      if (readError) {
        parts.push(
          `Label/auto-merge read-back failed on ${subject}: ${readError}. Disarm was still attempted; gate state is not guaranteed.`,
        )
      }
      if (removed) {
        parts.push(
          readOk
            ? `A \`reviewed\` label was already on ${subject} — removed, so auto-merge cannot pick it up.`
            : `remove-label attempted (prior state unknown)`,
        )
      }
      if (autoMergeDisabled) {
        parts.push(
          readOk ? `Auto-merge was enabled on ${subject} — disabled.` : `disable-auto attempted (prior state unknown)`,
        )
      }
      if (disarmErrors.length > 0) {
        parts.push(
          `Disarm incomplete on ${subject}: ${disarmErrors.join('; ')}. Gate is not guaranteed unlabelled and unmerged.`,
        )
      }
      return {
        removed,
        autoMergeDisabled,
        labels,
        message: parts.join('\n'),
        disarmErrors,
        publishError,
        published,
        readError,
      }
    },
  }
}
