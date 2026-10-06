/**
 * Deterministic core `/feature` uses: open a PR, derive the review loop's next step, and land.
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
 * @param {string} cwd
 * @param {string} head
 * @param {string} base
 * @param {(cwd: string, args: string[]) => Promise<string>} [ghFn]
 * @returns {Promise<number | null>}
 */
/**
 * Same-repository entries of a `gh pr list` answer. A fork (`isCrossRepository:
 * true`) is never this branch's PR. Any other flag value is not a discovery
 * response: missing, null, or a string must not be read as same-repository.
 * Does not filter by state.
 *
 * @param {unknown[]} entries
 * @param {string} caller
 */
function sameRepositoryPrs(entries, caller) {
  for (const entry of entries) {
    if (typeof entry?.isCrossRepository !== 'boolean') {
      throw new Error(`${caller}: invalid PR discovery response`)
    }
  }
  return entries.filter((entry) => entry.isCrossRepository === false)
}

async function findOpenPr(cwd, head, base, ghFn = gh) {
  const raw = await ghFn(cwd, [
    'pr',
    'list',
    '--head',
    head,
    '--base',
    base,
    '--state',
    'open',
    '--json',
    'number,isCrossRepository',
  ])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned no JSON — ${preview(raw)}`)
  }
  if (!Array.isArray(data)) {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned no array — ${preview(raw)}`)
  }
  // `--head` matches a fork's branch of the same name; a fork PR is never this branch's PR.
  // Number shape is checked first so a malformed entry keeps its existing error.
  if (data.some((entry) => !Number.isInteger(entry?.number) || entry.number <= 0)) {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned an entry with no PR number — ${preview(raw)}`)
  }
  data = sameRepositoryPrs(data, 'openPr')
  if (data.length === 0) return null
  // Degenerate but possible (a PR reopened against the same pair): the oldest is the
  // one the branch's history belongs to, and picking it is deterministic.
  return Math.min(...data.map((entry) => entry.number))
}

/**
 * Bind a review to one PR before reading its records. Discovery failure is not
 * a local review. `git`/`gh` are injected only at the process adapter seam.
 */
export async function resolveReviewPr(cwd, explicitPr, { gh: ghFn = gh, git: gitFn = git } = {}) {
  if (explicitPr !== undefined && explicitPr !== null && explicitPr !== '') {
    const number = Number(explicitPr)
    if (!/^[1-9]\d*$/.test(String(explicitPr)) || !Number.isSafeInteger(number)) {
      throw new TypeError('resolveReviewPr: expected a positive PR number')
    }
    return number
  }
  const branch = (await gitFn(cwd, ['branch', '--show-current'])).trim()
  if (!branch) throw new Error('resolveReviewPr: cannot discover a PR from a detached HEAD')
  const raw = await ghFn(cwd, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,isCrossRepository',
  ])
  let entries
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new Error('resolveReviewPr: invalid PR discovery response')
  }
  if (!Array.isArray(entries)) throw new Error('resolveReviewPr: invalid PR discovery response')
  // Forks are dropped before open/closed logic, so a closed fork cannot reset this branch's budget.
  const sameRepo = sameRepositoryPrs(entries, 'resolveReviewPr')
  if (
    sameRepo.some(
      (entry) =>
        !Number.isSafeInteger(entry?.number) ||
        entry.number <= 0 ||
        !['OPEN', 'CLOSED', 'MERGED'].includes(entry.state),
    )
  ) {
    throw new Error('resolveReviewPr: invalid PR discovery response')
  }
  const open = sameRepo.filter((entry) => entry.state === 'OPEN')
  if (open.length > 1) throw new Error('resolveReviewPr: multiple open PRs for this branch; pass the PR number')
  if (open.length === 1) return open[0].number
  // A closed PR keeps its review budget. Reusing its head would reset that budget.
  if (sameRepo.some((entry) => entry.state === 'CLOSED')) {
    throw new Error('resolveReviewPr: this branch has a closed PR; use an explicit superseding branch')
  }
  return null
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
 * First resolve the PR, read its review records, then its gate. A spent bound,
 * or a latest record that does not approve, returns `not-approved`.
 * An approval arms only when its line-2 head is the PR's `headRefOid` (both 40 lowercase hex).
 * `no-review-head` is a record with no valid head line; `head-moved` is a different or
 * unreadable oid. Every `not-approved` disarms a gate already armed on an OPEN PR
 * (`disarmed: true`) and writes nothing else. Native auto-merge is then requested with
 * `--match-head-commit` of that reviewed sha — an enable-time pin, not a later-push lease.
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
  pr = await resolveReviewPr(cwd, pr, { gh: ghFn })
  if (pr === null) return { status: 'no-pr' }
  const records = await readReviewRecords(cwd, pr, { gh: ghFn })
  const { reviews } = records
  // Only an approving latest record arms, only for the commit it names, and never
  // past a spent fix allowance. Read the gate before any landing step; a refusal disarms it.
  const refuse = async (reason, gate) => {
    const disarmed = await disarmGate(cwd, pr, gate ?? (await readGate(cwd, pr, ghFn)), ghFn)
    return { status: 'not-approved', reviews, ...(reason && { reason }), ...(disarmed && { disarmed }) }
  }
  const gate = await readGate(cwd, pr, ghFn)
  let allowance
  try {
    allowance = await readFixAllowance(cwd, pr, records, ghFn, { landing })
  } catch (error) {
    if (isLandingError(error)) {
      return { status: 'bad-landing', error: error instanceof Error ? error.message : String(error) }
    }
    throw error
  }
  if (boundState({ reds: records.reds, ciFixes: allowance.ciFixes }).spent) return refuse('review-bound', gate)
  if (!approves(records.verdict)) return refuse(undefined, gate)
  if (!isCommitSha(records.head)) return refuse('no-review-head', gate)
  if (!isCommitSha(gate.headRefOid) || gate.headRefOid !== records.head) return refuse('head-moved', gate)
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

  const headMoved = async () => {
    const again = await readHeadRefOid(cwd, pr, ghFn)
    return !isCommitSha(again) || again !== records.head
  }
  const moved = () => refuse('head-moved')
  const pin = ['pr', 'merge', String(pr), '--auto', '--merge', '--match-head-commit', records.head]

  /** @type {string} */
  let since = ''
  if (resolved.mode === 'merge-on-green') {
    const before = await labeledReviewedAt(cwd, pr, ghFn)
    const { labels = [] } = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'labels']))
    // Re-read immediately before the write. The earlier check is not a lease.
    if (await headMoved()) return moved()
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
    // The pin is the merge authority. The label comes after it, so a failed
    // or unpinned enable never leaves `reviewed` for the fleet workflow.
    if (await headMoved()) return moved()
    try {
      await ghFn(cwd, pin)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/already enabled/i.test(msg)) return { status: 'auto-merge-failed', armed: false }
      try {
        await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
      } catch {
        return { status: 'auto-merge-failed', armed: true }
      }
      if (await headMoved()) return moved()
      try {
        await ghFn(cwd, pin)
      } catch {
        return { status: 'auto-merge-failed', armed: false }
      }
    }
    if (await headMoved()) {
      try {
        await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
      } catch {
        return { status: 'auto-merge-failed', armed: true }
      }
      return moved()
    }
    await ghFn(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
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

/** ADR-020 §3 / #488 / #716: at most two automated fixes per PR, red reviews and CI failures together. */
export const MAX_FIX_ROUNDS = 2

/**
 * The allowance is two reads (#716). A review record is a comment by the automation
 * login whose first line is `<!-- omp-build:code-review -->`. Only a `Request changes`
 * record spends a fix; an approval spends nothing and resets nothing. A CI fix is an
 * approved head whose required check's latest completed run failed. Nothing writes
 * accounting: every decision is derived again from a fresh read.
 */
const CODE_REVIEW_FIRST_LINE = /^<!--\s*omp-build:code-review\s*-->\s*$/
const VERDICT_LINE = /^\*\*Verdict:\s*(Request changes|Approve with comments|Approve \(clean\)|Approve)\*\*(?:\s.*)?$/
const VERDICTS = ['Request changes', 'Approve with comments', 'Approve (clean)', 'Approve']
/** Line 2 only. A sha anywhere else in the body is not the reviewed commit. */
const REVIEW_HEAD_LINE = /^<!-- omp-build:review-head sha=([0-9a-f]{40}) -->$/
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])
const FAILING_STATES = new Set(['failure', 'error'])
const ACTIONS_RUN = /\/actions\/runs\/(\d+)\b/

/** @param {string | null} body */
function reviewHeadOf(body) {
  if (typeof body !== 'string') return null
  const line = body.split('\n')[1] ?? ''
  const match = line.trimEnd().match(REVIEW_HEAD_LINE)
  return match ? match[1] : null
}

/** @param {unknown} value */
function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

/** @param {unknown} value */
function stringField(value) {
  return typeof value === 'string' && value ? value : ''
}

/** @param {unknown} error */
function isLandingError(error) {
  return error instanceof Error && error.message.startsWith('.dev/stack.yml')
}

/**
 * A 404 on a historical sha is an empty head, not a failed read. A current-head
 * 404 stays a failure: the caller decides that.
 *
 * @param {unknown} error
 */
export function isMissingRef(error) {
  const payload = ghFailurePayload(error)
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = `${payload?.text ?? ''}\n${message}`
  return payload?.status === 404 || /\bHTTP[\s:]*404\b/i.test(text) || /"status"\s*:\s*"?404"?/.test(text)
}

/**
 * True when an unread approved head could push `reds + CI fixes` over the allowance.
 * Already over on reds alone, or still under even if every distinct sha failed, → false.
 *
 * @param {number} reds
 * @param {string[]} approvedHeads
 */
export function unreadCouldSpend(reds, approvedHeads) {
  if (!Number.isInteger(reds) || reds < 0) return true
  if (reds > MAX_FIX_ROUNDS) return false
  const distinct = new Set((approvedHeads ?? []).filter(isCommitSha)).size
  return reds + distinct > MAX_FIX_ROUNDS
}

/**
 * @param {{ reds: number, ciFixes: number }} input
 * @returns {{ fixes: number, spent: boolean }}
 */
export function boundState({ reds, ciFixes }) {
  if (!Number.isInteger(reds) || reds < 0 || !Number.isInteger(ciFixes) || ciFixes < 0) {
    throw new TypeError('boundState: reds and ciFixes must be non-negative integers')
  }
  const fixes = reds + ciFixes
  return { fixes, spent: fixes > MAX_FIX_ROUNDS }
}

/** @param {string} owner @param {string} repo @param {string} base */
export function protectionArgs(owner, repo, base) {
  return ['api', `repos/${owner}/${repo}/branches/${base}/protection/required_status_checks`]
}

/** @param {string} owner @param {string} repo @param {string} base */
export function rulesetArgs(owner, repo, base) {
  return ['api', `repos/${owner}/${repo}/rules/branches/${base}`]
}

/**
 * Fail-closed parse of a protection or ruleset body. Unparsable throws.
 * A body that parsed and named nothing returns `[]` — every check, matching ci-watch.
 *
 * @param {string} apiJson
 * @returns {string[]}
 */
export function strictRequiredContexts(apiJson) {
  let data
  try {
    data = JSON.parse(apiJson)
  } catch {
    throw new Error(`required checks: unparsable response — ${preview(apiJson)}`)
  }
  if (data == null || typeof data !== 'object') throw new Error('required checks: response is not an object')
  return [...parseRequiredContexts(JSON.stringify(data))]
}

/**
 * Whether `<cwd>/.dev/stack.yml` declares `landing.required_checks`. Absent file,
 * empty file, or a landing block without the key → not declared. Invalid YAML throws
 * the same errors `readLanding` throws.
 *
 * @param {string} cwd
 * @returns {{ declared: boolean, checks: string[] }}
 */
export function declaredRequiredChecks(cwd) {
  const stackPath = join(cwd, '.dev', 'stack.yml')
  if (!existsSync(stackPath)) return { declared: false, checks: [] }
  const text = readFileSync(stackPath, 'utf8')
  if (!text.trim()) return { declared: false, checks: [] }
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('.dev/stack.yml: reading it needs bun >= 1.2.21 (Bun.YAML)')
  }
  let doc
  try {
    doc = Bun.YAML.parse(text)
  } catch (e) {
    throw new Error(`.dev/stack.yml is not valid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (doc == null) return { declared: false, checks: [] }
  if (!isMap(doc)) throw new Error('.dev/stack.yml: the document is not a map')
  if (doc.landing == null) return { declared: false, checks: [] }
  if (!isMap(doc.landing)) throw new Error('.dev/stack.yml: landing is not a map')
  if (!Object.hasOwn(doc.landing, 'required_checks')) return { declared: false, checks: [] }
  const checks = doc.landing.required_checks
  if (!Array.isArray(checks) || !checks.every((check) => typeof check === 'string' && check.length > 0)) {
    throw new Error('.dev/stack.yml: landing.required_checks must be a list of check names')
  }
  return { declared: true, checks }
}

/**
 * The check set the CI-fix counter prices. A declared list, including an empty one
 * (every check). Otherwise protection and rulesets, fail closed: a failed or
 * unparsable read throws. `[]` from a read that succeeded and named nothing means
 * every check.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {{ required_checks?: string[] } | undefined} landing
 */
async function resolveFixChecks(cwd, pr, ghFn, landing) {
  if (landing && Object.hasOwn(landing, 'required_checks')) {
    const checks = landing.required_checks
    if (!Array.isArray(checks) || !checks.every((check) => typeof check === 'string' && check.length > 0)) {
      throw new Error('.dev/stack.yml: landing.required_checks must be a list of check names')
    }
    return checks
  }
  const declared = declaredRequiredChecks(cwd)
  if (declared.declared) return declared.checks
  const slug = await repoSlug(cwd, ghFn)
  const rawPr = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'baseRefName'])
  let prJson
  try {
    prJson = JSON.parse(rawPr)
  } catch {
    throw new Error(`required checks: pr view returned no JSON — ${preview(rawPr)}`)
  }
  const base = prJson?.baseRefName
  if (typeof base !== 'string' || !base) throw new Error('required checks: the PR named no base')
  let classic
  let rules
  try {
    classic = await ghFn(cwd, protectionArgs(slug.owner, slug.repo, base))
  } catch (error) {
    throw new Error(`required checks: protection read failed — ${error instanceof Error ? error.message : error}`)
  }
  try {
    rules = await ghFn(cwd, rulesetArgs(slug.owner, slug.repo, base))
  } catch (error) {
    throw new Error(`required checks: ruleset read failed — ${error instanceof Error ? error.message : error}`)
  }
  return [...new Set([...strictRequiredContexts(classic), ...strictRequiredContexts(rules)])]
}

/** @param {string} cwd @param {(cwd: string, args: string[]) => Promise<string>} ghFn */
async function repoSlug(cwd, ghFn) {
  const raw = await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`required checks: repo view returned no JSON — ${preview(raw)}`)
  }
  const [owner, repo] = String(data?.nameWithOwner ?? '').split('/')
  if (!owner || !repo) throw new Error('required checks: repo view named no owner/repo')
  return { owner, repo }
}

/** @param {string} owner @param {string} repo @param {string} sha */
export function checkRunArgs(owner, repo, sha) {
  return ['api', '--paginate', '--slurp', `repos/${owner}/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`]
}

/** @param {string} owner @param {string} repo @param {string} sha */
export function statusArgs(owner, repo, sha) {
  return ['api', '--paginate', '--slurp', `repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`]
}

/** @param {string} owner @param {string} repo @param {string} runId */
export function workflowRunArgs(owner, repo, runId) {
  return ['api', `repos/${owner}/${repo}/actions/runs/${runId}`]
}

/**
 * Paginated `filter=all` check-run pages. A page that is not the last page
 * (fewer runs than `total_count`) throws: it is a failed read, not an empty head.
 *
 * @param {string} raw
 */
export function parseCheckRuns(raw) {
  let pages
  try {
    pages = JSON.parse(raw)
  } catch {
    throw new Error(`check runs: not JSON — ${preview(raw)}`)
  }
  if (
    !Array.isArray(pages) ||
    pages.some((page) => !page || typeof page !== 'object' || !Array.isArray(page.check_runs))
  ) {
    throw new Error('check runs: expected a page list')
  }
  /** @type {number | null} */
  let total = null
  /** @type {ReturnType<typeof normalizeCheckRun>[]} */
  const runs = []
  for (const page of pages) {
    if (typeof page.total_count !== 'number') throw new Error('check runs: a page has no total_count')
    if (total === null) total = page.total_count
    else if (total !== page.total_count) throw new Error('check runs: total_count changed mid-read')
    for (const run of page.check_runs) runs.push(normalizeCheckRun(run))
  }
  if (runs.length !== total) throw new Error('check runs: a page is not the last page')
  return runs
}

/** @param {unknown} run */
function normalizeCheckRun(run) {
  if (!run || typeof run !== 'object') throw new Error('check runs: a run is not an object')
  const row = /** @type {Record<string, unknown>} */ (run)
  const suite =
    row.check_suite && typeof row.check_suite === 'object'
      ? /** @type {Record<string, unknown>} */ (row.check_suite)
      : {}
  const app = row.app && typeof row.app === 'object' ? /** @type {Record<string, unknown>} */ (row.app) : {}
  const url = String(row.details_url ?? row.html_url ?? '')
  const actionRun = url.match(ACTIONS_RUN)?.[1] ?? null
  const named =
    stringField(row.workflow) ||
    stringField(row.workflow_name) ||
    stringField(row.workflowName) ||
    stringField(suite.workflow) ||
    stringField(suite.workflow_name)
  return {
    name: typeof row.name === 'string' ? row.name : '',
    workflow: named || (actionRun ? '' : stringField(app.slug)),
    actionRun,
    status: String(row.status ?? '').toLowerCase(),
    conclusion: String(row.conclusion ?? '').toLowerCase(),
    completed_at: stringField(row.completed_at) || stringField(row.completedAt),
    id: typeof row.id === 'number' ? row.id : 0,
  }
}

/** @param {string} raw */
export function workflowNameFromRun(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`check runs: workflow run is not JSON — ${preview(raw)}`)
  }
  const name = stringField(data?.path) || stringField(data?.name)
  if (!name) throw new Error('check runs: workflow run named no workflow')
  return name
}

/**
 * @param {ReturnType<typeof normalizeCheckRun>[]} runs
 * @param {Record<string, string>} names
 */
export function withWorkflowNames(runs, names) {
  return runs.map((run) => {
    if (run.workflow || !run.actionRun) return run
    const workflow = names?.[run.actionRun]
    if (!workflow) throw new Error('check runs: a workflow run was not named')
    return { ...run, workflow }
  })
}

/**
 * @param {string} raw
 * @returns {{ context: string, state: string, updated_at: string, id: number }[]}
 */
export function parseCommitStatuses(raw) {
  let pages
  try {
    pages = JSON.parse(raw)
  } catch {
    throw new Error(`commit statuses: not JSON — ${preview(raw)}`)
  }
  const lists =
    Array.isArray(pages) && pages.every(Array.isArray)
      ? pages
      : pages && typeof pages === 'object' && Array.isArray(pages.statuses)
        ? [pages.statuses]
        : null
  if (!lists) throw new Error('commit statuses: expected pages')
  /** @type {{ context: string, state: string, updated_at: string, id: number }[]} */
  const out = []
  for (const list of lists) {
    for (const status of list) {
      if (!status || typeof status !== 'object') throw new Error('commit statuses: an entry is not an object')
      out.push({
        context: typeof status.context === 'string' ? status.context : '',
        state: String(status.state ?? '').toLowerCase(),
        updated_at: stringField(status.updated_at) || stringField(status.created_at),
        id: typeof status.id === 'number' ? status.id : 0,
      })
    }
  }
  return out
}

/**
 * A required name with no check run is a commit status. An empty required set is
 * every check, so statuses are always read.
 *
 * @param {{ name: string }[]} checks
 * @param {string[]} required
 */
export function headNeedsStatuses(checks, required) {
  if (!required.length) return true
  const names = new Set(checks.map((run) => run.name))
  return required.some((name) => !names.has(name))
}

/**
 * Latest completed run per workflow and name. In-progress runs are ignored.
 * A tie on `completed_at` breaks on id.
 *
 * @param {{ name?: string, workflow?: string, status?: string, conclusion?: string, completed_at?: string, id?: number }[]} runs
 */
function latestCompleted(runs) {
  /** @type {Map<string, { name: string, workflow: string, conclusion: string, completed_at: string, id: number }>} */
  const groups = new Map()
  for (const run of runs ?? []) {
    if (String(run?.status ?? '').toLowerCase() !== 'completed') continue
    const name = run.name ?? ''
    const workflow = run.workflow ?? ''
    const key = `${workflow}\0${name}`
    const row = {
      name,
      workflow,
      conclusion: String(run.conclusion ?? '').toLowerCase(),
      completed_at: run.completed_at ?? '',
      id: run.id ?? 0,
    }
    const prev = groups.get(key)
    if (!prev || row.completed_at > prev.completed_at || (row.completed_at === prev.completed_at && row.id > prev.id)) {
      groups.set(key, row)
    }
  }
  return [...groups.values()]
}

/** @param {{ context?: string, state?: string, updated_at?: string, id?: number }[]} statuses */
function latestStatuses(statuses) {
  /** @type {Map<string, { context: string, state: string, updated_at: string, id: number }>} */
  const groups = new Map()
  for (const status of statuses ?? []) {
    const context = status?.context ?? ''
    const row = {
      context,
      state: String(status?.state ?? '').toLowerCase(),
      updated_at: status?.updated_at ?? '',
      id: status?.id ?? 0,
    }
    const prev = groups.get(context)
    if (!prev || row.updated_at > prev.updated_at || (row.updated_at === prev.updated_at && row.id > prev.id)) {
      groups.set(context, row)
    }
  }
  return [...groups.values()]
}

/**
 * One approved head is one CI fix when any required check's latest completed
 * conclusion is `failure`, `timed_out`, or `startup_failure`. An empty required
 * set means every check. A required name with no check run is its commit status
 * (`failure` or `error`). Keys are unique shas: two approvals of one sha count once.
 * A sha that is not a key counts zero.
 *
 * @param {Record<string, { checks?: object[], statuses?: object[] } | object[]> | Map<string, { checks?: object[], statuses?: object[] }>} runsByHead
 * @param {string[]} requiredChecks
 */
export function ciFixCount(runsByHead, requiredChecks) {
  const required = Array.isArray(requiredChecks) ? requiredChecks : []
  const entries = runsByHead instanceof Map ? [...runsByHead.entries()] : Object.entries(runsByHead ?? {})
  const seen = new Set()
  let count = 0
  for (const [sha, raw] of entries) {
    if (!isCommitSha(sha) || seen.has(sha)) continue
    seen.add(sha)
    if (headIsCiFix(raw, required)) count++
  }
  return count
}

/** @param {unknown} raw @param {string[]} required */
function headIsCiFix(raw, required) {
  const checks = latestCompleted(Array.isArray(raw) ? raw : /** @type {{ checks?: object[] }} */ (raw)?.checks)
  const statuses = latestStatuses(Array.isArray(raw) ? [] : /** @type {{ statuses?: object[] }} */ (raw)?.statuses)
  const checkNames = new Set(checks.map((run) => run.name))
  if (!required.length) {
    if (checks.some((run) => FAILING_CONCLUSIONS.has(run.conclusion))) return true
    return statuses.some((status) => !checkNames.has(status.context) && FAILING_STATES.has(status.state))
  }
  for (const name of required) {
    const matched = checks.filter((run) => run.name === name)
    if (matched.length) {
      if (matched.some((run) => FAILING_CONCLUSIONS.has(run.conclusion))) return true
      continue
    }
    const status = statuses.find((row) => row.context === name)
    if (status && FAILING_STATES.has(status.state)) return true
  }
  return false
}

/**
 * The PR head, or whatever the view returned. A non-JSON answer throws: an
 * unreadable head authorizes nothing and must not be folded into `head-moved`.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function readHeadRefOid(cwd, pr, ghFn) {
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'headRefOid'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  return data.headRefOid
}

/**
 * The gate: head, state, and what arms it. A non-JSON answer throws: it
 * authorizes nothing.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function readGate(cwd, pr, ghFn) {
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'headRefOid,state,labels,autoMergeRequest'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`readGate: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.labels)) {
    throw new Error(`readGate: gh pr view ${pr} carried no labels — ${preview(raw)}`)
  }
  return data
}

/**
 * Disarm an OPEN PR whose gate is armed: remove `reviewed`, then disable
 * auto-merge. Returns whether either was on. A CLOSED or MERGED PR is left alone.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{ state?: string, labels: { name?: string }[], autoMergeRequest?: unknown }} gate
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function disarmGate(cwd, pr, gate, ghFn) {
  if (gate.state !== 'OPEN') return false
  const labelled = gate.labels.some((label) => label?.name === 'reviewed')
  if (labelled) await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
  if (gate.autoMergeRequest) await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
  return labelled || Boolean(gate.autoMergeRequest)
}

/**
 * @param {string} body
 * @returns {string}
 */
function commentFirstLine(body) {
  const line = String(body ?? '').split('\n')[0] ?? ''
  return line.trimEnd()
}

/** A review can quote another verdict; conflicting or malformed declarations are unknown. */
function reviewVerdict(body) {
  let verdict = null
  for (const [line] of body.matchAll(/^\*\*Verdict:[^\n]*/gm)) {
    const match = line.trimEnd().match(VERDICT_LINE)
    if (!match || (verdict !== null && verdict !== match[1])) return null
    verdict = match[1]
  }
  return verdict
}

/** @param {string | null} verdict */
function approves(verdict) {
  return verdict?.startsWith('Approve') === true
}

/** @param {unknown} me */
function reviewIdentity(me) {
  const who = typeof me === 'string' ? me.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:_[A-Za-z0-9]+)?(?:\[bot\])?$/.test(who)) {
    throw new TypeError('reviewRecords: expected a bare automation login')
  }
  return who
}

/**
 * The review records by `me` among `comments`, in the order given (GitHub
 * creation order). `verdict` and `head` are the latest record's; `verdict` is
 * null when its declarations are missing or conflict, `head` when line 2 is not
 * a review-head line. `reds` counts `Request changes` records only. `approvedHeads`
 * is the sha of every approving record that names a 40-hex commit, in order;
 * a record with no such sha is skipped. An approval spends nothing.
 *
 * @param {{ body: string, author: { login: string } | null }[]} comments
 * @param {{ me: string }} options
 * @returns {{ reviews: number, verdict: string | null, head: string | null, reds: number, approvedHeads: string[] }}
 */
export function reviewRecords(comments, { me } = {}) {
  if (!Array.isArray(comments)) throw new TypeError('reviewRecords: comments must be an array')
  const who = reviewIdentity(me)
  let reviews = 0
  let reds = 0
  /** @type {string[]} */
  const approvedHeads = []
  /** @type {string | null} */
  let latest = null
  for (const entry of comments) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError('reviewRecords: each comment must be an object')
    }
    if (entry.author?.login !== who) continue
    if (typeof entry.body !== 'string') throw new TypeError('reviewRecords: comment body must be a string')
    if (!CODE_REVIEW_FIRST_LINE.test(commentFirstLine(entry.body))) continue
    reviews++
    latest = entry.body
    const verdict = reviewVerdict(entry.body)
    if (verdict === 'Request changes') reds++
    else if (approves(verdict)) {
      const sha = reviewHeadOf(entry.body)
      if (isCommitSha(sha)) approvedHeads.push(sha)
    }
  }
  return {
    reviews,
    verdict: latest === null ? null : reviewVerdict(latest),
    head: reviewHeadOf(latest),
    reds,
    approvedHeads,
  }
}

/** Issue-comment pages, every page. `gh pr view --json comments` is a silent first 100. */
export function commentPageArgs(pr) {
  return ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${pr}/comments`]
}

/** @param {string} raw @param {number | string} pr */
function commentsFromPages(raw, pr) {
  let pages
  try {
    pages = JSON.parse(raw)
  } catch {
    throw new Error(`readReviewRecords: comment pages for ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`readReviewRecords: comment pages for ${pr} are incomplete`)
  }
  const entries = pages.flat()
  entries.sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')))
  return entries.map((entry) => {
    if (typeof entry?.body !== 'string') {
      throw new Error(`readReviewRecords: a comment page entry for ${pr} has no body`)
    }
    const login = entry?.user?.login
    return { author: { login: typeof login === 'string' ? login : '' }, body: entry.body }
  })
}

/**
 * Fresh records for `pr`: the automation login (`gh api user`), then every
 * comment page. An unreadable identity or page throws — it authorizes nothing.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
 */
export async function readReviewRecords(cwd, pr, { gh: ghFn = gh } = {}) {
  const me = reviewIdentity(await ghFn(cwd, ['api', 'user', '--jq', '.login']))
  const raw = await ghFn(cwd, commentPageArgs(pr))
  return reviewRecords(commentsFromPages(raw, pr), { me })
}

/**
 * Check runs of one sha, paginated `filter=all`, grouped later by workflow and
 * name. A required name with no check run is filled from commit statuses.
 * `epic-driver.ts` `ciFixesOf` is this read, synchronous.
 *
 * @param {string} cwd
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @param {string[]} required
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function readOneHead(cwd, owner, repo, sha, required, ghFn) {
  let checks = parseCheckRuns(await ghFn(cwd, checkRunArgs(owner, repo, sha)))
  const missing = [...new Set(checks.filter((run) => run.actionRun && !run.workflow).map((run) => run.actionRun))]
  if (missing.length) {
    /** @type {Record<string, string>} */
    const names = {}
    for (const id of missing) names[id] = workflowNameFromRun(await ghFn(cwd, workflowRunArgs(owner, repo, id)))
    checks = withWorkflowNames(checks, names)
  }
  const statuses = headNeedsStatuses(checks, required)
    ? parseCommitStatuses(await ghFn(cwd, statusArgs(owner, repo, sha)))
    : []
  return { checks, statuses }
}

/**
 * CI fixes of the approved heads. A 404 on a sha other than `current` is no runs.
 * A failed read is listed, not counted: the caller throws only when those heads
 * could push the allowance over.
 *
 * @param {string} cwd
 * @param {string[]} heads
 * @param {string[]} required
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {string | null} current
 */
async function readApprovedRuns(cwd, heads, required, ghFn, current) {
  const { owner, repo } = await repoSlug(cwd, ghFn)
  /** @type {Record<string, { checks: object[], statuses: object[] }>} */
  const runsByHead = {}
  /** @type {string[]} */
  const failed = []
  for (const sha of [...new Set(heads.filter(isCommitSha))]) {
    try {
      runsByHead[sha] = await readOneHead(cwd, owner, repo, sha, required, ghFn)
    } catch (error) {
      if (sha !== current && isMissingRef(error)) {
        runsByHead[sha] = { checks: [], statuses: [] }
        continue
      }
      failed.push(sha)
    }
  }
  return { runsByHead, failed, ciFixes: ciFixCount(runsByHead, required) }
}

/**
 * The allowance the records and, when it can change the answer, the check runs
 * support. Skips the read when reds alone already spend it, and when even
 * counting every approved sha cannot. `need` forces a read of that head so a
 * ci-failed grant is priced by the same count.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {{ reds: number, approvedHeads: string[] }} records
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {{ landing?: { required_checks?: string[] }, need?: string | null }} [opts]
 */
async function readFixAllowance(cwd, pr, records, ghFn, { landing, need = null } = {}) {
  if (records.reds > MAX_FIX_ROUNDS) return { ciFixes: 0, current: false }
  const heads = records.approvedHeads
  const must = unreadCouldSpend(records.reds, heads)
  const needed = isCommitSha(need) && heads.includes(need)
  if (!must && !needed) return { ciFixes: 0, current: false }
  const required = await resolveFixChecks(cwd, pr, ghFn, landing)
  const read = await readApprovedRuns(cwd, heads, required, ghFn, need)
  if (read.failed.length && records.reds + read.ciFixes + read.failed.length > MAX_FIX_ROUNDS) {
    throw new Error(`check runs unreadable for ${read.failed.join(', ')} and the bound could be spent`)
  }
  if (needed && read.failed.includes(/** @type {string} */ (need))) {
    throw new Error('check runs of the current head are unreadable')
  }
  const entry = need ? read.runsByHead[need] : undefined
  const current = entry ? ciFixCount({ [/** @type {string} */ (need)]: entry }, required) === 1 : false
  return { ciFixes: read.ciFixes, current }
}

const STOP_GUIDANCE =
  'Publish the escalation dossier (dev-review Phase 8). Automation on this PR is finished: a NEW superseding PR from a revised ticket, or the operator finishing this PR by hand.'

/** @param {'review-bound' | 'ci-failed'} reason @param {number} reviews */
function stopStep(reason, reviews) {
  const why =
    reason === 'ci-failed'
      ? 'A required check failed on the approved head, and that failure would be the third automated fix.'
      : 'Review bound reached: the automated-fix allowance is spent.'
  return { action: /** @type {'stop'} */ ('stop'), reason, reviews, message: `${why} ${STOP_GUIDANCE}` }
}

/** @param {number} reviews @param {number} fixes @param {'ci-failed'} [reason] */
function fixStep(reviews, fixes, reason) {
  return {
    action: /** @type {'fix'} */ ('fix'),
    reviews,
    remaining: MAX_FIX_ROUNDS - fixes,
    ...(reason ? { reason } : {}),
  }
}

/**
 * The move the records allow at the PR's current `head`. The current event is
 * priced against the count excluding itself: `prior > MAX_FIX_ROUNDS` is already
 * sticky (`review-bound`, never reclassified). A CI failure on an approving
 * current head stops `ci-failed` only when this head would be the third fix,
 * and only when the head is itself in the CI-fix count.
 *
 * @param {{ reviews: number, verdict: string | null, head: string | null, reds: number }} records
 * @param {{ head: unknown, ciFailed?: boolean, posted?: { verdict: string, head: string }, ciFixes?: number, currentCiFix?: boolean }} at
 */
function reviewStep(records, { head, ciFailed = false, posted, ciFixes = 0, currentCiFix = false }) {
  const { reviews, reds } = records
  if (posted !== undefined) {
    if (!VERDICTS.includes(posted?.verdict) || !isCommitSha(posted?.head)) {
      throw new TypeError('nextReviewStep: posted must be { verdict: <panel verdict>, head: <40-hex sha> }')
    }
    if (records.verdict !== posted.verdict || records.head !== posted.head) {
      throw new Error(
        `nextReviewStep: the latest review record is not the one just posted — posted ${posted.verdict} at ${posted.head}, read ${records.verdict} at ${records.head}`,
      )
    }
  }
  const current = isCommitSha(head) && records.head === head
  const currentRed = current && records.verdict === 'Request changes'
  const pricingCi = ciFailed && current && approves(records.verdict)
  const prior = currentRed ? reds - 1 + ciFixes : pricingCi ? reds + ciFixes - (currentCiFix ? 1 : 0) : reds + ciFixes
  if (prior > MAX_FIX_ROUNDS) return stopStep('review-bound', reviews)
  if (ciFailed) {
    if (!current || !approves(records.verdict)) {
      throw new Error('nextReviewStep: a ci-failed fix needs the latest review record to approve the current head')
    }
    if (!currentCiFix) {
      throw new Error('nextReviewStep: a ci-failed fix is granted only when the current head is a counted CI fix')
    }
    const fixes = prior + 1
    return fixes > MAX_FIX_ROUNDS ? stopStep('ci-failed', reviews) : fixStep(reviews, fixes, 'ci-failed')
  }
  if (reviews === 0) return { action: /** @type {'review'} */ ('review'), reason: 'no-review', reviews }
  if (!current) return { action: /** @type {'review'} */ ('review'), reason: 'head-moved', reviews }
  if (approves(records.verdict)) return { action: /** @type {'land'} */ ('land'), reviews }
  if (records.verdict === 'Request changes') {
    const fixes = prior + 1
    return fixes > MAX_FIX_ROUNDS ? stopStep('review-bound', reviews) : fixStep(reviews, fixes)
  }
  return { action: /** @type {'review'} */ ('review'), reason: 'no-verdict', reviews }
}

/**
 * The loop's one decision point (#716): fresh records, the CI fixes of approved
 * heads when they can spend the allowance, the PR's current gate, then the step —
 * `land` | `fix` | `stop` | `review`. `posted` is the review dev-review just posted.
 * `ciFailed` asks for the correction of a red check on the approved head, granted
 * only when that head is itself a counted CI fix. Every step but `land` disarms
 * an OPEN armed PR first (`disarmed: true`); `reviewing` — a review is about to
 * start — disarms on `land` too, and an approving post re-arms through `landPr`.
 * A gate stays armed only while the latest record approves the current head
 * within the allowance and no review of it is running. Nothing else is written;
 * a throw decides nothing and writes nothing.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{
 *   posted?: { verdict: string, head: string },
 *   ciFailed?: boolean,
 *   reviewing?: boolean,
 *   gh?: (cwd: string, args: string[]) => Promise<string>,
 * }} [opts]
 */
export async function nextReviewStep(cwd, pr, { posted, ciFailed = false, reviewing = false, gh: ghFn = gh } = {}) {
  if (pr === null || pr === undefined || pr === '') {
    throw new TypeError(`nextReviewStep: pr is required, got ${JSON.stringify(pr)}`)
  }
  const number = await resolveReviewPr(cwd, pr, { gh: ghFn })
  const records = await readReviewRecords(cwd, number, { gh: ghFn })
  const gate = await readGate(cwd, number, ghFn)
  const allowance = await readFixAllowance(cwd, number, records, ghFn, {
    need: ciFailed ? gate.headRefOid : null,
  })
  const step = reviewStep(records, {
    head: gate.headRefOid,
    ciFailed,
    posted,
    ciFixes: allowance.ciFixes,
    currentCiFix: allowance.current,
  })
  if ((reviewing || step.action !== 'land') && (await disarmGate(cwd, number, gate, ghFn))) {
    return { ...step, disarmed: true }
  }
  return step
}
