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
 * (`disarmed: true`) and writes nothing else. Native with no required checks —
 * explicit `[]`, or discovery that returned none (a failed lookup also returns
 * none, which is not proof that protection is absent) — returns
 * `no-required-checks` and disarms the known armed gate the same way, even on an
 * unchanged approved head. Nothing re-arms it: re-entry passes the normal gate.
 * `disarmed: true` is reported only when a read-back confirmed the disarm; a no-op
 * claims nothing. A disarm that cannot finish throws an error naming what stays
 * armed — except after native auto-merge was pinned, or an already-enabled disable
 * failed, where it returns `auto-merge-failed`. In those two handlings that status
 * carries `armed: false` only when a read-back confirmed the gate clear; otherwise
 * `armed: true` and an `error` naming what stays armed. A refused pin is the
 * exception: its `auto-merge-failed` / `armed: false` says the pin was refused, not
 * that the gate is clear, and an unreadable head there is the deferred #731 defect.
 * Every other exit after a write that armed the PR re-reads the head: a head
 * that moved or cannot be read disarms through `knownGate()` and returns
 * `not-approved` / `head-moved`, or the stuck error when that disarm fails. A head
 * or label read that fails before any write is disarmed the same way and its error
 * rethrown. A `bad-landing` made no writes: an already-armed approved gate may exist.
 * Native auto-merge is then requested with `--match-head-commit` of that reviewed
 * sha — an enable-time pin, not a later-push lease.
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
  // past a spent bound. The gate is read before any landing step; a refusal disarms it.
  const gate = await readGate(cwd, pr, ghFn)
  // What this call armed since the gate read. A disarm must cover it even when the
  // fresh read it would use fails: the read-back inside `disarmGate` then decides.
  const armedByUs = { auto: false, label: false }
  const knownGate = () => ({
    ...gate,
    labels:
      armedByUs.label && !gate.labels.some((label) => label?.name === 'reviewed')
        ? [...gate.labels, { name: 'reviewed' }]
        : gate.labels,
    autoMergeRequest: armedByUs.auto ? (gate.autoMergeRequest ?? { pinned: true }) : gate.autoMergeRequest,
  })
  const refuse = async (reason, snapshot) => {
    let seen = snapshot
    if (!seen) {
      try {
        seen = await readGate(cwd, pr, ghFn)
      } catch {
        seen = knownGate()
      }
    }
    const disarmed = await disarmGate(cwd, pr, seen, ghFn)
    return { status: 'not-approved', reviews, ...(reason && { reason }), ...(disarmed && { disarmed }) }
  }
  if (records.spent) return refuse('review-bound', gate)
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
    if (required.length === 0) {
      // Native without required checks refuses to continue landing: a known armed
      // gate is disarmed even on an unchanged approved head. One call on the opening
      // gate — no head or gate re-read, no retry. `disarmed` only when confirmed.
      const disarmed = await disarmGate(cwd, pr, gate, ghFn)
      return { status: 'no-required-checks', ...(disarmed && { disarmed }) }
    }
  }

  const headMoved = async () => {
    const again = await readHeadRefOid(cwd, pr, ghFn)
    return !isCommitSha(again) || again !== records.head
  }
  const moved = () => refuse('head-moved')
  // A read after the gate that fails (head or labels) says nothing about the head,
  // and the gate may be armed. Disarm through knownGate(), then rethrow the original
  // error; a disarm that cannot finish throws the stuck error with it as the cause.
  const disarmAndRethrow = async (error) => {
    try {
      await disarmGate(cwd, pr, knownGate(), ghFn)
    } catch (disarmError) {
      throw new Error(`${errorText(disarmError)} — after: ${errorText(error)}`, { cause: error })
    }
    throw error
  }
  const headMovedOrDisarm = async () => {
    try {
      return await headMoved()
    } catch (error) {
      return disarmAndRethrow(error)
    }
  }
  // The head re-read after a write that armed the PR. A head that cannot be read
  // after the write is not a verified head: disarm what the call wrote, then rethrow
  // the read error. When the disarm fails too, `stuck` names what stays armed.
  const movedAfterWrite = async () => {
    try {
      return { moved: await headMoved() }
    } catch (error) {
      try {
        await disarmGate(cwd, pr, knownGate(), ghFn)
      } catch (disarmError) {
        return { moved: true, stuck: `${errorText(disarmError)} — after: ${errorText(error)}` }
      }
      throw error
    }
  }
  // A return that would leave the PR armed is not a lease on the last head read.
  // Moved or unreadable: disarm through knownGate() — it includes what this call
  // armed — then not-approved. A disarm that cannot finish is the stuck error.
  const refuseIfMoved = async () => {
    let gone = true
    /** @type {unknown} */
    let readError
    try {
      gone = await headMoved()
    } catch (error) {
      gone = true
      readError = error
    }
    if (!gone) return null
    try {
      const disarmed = await disarmGate(cwd, pr, knownGate(), ghFn)
      return { status: 'not-approved', reviews, reason: 'head-moved', ...(disarmed && { disarmed }) }
    } catch (disarmError) {
      const stuck = readError ? `${errorText(disarmError)} — after: ${errorText(readError)}` : errorText(disarmError)
      throw new Error(stuck)
    }
  }
  // A refused pin leaves the gate as the call found it — but GitHub refuses a pin whose
  // head no longer matches, and a head that moved meanwhile leaves an armed gate at a
  // head nobody reviewed: that goes through the one disarm. A head that cannot be read
  // is no news, and the gate stays as it was (the deferred #731 unreadable-head case).
  const pinRefused = async () => {
    let gone = false
    try {
      gone = await headMoved()
    } catch {
      gone = false
    }
    return gone ? moved() : { status: 'auto-merge-failed', armed: false }
  }
  // A throw after an arming write does not prove the write failed. Record the arm,
  // then the same re-read: a moved or unreadable head is disarmed through knownGate().
  const addReviewed = async () => {
    try {
      await ghFn(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
    } catch {
      armedByUs.label = true
      return refuseIfMoved()
    }
    armedByUs.label = true
    return null
  }
  const disarmedAfterDisable = (readError) =>
    readError
      ? `head unreadable after --disable-auto failed; the gate was disarmed — ${errorText(readError)}`
      : 'head moved after --disable-auto failed; the gate was disarmed'
  // `disarmGate` returning false wrote nothing and read nothing back: the opening
  // snapshot was not OPEN. That is not proof the gate is clear now: read it, and
  // name exactly what that read shows — never a disarm that did not happen.
  const disarmAfterDisableFailed = async (disableError, readError) => {
    let cleared = false
    try {
      cleared = await disarmGate(cwd, pr, knownGate(), ghFn)
    } catch (disarmError) {
      const stuck = readError ? `${errorText(disarmError)} — after: ${errorText(readError)}` : errorText(disarmError)
      return { status: 'auto-merge-failed', armed: true, error: stuck }
    }
    if (cleared) return { status: 'auto-merge-failed', armed: false, error: disarmedAfterDisable(readError) }
    try {
      const back = await readGate(cwd, pr, ghFn)
      const names = []
      if (back.autoMergeRequest) names.push('auto-merge')
      if (back.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
      if (names.length === 0) {
        const head = readError ? `the head could not be read — ${errorText(readError)}` : 'the head moved'
        return {
          status: 'auto-merge-failed',
          armed: false,
          error: `PR ${pr} is ${back.state} with nothing armed after --disable-auto failed; ${head}`,
        }
      }
      return {
        status: 'auto-merge-failed',
        armed: true,
        error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(disableError)})`,
      }
    } catch (error) {
      return {
        status: 'auto-merge-failed',
        armed: true,
        error: `PR ${pr} could not be read back; auto-merge and reviewed may stay armed — ${errorText(error)}`,
      }
    }
  }

  const pin = ['pr', 'merge', String(pr), '--auto', '--merge', '--match-head-commit', records.head]

  /** @type {string} */
  let since = ''
  if (resolved.mode === 'merge-on-green') {
    const before = await labeledReviewedAt(cwd, pr, ghFn)
    /** @type {{ name?: string }[]} */
    let labels
    try {
      labels = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'labels'])).labels ?? []
      if (!Array.isArray(labels)) throw new Error(`landPr: gh pr view ${pr} carried no labels`)
    } catch (error) {
      return disarmAndRethrow(error)
    }
    // Re-read immediately before the write. The earlier check is not a lease.
    if (await headMovedOrDisarm()) return moved()
    if (labels.some((label) => label?.name === 'reviewed')) {
      await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
    }
    const added = await addReviewed()
    if (added) return added
    // The re-read before the write is not a lease on the label either.
    const afterLabel = await movedAfterWrite()
    if (afterLabel.stuck) throw new Error(afterLabel.stuck)
    if (afterLabel.moved) return moved()
    since = await waitLabeledSince(cwd, pr, ghFn, before, sleep)
    const afterWait = await refuseIfMoved()
    if (afterWait) return afterWait
    if (!since) {
      return {
        status: 'watch-failed',
        error: 'could not read the labeled reviewed event after re-label — merge-on-green needs --since from GitHub',
      }
    }
  } else {
    // The pin is the merge authority. The label comes after it, so a failed
    // or unpinned enable never leaves `reviewed` for the fleet workflow.
    if (await headMovedOrDisarm()) return moved()
    try {
      await ghFn(cwd, pin)
      armedByUs.auto = true
    } catch (e) {
      const msg = errorText(e)
      // A throw does not prove the pin failed to apply. `already enabled` proves
      // auto-merge is on now, even when the opening snapshot missed it — record
      // that before the disable, so a later disarm is not aimed at an empty gate.
      armedByUs.auto = true
      if (!/already enabled/i.test(msg)) return pinRefused()
      // Replacing an enable that is already on. A failed disable re-reads the
      // head: still the reviewed one, the gate stays and the error names it; moved
      // or unreadable, disarm through knownGate() and claim clear only when the
      // read-back says so.
      try {
        await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
      } catch (disableError) {
        let gone = true
        /** @type {unknown} */
        let readError
        try {
          gone = await headMoved()
        } catch (error) {
          gone = true
          readError = error
        }
        if (gone) return disarmAfterDisableFailed(disableError, readError)
        const known = knownGate()
        const names = []
        if (known.autoMergeRequest) names.push('auto-merge')
        if (known.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
        return {
          status: 'auto-merge-failed',
          armed: true,
          error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(disableError)})`,
        }
      }
      if (await headMovedOrDisarm()) return moved()
      try {
        await ghFn(cwd, pin)
        armedByUs.auto = true
      } catch {
        // The retry may have applied too. An unreadable head stays on pinRefused.
        armedByUs.auto = true
        return pinRefused()
      }
    }
    // The pin is now live. A head that moved or cannot be read goes through the one
    // disarm; a disarm that fails reports the gate as still armed.
    const afterPin = await movedAfterWrite()
    if (afterPin.stuck) return { status: 'auto-merge-failed', armed: true, error: afterPin.stuck }
    if (afterPin.moved) {
      try {
        return await moved()
      } catch (error) {
        return { status: 'auto-merge-failed', armed: true, error: errorText(error) }
      }
    }
    const added = await addReviewed()
    if (added) return added
    const afterAdd = await refuseIfMoved()
    if (afterAdd) return afterAdd
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

/** ADR-020 §3 / #488 / #710: at most two automated fixes per PR, one per review. */
export const MAX_FIX_ROUNDS = 2

/**
 * The bound is two reads of the PR's review records (#710): how many there are,
 * and the latest one. A review record is a comment by the automation login whose
 * first line is `<!-- omp-build:code-review -->`. Every other comment — fix
 * receipts, prose, older accounting markers — is ignored. Nothing writes
 * accounting: every decision is derived again from a fresh read. Every posted
 * review counts, with or without a fix before it.
 */
const CODE_REVIEW_FIRST_LINE = /^<!--\s*omp-build:code-review\s*-->\s*$/
const VERDICT_LINE = /^\*\*Verdict:\s*(Request changes|Approve with comments|Approve \(clean\)|Approve)\*\*(?:\s.*)?$/
const VERDICTS = ['Request changes', 'Approve with comments', 'Approve (clean)', 'Approve']
/** Line 2 only. A sha anywhere else in the body is not the reviewed commit. */
const REVIEW_HEAD_LINE = /^<!-- omp-build:review-head sha=([0-9a-f]{40}) -->$/

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

/** @param {unknown} error */
const errorText = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Disarm an OPEN PR whose gate is armed. Each write is attempted whatever the
 * other did: auto-merge is disabled first (it is the one that merges without a
 * further event), then `reviewed` is removed. When any write was attempted the
 * gate is read back, and the disarm is confirmed only by a complete OPEN
 * observation with nothing armed: an own `autoMergeRequest` field that is null,
 * and label names. A read-back that is OPEN with something still armed, that
 * cannot be read, is incomplete or of an unknown state, or finds the PR MERGED
 * throws one error naming what stays armed, with the write errors. A write error
 * over a clean OPEN read-back is not an error: the gate is disarmed. A CLOSED
 * read-back is terminal — no OPEN gate remains; it does not say the stored
 * fields were erased. Returns whether either arm was on and the disarm was
 * confirmed; a PR that is not OPEN, or whose gate is not armed, is left alone
 * (`false`: no writes, no read-back, nothing claimed).
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{ state?: string, labels: { name?: string }[], autoMergeRequest?: unknown }} gate
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 */
async function disarmGate(cwd, pr, gate, ghFn) {
  if (gate.state !== 'OPEN') return false
  const labelled = gate.labels.some((label) => label?.name === 'reviewed')
  const autoOn = Boolean(gate.autoMergeRequest)
  if (!labelled && !autoOn) return false
  /** @type {string[]} */
  const failures = []
  if (autoOn) {
    try {
      await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
    } catch (error) {
      failures.push(`--disable-auto failed: ${errorText(error)}`)
    }
  }
  if (labelled) {
    try {
      await ghFn(cwd, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
    } catch (error) {
      failures.push(`--remove-label failed: ${errorText(error)}`)
    }
  }
  const detail = failures.length ? ` (${failures.join('; ')})` : ''
  /** @param {string} why */
  const unconfirmed = (why) =>
    new Error(`disarmGate: PR ${pr} could not be read back; auto-merge and reviewed may stay armed${detail} — ${why}`)
  let back
  try {
    back = await readGate(cwd, pr, ghFn)
  } catch (error) {
    throw unconfirmed(errorText(error))
  }
  if (back.state === 'MERGED') throw new Error(`disarmGate: PR ${pr} merged while being disarmed${detail}`)
  if (back.state === 'CLOSED') return true
  if (back.state !== 'OPEN') throw unconfirmed(`the read-back state is ${JSON.stringify(back.state) ?? 'missing'}`)
  if (!('autoMergeRequest' in back) || (back.autoMergeRequest !== null && typeof back.autoMergeRequest !== 'object')) {
    throw unconfirmed('the read-back carried no auto-merge state')
  }
  if (!back.labels.every((label) => typeof label?.name === 'string')) {
    throw unconfirmed('the read-back carried unreadable labels')
  }
  const stays = []
  if (back.autoMergeRequest) stays.push('auto-merge')
  if (back.labels.some((label) => label?.name === 'reviewed')) stays.push('the reviewed label')
  if (stays.length) throw new Error(`disarmGate: PR ${pr} stays armed — ${stays.join(' and ')}${detail}`)
  return true
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
 * a review-head line. `spent`: a record past the `MAX_FIX_ROUNDS`-th does not
 * approve. The bound is then spent for good — a later green does not lift it.
 *
 * @param {{ body: string, author: { login: string } | null }[]} comments
 * @param {{ me: string }} options
 * @returns {{ reviews: number, verdict: string | null, head: string | null, spent: boolean }}
 */
export function reviewRecords(comments, { me } = {}) {
  if (!Array.isArray(comments)) throw new TypeError('reviewRecords: comments must be an array')
  const who = reviewIdentity(me)
  let reviews = 0
  /** @type {string | null} */
  let latest = null
  let spent = false
  for (const entry of comments) {
    if (typeof entry !== 'object' || entry === null)
      throw new TypeError('reviewRecords: each comment must be an object')
    if (entry.author?.login !== who) continue
    if (typeof entry.body !== 'string') throw new TypeError('reviewRecords: comment body must be a string')
    if (!CODE_REVIEW_FIRST_LINE.test(commentFirstLine(entry.body))) continue
    reviews++
    latest = entry.body
    if (reviews > MAX_FIX_ROUNDS && !approves(reviewVerdict(entry.body))) spent = true
  }
  return { reviews, verdict: latest === null ? null : reviewVerdict(latest), head: reviewHeadOf(latest), spent }
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

const STOP_GUIDANCE =
  'Publish the escalation dossier (dev-review Phase 8). Automation on this PR is finished: a NEW superseding PR from a revised ticket, or the operator finishing this PR by hand.'

/** @param {'review-bound' | 'ci-failed'} reason @param {number} reviews */
function stopStep(reason, reviews) {
  const why =
    reason === 'ci-failed'
      ? `A required check failed on the head review ${reviews} approved, and no fix is left.`
      : `Review bound reached: ${reviews} reviews and the latest after the bound does not approve.`
  return { action: /** @type {'stop'} */ ('stop'), reason, reviews, message: `${why} ${STOP_GUIDANCE}` }
}

/** @param {number} reviews @param {'ci-failed'} [reason] */
function fixStep(reviews, reason) {
  return {
    action: /** @type {'fix'} */ ('fix'),
    reviews,
    remaining: MAX_FIX_ROUNDS - reviews,
    ...(reason ? { reason } : {}),
  }
}

/**
 * `posted` must be a `{ verdict, head }` the panel could have posted. Checked
 * before any read, like `pr`: a malformed argument touches nothing.
 *
 * @param {unknown} posted
 */
function assertPostedShape(posted) {
  if (posted === undefined) return
  const shape = /** @type {{ verdict?: unknown, head?: unknown } | null} */ (posted)
  if (!VERDICTS.includes(/** @type {string} */ (shape?.verdict)) || !isCommitSha(shape?.head)) {
    throw new TypeError('nextReviewStep: posted must be { verdict: <panel verdict>, head: <40-hex sha> }')
  }
}

/**
 * May this gate stay armed? Only when the latest record approves the current
 * head within the bound and no review of that head is running.
 *
 * @param {{ verdict: string | null, head: string | null, spent: boolean }} records
 * @param {{ headRefOid?: unknown }} gate
 * @param {boolean} reviewing
 */
function mayStayArmed(records, gate, reviewing) {
  return (
    !reviewing &&
    !records.spent &&
    approves(records.verdict) &&
    isCommitSha(gate.headRefOid) &&
    records.head === gate.headRefOid
  )
}

/**
 * The move the records allow at the PR's current `head`.
 *
 * - `posted` (the review just posted) must be the latest record, else throw.
 * - `spent` → `stop`, whatever the head.
 * - `ciFailed` needs an approving latest record of the current head, else throw;
 *   then `fix` while `reviews <= MAX_FIX_ROUNDS`, else `stop`.
 * - No record, or a latest record of another commit or with no verdict →
 *   `review`: post a review of the current head first. One review allows one fix:
 *   the fix's push moves the head.
 * - An approval → `land`; `Request changes` → `fix` (a red past the bound is spent).
 *
 * @param {{ reviews: number, verdict: string | null, head: string | null, spent: boolean }} records
 * @param {{ head: unknown, ciFailed?: boolean, posted?: { verdict: string, head: string } }} at
 */
function reviewStep(records, { head, ciFailed = false, posted }) {
  const { reviews } = records
  if (posted !== undefined && (records.verdict !== posted.verdict || records.head !== posted.head)) {
    throw new Error(
      `nextReviewStep: the latest review record is not the one just posted — posted ${posted.verdict} at ${posted.head}, read ${records.verdict} at ${records.head}`,
    )
  }
  if (records.spent) return stopStep('review-bound', reviews)
  const current = isCommitSha(head) && records.head === head
  if (ciFailed) {
    if (!current || !approves(records.verdict)) {
      throw new Error('nextReviewStep: a ci-failed fix needs the latest review record to approve the current head')
    }
    return reviews <= MAX_FIX_ROUNDS ? fixStep(reviews, 'ci-failed') : stopStep('ci-failed', reviews)
  }
  if (reviews === 0) return { action: /** @type {'review'} */ ('review'), reason: 'no-review', reviews }
  if (!current) return { action: /** @type {'review'} */ ('review'), reason: 'head-moved', reviews }
  if (approves(records.verdict)) return { action: /** @type {'land'} */ ('land'), reviews }
  if (records.verdict === 'Request changes') return fixStep(reviews)
  return { action: /** @type {'review'} */ ('review'), reason: 'no-verdict', reviews }
}

/**
 * The loop's one decision point (#710): fresh records, the PR's current gate,
 * then the step — `land` | `fix` | `stop` | `review`. `posted` is the review
 * dev-review just posted (its verdict and REVIEWED_HEAD). `ciFailed` asks for
 * the correction of a red check on the approved head. Every step but `land`
 * disarms an OPEN armed PR first (`disarmed: true`); `reviewing` — a review is
 * about to start — disarms on `land` too, and an approving post re-arms through
 * `landPr`. A gate stays armed only while the latest record approves the current
 * head within the bound and no review of it is running. Nothing else is written.
 * A throw decides nothing: a malformed `posted`, an unreadable PR or record, or
 * a refused `posted` / `ciFailed` over an approving, current gate leaves the
 * gate as it was; a refusal over a gate that may not stay armed disarms it
 * first. When that disarm itself fails the error names what stays armed,
 * appended to the refusal.
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
  assertPostedShape(posted)
  const number = await resolveReviewPr(cwd, pr, { gh: ghFn })
  const records = await readReviewRecords(cwd, number, { gh: ghFn })
  const gate = await readGate(cwd, number, ghFn)
  let step
  try {
    step = reviewStep(records, { head: gate.headRefOid, ciFailed, posted })
  } catch (error) {
    // A refusal decides nothing, but it must not leave a gate armed that may not stay.
    if (!mayStayArmed(records, gate, reviewing)) {
      try {
        await disarmGate(cwd, number, gate, ghFn)
      } catch (disarmError) {
        throw new Error(`${errorText(error)} — and the disarm failed: ${errorText(disarmError)}`, { cause: error })
      }
    }
    throw error
  }
  if ((reviewing || step.action !== 'land') && (await disarmGate(cwd, number, gate, ghFn))) {
    return { ...step, disarmed: true }
  }
  return step
}
