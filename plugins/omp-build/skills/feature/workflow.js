/**
 * Deterministic core `/feature` uses: open a PR, derive the review loop's next step, and land.
 * Landing binds the selected PR's base coordinates. No worktree driver.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildRecord,
  decodeHistory,
  deriveReviewState,
  githubScope,
  publishGitHubRecord,
  readGitHubHistory,
  summarizeReviews,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { resolveReviewSemanticContext } from '../../roxabi/review-context'
import {
  admitLanding,
  captureReviewInput as captureProofReviewInput,
  proofSemanticContext,
  refreshSelectedBase,
  reviewSemanticCanon,
} from './proof'

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

/**
 * Lossless, non-throwing git: exit code and both streams exactly as printed, for
 * readers that must tell a failure, an empty answer and a path ending in
 * whitespace apart.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function gitResult(cwd, args) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    cwd,
    env: stripGitHookEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stdout, stderr }
}

async function git(cwd, args) {
  const { code, stdout, stderr } = await gitResult(cwd, args)
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
  if (already !== null) {
    const binding = await confirmSelectedBinding(cwd, already, ghFn, { issue: n, branch: head, base: baseRef })
    if (!binding.ok) throw new Error(`openPr: workflow binding refused: ${binding.reason}`)
    return { number: already, status: 'existing' }
  }

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
      if (raced !== null) {
        const binding = await confirmSelectedBinding(cwd, raced, ghFn, { issue: n, branch: head, base: baseRef })
        if (!binding.ok) throw new Error(`openPr: workflow binding refused: ${binding.reason}`)
        return { number: raced, status: 'existing' }
      }
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
  const binding = await confirmSelectedBinding(cwd, number, ghFn, { issue: n, branch: head, base: baseRef })
  if (!binding.ok) throw new Error(`openPr: workflow binding refused: ${binding.reason}`)
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

/** @param {string} cwd @param {string} base @param {(cwd: string, args: string[]) => Promise<string>} ghFn */
async function resolveRequiredContexts(cwd, base, ghFn) {
  const out = new Set()
  try {
    const { nameWithOwner } = JSON.parse(await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    const [owner, repo] = (nameWithOwner || '').split('/')
    if (!owner || !repo) return []

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
 * Sync git for the landing resolver. Hook env is stripped so a harness GIT_DIR
 * cannot redirect the read to another repository.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function gitSync(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    cwd,
    env: stripGitHookEnv(),
    encoding: 'utf8',
  })
  return result
}

/**
 * The one landing resolver: `origin/<base>:.dev/stack.yml` (absent → no landing
 * block) and `origin/<base>:.github/workflows/merge-on-green.yml` as the mode
 * fallback. A head's own tree never selects the mode or its required checks —
 * `landPr` and `ci-watch.sh` both resolve through it (#623). Throws on an
 * invalid landing. `base` is required.
 *
 * @param {string} cwd
 * @param {{ base: string }} opts
 */
export function readLanding(cwd, { base } = {}) {
  if (typeof base !== 'string' || !base) {
    throw new Error('readLanding: base is required — landing is read from origin/<base>, never the working tree')
  }
  return readLandingAt(cwd, `refs/remotes/origin/${base}`)
}

/** Policy of the established base object, never a moving ref or the candidate. */
function readLandingAt(cwd, at) {
  const refPath = (path) => `${at}:${path}`
  const stack = gitSync(cwd, ['show', refPath('.dev/stack.yml')])
  const stackText = stack.status === 0 ? stack.stdout : ''
  const workflow = gitSync(cwd, ['cat-file', '-e', refPath('.github/workflows/merge-on-green.yml')])
  return parseLanding(stackText, { mergeOnGreenWorkflow: workflow.status === 0 })
}

/**
 * The selected base branch `name`, at the tip a fresh fetch of it reads — never
 * a guessed principal branch, and never `baseRefOid`, which GitHub records at
 * creation, head push or retarget and does not advance when the branch moves.
 * A failed fetch is carried as `refusal`.
 */
async function fetchBase(cwd, name, gitFn, ghFn) {
  const fetched = await refreshSelectedBase(cwd, typeof name === 'string' ? name : '', gitFn, ghFn)
  return fetched.ok ? { name, tip: fetched.tip } : { name, refusal: fetched }
}

/** The selected PR's base coordinates: its base name read from GitHub, its tip fetched. */
async function resolveLandingBase(cwd, pr, ghFn, gitFn) {
  const data = await readPrFields(cwd, pr, ghFn, 'baseRefName')
  return fetchBase(cwd, data.baseRefName, gitFn, ghFn)
}

/**
 * Read the body and complete producer publications that this review will judge.
 * No approval, comment, producer invocation or gate write is performed.
 * @param {string} cwd
 * @param {number | string} pr
 * @param {string} head The head captured at review start; never replace it during review.
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string>, git?: import('./proof').Git }} [deps]
 */
/**
 * Confirmed review context for the proof canon. Invalid, drifted, partial, or
 * unreadable bindings refuse here, before any proof hash. An absent binding is
 * review context only — never landing authority.
 * @param {string} cwd
 * @param {number | string} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {string} base
 * @returns {Promise<import('./proof').ProofSemanticContext | import('./proof').Refusal>}
 */
export async function confirmedReviewSemanticContext(cwd, pr, ghFn, base) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefName,body')
  if (typeof selected.headRefName !== 'string' || selected.headRefName === '') {
    return { ok: false, producer: 'candidate', reason: 'unreadable', error: 'PR head branch is unreadable' }
  }
  const body = typeof selected.body === 'string' ? selected.body : ''
  const resolved = await resolveReviewSemanticContext({
    cwd,
    repository: scope.repository,
    pr: Number(pr),
    body,
    branch: selected.headRefName,
    base,
    gh: ghFn,
  })
  if (!resolved?.ok) {
    const diagnostic = Array.isArray(resolved?.diagnostics) ? resolved.diagnostics[0] : undefined
    const code = typeof diagnostic?.code === 'string' ? diagnostic.code : ''
    return {
      ok: false,
      producer: 'candidate',
      reason: code.endsWith('unreadable') ? 'unreadable' : 'unbound',
      error: typeof diagnostic?.message === 'string' ? diagnostic.message : 'review semantic context refused',
    }
  }
  return proofSemanticContext(resolved.value)
}

export async function captureReviewInput(
  cwd,
  pr,
  head,
  { gh: ghFn = gh, git: gitFn = gitResult, semantic: supplied } = {},
) {
  const selected = await readPrFields(cwd, pr, ghFn, 'headRefOid,baseRefName')
  if (!isCommitSha(head) || selected.headRefOid !== head)
    return {
      ok: false,
      producer: 'candidate',
      reason: 'unbound',
      error: 'the review head changed; start a fresh review',
    }
  const base = await fetchBase(cwd, selected.baseRefName, gitFn, ghFn)
  if (base.refusal) return base.refusal
  const semantic = supplied ?? (await confirmedReviewSemanticContext(cwd, pr, ghFn, base.name))
  if (semantic.ok === false) return semantic
  const snapshot = await captureProofReviewInput(
    cwd,
    { pr: Number(pr), candidate: head, base: base.name, baseTip: base.tip },
    { gh: ghFn, git: gitFn, semantic },
  )
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    input: snapshot.input,
    body: snapshot.body,
    semctx: snapshot.semctx,
    assertledger: snapshot.assertledger,
    semantic,
    semanticCanon: reviewSemanticCanon(semantic),
  }
}

/** Freshly compare the retained read binding before posting; never rebind a stale review.
 * @param {string} cwd
 * @param {number | string} pr
 * @param {string} head
 * @param {string | null} input
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string>, git?: import('./proof').Git }} [deps]
 */
export async function validateReviewInput(cwd, pr, head, input, deps = {}) {
  const { semantic: _stale, ...fresh } = deps
  const current = await captureReviewInput(cwd, pr, head, fresh)
  if (!current.ok) return current
  if (current.input !== input)
    return {
      ok: false,
      producer: 'candidate',
      reason: 'unbound',
      error:
        'review inputs changed during review; do not post this approval or replace its binding — start a fresh review',
    }
  return { ok: true }
}

/** Attempts to read a labeled-reviewed time newer than the pre-add snapshot. */
const SINCE_ATTEMPTS = 5
/** Delay between post-add events reads (tests inject a no-op `sleep`). */
const SINCE_RETRY_MS = 200

/**
 * Arm `reviewed` and hand the wait to `/ci-watch`. No in-process poll.
 * First resolve the PR, read complete canonical review records, then its gate.
 * A durable bound or a latest decision that does not approve returns
 * `not-approved`. An approval arms only when its record's bound candidate is the
 * PR's current `headRefOid` (both 40 lowercase hex). An unreadable candidate is
 * `review-unbound`; a different oid is `head-moved`.
 * Every `not-approved` exit disarms an already armed OPEN PR (`disarmed: true`)
 * and writes nothing else. Native with no required checks —
 * explicit `[]`, or discovery that returned none (a failed lookup also returns
 * none, which is not proof that protection is absent) — returns
 * `no-required-checks` and disarms the known armed gate the same way, even on an
 * unchanged approved head. Nothing re-arms it: re-entry passes the normal gate.
 * Then the landing admission (`admitLanding`, proof.ts) reads, never produces,
 * the evidence for that reviewed candidate: the local tip must be it, Semctx is
 * decided from the candidate's committed tree and the checkouts' `.semctx`, and
 * applicable Semctx/assertledger records conserved on the PR are bound to the
 * re-derived inputs. A refusal returns `proof-blocked` with `producer`, `reason`
 * and `error` through the same forced-unarmed exit. A landing mandate is required
 * before that admission and before every arming write. Missing, fix-only, paused,
 * abandoned, stale, unsupported, unconfirmed, unknown, ambiguous, or incomplete
 * authority returns `mandate-refused` and disarms; it does not replace a sticky
 * review or CI stop. Valid authority does not bypass proof admission, head
 * freshness, or a required stop. A transport failure throws through it. Every
 * arm this call writes targets the admitted candidate: before the first arming
 * write, and before a re-pin after disabling the old arm, a refresh whose fresh
 * approval names another head admits that head the same way and arms it only on
 * admit (else `proof-blocked`, unarmed); after an arming write the refresh retains
 * the admitted head and refuses a later one (`head-moved`). `watching`
 * carries `proof`: what was admitted, so a PARTIAL lands visibly as PARTIAL.
 * `disarmed: true` is reported only when a read-back confirmed the disarm; a no-op
 * claims nothing. A disarm that cannot finish throws an error naming what stays
 * armed. Legacy native-pinning exit adapters instead return `auto-merge-failed`
 * (never for a `behind` stop): `armed: false` only when a read-back confirmed
 * the gate clear, otherwise `armed: true` and an `error` naming what stays armed.
 * A refused pin on a readable
 * stable head keeps its `auto-merge-failed` / `armed: false`: that says the pin was
 * refused, not that the gate is clear. A refused pin whose head cannot be read
 * forces the known gate clear, then throws the original read error — or, when
 * clearing cannot finish, an error naming what stays armed with that cause.
 * Every other terminal exit refreshes authorization after intervening awaits:
 * latest records first, current head last. A moved or unreadable head targets
 * clearing from the known gate, including writes that may have applied and thrown.
 * Head or label read errors force that clear and then propagate the original error.
 * A label write (`--add-label`, or merge-on-green's `--remove-label`) that throws
 * at a still-approved current head preserves the write error, never `watching`;
 * a moved or unreadable head returns `not-approved` / `head-moved` after clearing.
 * `bad-landing` forces clearing like every refusal. `watch-failed` is enforced
 * too: an already-armed gate stays only when the refreshed records and verified
 * head still authorize it.
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
 *   git?: (cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   requiredContexts?: string[],
 *   landing?: { mode: string, required_checks: string[] },
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export async function landPr(
  cwd,
  pr,
  {
    gh: ghFn = gh,
    git: gitFn = gitResult,
    requiredContexts,
    landing,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let records
  let gate
  /** The candidate the proof admission admitted; every later arm is bound to it. */
  let admitted
  /** What the admission read for it, reported with the watch. */
  let proof
  let landingBase
  let landingContext
  /** Set only when the epilogue refresh catch runs — including throw undefined. */
  let epilogueRefreshFailed = false
  const armedByUs = { auto: false, label: false }
  const knownGate = () =>
    gate && {
      ...gate,
      labels:
        armedByUs.label && !gate.labels.some((label) => label?.name === 'reviewed')
          ? [...gate.labels, { name: 'reviewed' }]
          : gate.labels,
      autoMergeRequest: armedByUs.auto ? (gate.autoMergeRequest ?? { pinned: true }) : gate.autoMergeRequest,
    }
  // Operations describe their exit; only the epilogue enforces it. Cleanup errors
  // never re-enter the operation catch, so a failed disarm is attempted only once.
  const exit = (result, options = {}) => ({ result, policy: 'allow-approved', refresh: true, ...options })
  const refused = (reason) => ({
    status: 'not-approved',
    reviews: records.reviews,
    ...(reason && { reason }),
  })
  const moved = async (adapter) => {
    let seen
    try {
      seen = await readGate(cwd, pr, ghFn)
    } catch {
      seen = knownGate()
    }
    return exit(refused('head-moved'), { policy: 'unarmed', gate: seen, adapter })
  }
  // Observing behind stops further arming (#696). The epilogue — the one disarm
  // owner — clears known OPEN arms, including this call's earlier pin. `adapter`
  // stays unset so a failed clear throws and names what stays armed.
  const behindExit = (seen) => exit({ status: 'behind', error: behindMessage(pr) }, { policy: 'unarmed', gate: seen })
  // A fresh read before every arming write — the opening snapshot is stale by
  // then. Only a behind answer reads the gate again, to clear what it shows; a
  // moved head is reported as moved, never as behind, and a PR that is no longer
  // OPEN and behind keeps its existing flow.
  const behindBeforeArm = async () => {
    if (!isBehind(await readPrFields(cwd, pr, ghFn, 'state,mergeStateStatus'))) return null
    let fresh
    try {
      fresh = await readGate(cwd, pr, ghFn)
    } catch {
      // An unreadable gate still clears what the call knows it armed.
    }
    if (fresh === undefined) return behindExit(knownGate())
    if (!isBehind(fresh)) return null
    if (!isCommitSha(fresh.headRefOid) || fresh.headRefOid !== records.head) {
      return exit(refused('head-moved'), { policy: 'unarmed', gate: fresh })
    }
    return behindExit(fresh)
  }
  // Behind first (it reads the gate), the head last: the head the write binds to
  // stays the last observation.
  const checkBeforeArm = async () => (await behindBeforeArm()) ?? checkCoordinates()
  const baseBlocked = (reason, error) =>
    exit({ status: 'proof-blocked', producer: 'candidate', reason, error }, { policy: 'unarmed' })
  // A clean PR merges as soon as it is armed (`gh pr merge --auto` merges it at
  // once; native auto-merge within seconds), moving its own base. Merged onto
  // the selected tip — the merge commit's first parent — the base was not lost.
  // Merge-commit strategy only (`gh pr merge --merge` / equivalent --no-ff):
  // first parent is the selected base tip, second is the PR head. Squash/rebase
  // have no usable ^2 and fail closed for authorization proofs.
  const mergeParents = async () => {
    const data = await readPrFields(cwd, pr, ghFn, 'state,mergeCommit')
    const oid = data.mergeCommit?.oid
    if (data.state !== 'MERGED' || !isCommitSha(oid)) return null
    const first = await gitFn(cwd, ['rev-parse', '--verify', `${oid}^1`])
    if (first.code !== 0 || !isCommitSha(first.stdout.trim())) return null
    const second = await gitFn(cwd, ['rev-parse', '--verify', `${oid}^2`])
    return {
      tip: first.stdout.trim(),
      head: second.code === 0 && isCommitSha(second.stdout.trim()) ? second.stdout.trim() : null,
    }
  }
  /** Selected base tip survived in the merge commit (^1). Not proof of the admitted head. */
  const mergedOnto = async (tip) => {
    const parents = await mergeParents()
    return parents !== null && parents.tip === tip
  }
  /** Authorized land: selected base (^1) and admitted candidate (^2). */
  const mergedAuthorized = async (tip, candidate) => {
    if (!isCommitSha(tip) || !isCommitSha(candidate)) return false
    const parents = await mergeParents()
    return parents !== null && parents.tip === tip && parents.head === candidate
  }
  const bindBase = async (current) => {
    if (current.refusal) {
      return baseBlocked(current.refusal.reason, `PR base ${JSON.stringify(current.name)}: ${current.refusal.error}`)
    }
    if (!landingContext || (current.name === landingContext.name && current.tip === landingContext.tip)) return null
    if (current.name === landingContext.name && (await mergedOnto(landingContext.tip))) return null
    return baseBlocked(
      'unbound',
      `PR base ${current.name}@${current.tip} conflicts with captured ${landingContext.name}@${landingContext.tip}; re-enter landing with the current base`,
    )
  }
  const readCoordinates = async () => {
    const base = await resolveLandingBase(cwd, pr, ghFn, gitFn)
    // URL resolution adds awaits: the PR coordinates remain the last observation.
    const data = await readPrFields(cwd, pr, ghFn, 'headRefOid,baseRefName')
    if (data.baseRefName !== base.name)
      return {
        head: data.headRefOid,
        base: {
          name: data.baseRefName,
          refusal: {
            reason: 'unbound',
            error: 'the PR base changed during its repository-bound fetch; re-enter with the current base',
          },
        },
      }
    return { head: data.headRefOid, base }
  }
  const checkCoordinates = async (adapter) => {
    const current = await readCoordinates()
    const blocked = await bindBase(current.base)
    if (blocked) return blocked
    return !isCommitSha(current.head) || current.head !== records.head ? moved(adapter) : null
  }
  const refuseIfMoved = async () => {
    let readError
    try {
      return await checkCoordinates()
    } catch (error) {
      readError = error
    }
    return exit(refused('head-moved'), { policy: 'unarmed', readError })
  }
  /**
   * The landing admission (#768) of `records.head`: reads conserved producer
   * evidence for exactly that candidate, never runs a producer, a test or a
   * reviewer; the approving record's time bounds which PR body that review
   * judged. On admit every later arm is rebound to it; a refusal is the
   * forced-unarmed `proof-blocked` exit.
   */
  const admit = async () => {
    let current
    try {
      current = await resolveLandingBase(cwd, pr, ghFn, gitFn)
    } catch (error) {
      return baseBlocked('unreadable', `PR base cannot be read: ${errorText(error)}`)
    }
    const changed = await bindBase(current)
    if (changed) return changed
    const mandate = await currentLandingMandate(
      cwd,
      pr,
      ghFn,
      {
        head: records.head,
        base: landingBase,
        baseTip: landingContext.tip,
      },
      gitFn,
    )
    if (!mandate.admitted) {
      return exit(
        { status: 'mandate-refused', reason: mandate.reason, error: evidenceText(mandate.evidence) },
        { policy: 'unarmed' },
      )
    }
    const admission = await admitLanding(
      cwd,
      {
        pr: Number(pr),
        candidate: records.head,
        base: landingBase,
        baseTip: landingContext.tip,
        reviewedAt: records.at,
        reviewInput: records.input,
        proofPins: mandate.proofPins,
      },
      { gh: ghFn, git: gitFn },
    )
    if (!admission.ok) {
      const { producer, reason, error } = admission
      return exit({ status: 'proof-blocked', producer, reason, error }, { policy: 'unarmed' })
    }
    admitted = records.head
    proof = admission.proof
    return null
  }
  const afterWrite = async (adapter) => {
    try {
      // Always re-run authorization after an arming write. A merge onto the frozen
      // selected tip is not permission to skip mandate/semantic/proof checks.
      if (adapter === 'native') {
        // The pin is already written for the admitted head: retain it, never re-admit a later one.
        const refusal = await refreshReviewAuthorization(true)
        if (refusal) return { ...refusal, adapter }
      }
      return await checkCoordinates(adapter)
    } catch (failure) {
      return exit(undefined, { policy: 'unarmed', failure, adapter })
    }
  }
  const refreshReviewAuthorization = async (retaining = false) => {
    // Every pre-arm checkpoint reads records first, then the caller reads the
    // head last. Preparation awaits must not retain same-head authorization.
    records = await requiredReviewRecords(cwd, pr, { gh: ghFn })
    if (reviewBoundStopped(records)) return exit(refused('review-bound'), { policy: 'unarmed' })
    if (!approves(records.verdict)) return exit(refused(), { policy: 'unarmed' })
    if (!isCommitSha(records.head)) return exit(refused('review-unbound'), { policy: 'unarmed' })
    // Retention cannot transfer an arm already written for H to a later H2.
    if (retaining && admitted !== undefined && records.head !== admitted) {
      return exit(refused('head-moved'), { policy: 'unarmed' })
    }
    // Body, ignored configuration, classification and native records can change
    // without a push. A head is a binding, never a cache key for authorization.
    return admit()
  }
  // A refused pin: a moved head is cleared via `moved`, a readable stable head is
  // the native refusal, and an unreadable head forces the known gate clear and
  // then propagates the original read failure through the epilogue.
  const pinRefused = async () => {
    try {
      const refusal = await checkCoordinates()
      if (refusal) return refusal
    } catch (failure) {
      return exit(undefined, { policy: 'unarmed', failure })
    }
    return exit({ status: 'auto-merge-failed', armed: false })
  }
  const labelWrite = async (args, arm) => {
    // A write may apply and then throw; retain its possible arm until a fresh
    // gate/read-back proves otherwise.
    if (arm) armedByUs.label = true
    try {
      await ghFn(cwd, args)
    } catch (failure) {
      const refusal = await refuseIfMoved()
      return refusal ?? exit(undefined, { failure })
    }
    return null
  }
  let terminal
  try {
    terminal = await (async () => {
      pr = await resolveReviewPr(cwd, pr, { gh: ghFn })
      if (pr === null) return exit({ status: 'no-pr' }, { refresh: false })
      // Acquire the native gate first: a strict-history refusal still must clear
      // any physical arm that this read confirms.
      gate = await readGate(cwd, pr, ghFn)
      records = await requiredReviewRecords(cwd, pr, { gh: ghFn })
      if (reviewBoundStopped(records)) return exit(refused('review-bound'), { policy: 'unarmed' })
      if (!approves(records.verdict)) return exit(refused(), { policy: 'unarmed' })
      if (!isCommitSha(records.head)) return exit(refused('review-unbound'), { policy: 'unarmed' })
      if (!isCommitSha(gate.headRefOid) || gate.headRefOid !== records.head) {
        return exit(refused('head-moved'), { policy: 'unarmed' })
      }
      // The opening snapshot, after the review-bound, approval and head guards.
      if (isBehind(gate)) return behindExit(gate)
      try {
        const selected = await resolveLandingBase(cwd, pr, ghFn, gitFn)
        const blocked = await bindBase(selected)
        if (blocked) return blocked
        landingContext = selected
        landingBase = selected.name
      } catch (error) {
        return baseBlocked('unreadable', `PR base cannot be read: ${errorText(error)}`)
      }
      let resolved = landing
      if (!resolved) {
        try {
          resolved = readLandingAt(cwd, landingContext.tip)
        } catch (error) {
          return exit({ status: 'bad-landing', error: errorText(error) }, { policy: 'unarmed' })
        }
      }
      if (resolved.mode === 'native') {
        const required =
          requiredContexts !== undefined
            ? [...requiredContexts]
            : resolved.required_checks.length
              ? resolved.required_checks
              : await resolveRequiredContexts(cwd, landingBase, ghFn)
        if (required.length === 0) return exit({ status: 'no-required-checks' }, { policy: 'unarmed' })
      }
      const blocked = await admit()
      if (blocked) return blocked
      let since = ''
      if (resolved.mode === 'merge-on-green') {
        const before = await labeledReviewedAt(cwd, pr, ghFn)
        const labels = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'labels'])).labels ?? []
        if (!Array.isArray(labels)) throw new Error(`landPr: gh pr view ${pr} carried no labels`)
        const beforeLabel = await refreshReviewAuthorization()
        if (beforeLabel) return beforeLabel
        const beforeLabelHead = await checkBeforeArm()
        if (beforeLabelHead) return beforeLabelHead
        if (labels.some((label) => label?.name === 'reviewed')) {
          // Preparation for a fresh labeled event, not a terminal disarm.
          const removed = await labelWrite(['pr', 'edit', String(pr), '--remove-label', 'reviewed'], false)
          if (removed) return removed
          const afterRemove = await refreshReviewAuthorization()
          if (afterRemove) return afterRemove
          const afterRemoveHead = await checkBeforeArm()
          if (afterRemoveHead) return afterRemoveHead
        }
        const added = await labelWrite(['pr', 'edit', String(pr), '--add-label', 'reviewed'], true)
        if (added) return added
        const afterLabel = await afterWrite()
        if (afterLabel) return afterLabel
        since = await waitLabeledSince(cwd, pr, ghFn, before, sleep)
        const afterWait = await refuseIfMoved()
        if (afterWait) return afterWait
        if (!since) {
          return exit({
            status: 'watch-failed',
            error:
              'could not read the labeled reviewed event after re-label — merge-on-green needs --since from GitHub',
          })
        }
      } else {
        const beforePin = await refreshReviewAuthorization()
        if (beforePin) return beforePin
        const beforePinHead = await checkBeforeArm()
        if (beforePinHead) return beforePinHead
        const pin = ['pr', 'merge', String(pr), '--auto', '--merge', '--match-head-commit', records.head]
        armedByUs.auto = true
        try {
          await ghFn(cwd, pin)
        } catch (error) {
          if (!/already enabled/i.test(errorText(error))) return pinRefused()
          // Re-pin preparation. Its failure is described here, but any terminal
          // clearing of either arm is still owned by the epilogue.
          try {
            await ghFn(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
          } catch (disableError) {
            let gone = true
            let readError
            try {
              const current = await readCoordinates()
              const blocked = await bindBase(current.base)
              if (blocked) return blocked
              gone = !isCommitSha(current.head) || current.head !== records.head
            } catch (error) {
              readError = error
            }
            if (gone) {
              return exit(undefined, { policy: 'unarmed', adapter: 'disable', disableError, readError })
            }
            const known = knownGate()
            const names = []
            if (known.autoMergeRequest) names.push('auto-merge')
            if (known.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
            return exit({
              status: 'auto-merge-failed',
              armed: true,
              error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(disableError)})`,
            })
          }
          const beforeRepin = await refreshReviewAuthorization()
          if (beforeRepin) return beforeRepin
          const beforeRepinHead = await checkBeforeArm()
          if (beforeRepinHead) return beforeRepinHead
          pin[pin.length - 1] = records.head
          try {
            await ghFn(cwd, pin)
          } catch {
            return pinRefused()
          }
        }
        const afterPin = await afterWrite('native')
        if (afterPin) return afterPin
        // Auto-merge may settle while authorization is refreshed; a merged PR
        // has no remaining label write to perform.
        const state = await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state'])
        if (state.trim() === 'MERGED') return exit({ status: 'merged' })
        // The label is an arming write too: the pin above is cleared with it.
        const behindBeforeLabel = await checkBeforeArm()
        if (behindBeforeLabel) return behindBeforeLabel
        const added = await labelWrite(['pr', 'edit', String(pr), '--add-label', 'reviewed'], true)
        if (added) return added
        const afterAdd = await refuseIfMoved()
        if (afterAdd) return afterAdd
      }
      const sinceArg = since ? ` --since ${since}` : ''
      return exit({
        status: 'watching',
        mode: resolved.mode,
        watch: `bash ${shellQuote(ciWatchSh())} ${shellQuote(String(pr))} --merge-mode ${resolved.mode} --base ${shellQuote(landingBase)}${sinceArg}`,
        proof,
      })
    })()
  } catch (failure) {
    terminal = exit(undefined, { policy: 'unarmed', failure })
  }
  let seen = terminal.gate ?? knownGate()
  // Never synthesize native head/state. Observational MERGED comes only from the
  // gate/read path. Authorized merge (^1 frozen tip, ^2 admitted) is proven by
  // mergedAuthorized for disarm preservation — not by inventing gate fields.
  // Do not use failure===undefined alone: throw undefined / Promise.reject() leave
  // failure unset indistinguishable from no catch.
  if (seen?.state === 'OPEN' && terminal.policy !== 'unarmed' && terminal.refresh) {
    try {
      // Intervening awaits can change both the latest record and the head. Read
      // records first and the head last; an old snapshot is only a clearing target.
      // Admit still uses frozen landingContext.tip — never a moved live tip.
      const refusal = await refreshReviewAuthorization(true)
      const current = await readCoordinates()
      seen = { ...seen, headRefOid: current.head }
      const authorization = refusal ?? (await bindBase(current.base))
      if (authorization) {
        terminal.policy = 'unarmed'
        if (!terminal.failure) terminal.result = authorization.result
      }
      if (!mayStayArmed(records, seen, false) || (admitted !== undefined && seen.headRefOid !== admitted)) {
        terminal.policy = 'unarmed'
        if (!terminal.failure && terminal.result?.status === 'watching') {
          terminal.result = refused('head-moved')
        }
      }
      if (terminal.result?.status === 'watching') terminal.result.proof = proof
    } catch (failure) {
      terminal.policy = 'unarmed'
      epilogueRefreshFailed = true
      // Preserve a concrete diagnostic; normalize throw undefined / reject().
      if (terminal.failure === undefined) {
        terminal.failure = failure !== undefined ? failure : new Error('epilogue refresh failed without an error value')
      }
    }
  } else if (
    epilogueRefreshFailed === false &&
    terminal.readError === undefined &&
    terminal.result?.status === 'watching' &&
    admitted !== undefined &&
    landingContext !== undefined &&
    (await mergedAuthorized(landingContext.tip, admitted))
  ) {
    // Observational gate already non-OPEN (typically MERGED). Keep real headRefOid;
    // only attach admitted proof to the watching terminal.
    if (proof !== undefined) terminal.result = { ...terminal.result, proof }
  }
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, pr, {
      records,
      gate: seen,
      policy: terminal.policy,
      gh: ghFn,
    })
  } catch (disarmError) {
    // Behind clearing race: observational merge only (existing policy).
    // Watching is preserved only for an explicit settled outcome: prior watching,
    // epilogue refresh did not fail (discriminant — not failure===undefined),
    // no unreadable readError, admitted candidate, and merge ^1/^2 proof.
    // Never invent watching; never claim merged without admission.
    if (/merged while being disarmed/.test(errorText(disarmError))) {
      if (terminal.result?.status === 'behind') return { status: 'merged' }
      if (
        epilogueRefreshFailed === false &&
        terminal.readError === undefined &&
        terminal.result?.status === 'watching' &&
        admitted !== undefined &&
        landingContext !== undefined &&
        (await mergedAuthorized(landingContext.tip, admitted))
      ) {
        return { ...terminal.result, ...(proof !== undefined && { proof }) }
      }
    }
    const error = stuckError(disarmError, terminal.failure ?? terminal.readError)
    if (terminal.adapter) return { status: 'auto-merge-failed', armed: true, error: error.message }
    throw error
  }
  if (terminal.failure) throw terminal.failure
  if (terminal.adapter === 'disable') {
    if (receipt.disarmed) {
      return {
        status: 'auto-merge-failed',
        armed: false,
        error: terminal.readError
          ? `head unreadable after --disable-auto failed; the gate was disarmed — ${errorText(terminal.readError)}`
          : 'head moved after --disable-auto failed; the gate was disarmed',
      }
    }
    // A non-OPEN snapshot caused no writes. Preserve the native adapter's
    // historical report of the stored arms, without inventing a disarm receipt.
    try {
      const back = await readGate(cwd, pr, ghFn)
      const names = []
      if (back.autoMergeRequest) names.push('auto-merge')
      if (back.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
      if (names.length) {
        return {
          status: 'auto-merge-failed',
          armed: true,
          error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(terminal.disableError)})`,
        }
      }
      const head = terminal.readError
        ? `the head could not be read — ${errorText(terminal.readError)}`
        : 'the head moved'
      return {
        status: 'auto-merge-failed',
        armed: false,
        error: `PR ${pr} is ${back.state} with nothing armed after --disable-auto failed; ${head}`,
      }
    } catch (error) {
      return {
        status: 'auto-merge-failed',
        armed: true,
        error: `PR ${pr} could not be read back; auto-merge and reviewed may stay armed — ${errorText(error)}`,
      }
    }
  }
  return { ...terminal.result, ...(receipt.disarmed && { disarmed: true }) }
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

/**
 * Preserve `/ci-watch` statuses while enforcing every exit. A red exit first
 * persists a freshly derived required stop when applicable; codes 1–3 and 7
 * then force unarmed. Other codes retain an OPEN arm only after fresh records
 * and proof admission authorize its verified current head.
 */
export async function applyCiWatchExit(cwd, pr, code, { gh: ghFn = gh, git: gitFn } = {}) {
  let gate
  let records
  let failure
  let policy = code === 1 || code === 2 || code === 3 || code === 7 ? 'unarmed' : 'allow-approved'
  let result =
    code === 0 || code === 4
      ? { status: 'stopped' }
      : code === 1
        ? { status: 'ci-failed' }
        : code === 2
          ? { status: 'ci-cancelled' }
          : code === 3
            ? { status: 'ci-blocked' }
            : code === 5
              ? { status: 'timeout' }
              : code === 6
                ? { status: 'evaluate-only' }
                : code === 7
                  ? { status: 'behind', error: behindMessage(pr) }
                  : { status: 'watch-failed', code }
  try {
    gate = await readGate(cwd, pr, ghFn)
    if (code === 7 || (code >= 0 && code <= 3)) {
      if (gate.state === 'MERGED') result = { status: 'merged' }
      else if (gate.state === 'CLOSED') result = { status: 'stopped' }
    }
    const continuation = result.status === 'timeout' || result.status === 'evaluate-only'
    const retaining =
      policy !== 'unarmed' &&
      gate.state === 'OPEN' &&
      (gate.autoMergeRequest || gate.labels.some((label) => label?.name === 'reviewed'))
    if (continuation || retaining) {
      records ??= await requiredReviewRecords(cwd, pr, { gh: ghFn })
      const head = await readHeadRefOid(cwd, pr, ghFn)
      gate = { ...gate, headRefOid: head }
      const base = await resolveLandingBase(cwd, pr, ghFn, gitFn)
      if (base.refusal || !isCommitSha(head)) {
        policy = 'unarmed'
        if (continuation) {
          result = {
            status: 'mandate-refused',
            reason: 'incomplete',
            error: 'current landing coordinates are incomplete',
          }
        }
      } else {
        const mandate = await currentLandingMandate(
          cwd,
          pr,
          ghFn,
          {
            head,
            base: base.name,
            baseTip: base.tip,
          },
          gitFn ?? gitResult,
        )
        if (!mandate.admitted) {
          policy = 'unarmed'
          if (continuation && result.status !== 'ci-failed') {
            result = {
              status: 'mandate-refused',
              reason: mandate.reason,
              error: evidenceText(mandate.evidence),
            }
          }
        } else if (
          retaining &&
          !reviewBoundStopped(records) &&
          approves(records.verdict) &&
          isCommitSha(records.head)
        ) {
          const proofFresh = await hasFreshReviewInput(cwd, pr, records, {
            gh: ghFn,
            git: gitFn,
            proofPins: mandate.proofPins,
          })
          const lastHead = await readHeadRefOid(cwd, pr, ghFn)
          gate = { ...gate, headRefOid: lastHead }
          if (!proofFresh || lastHead !== records.head || lastHead !== head) {
            policy = 'unarmed'
          } else {
            const lastMandate = await currentLandingMandate(
              cwd,
              pr,
              ghFn,
              {
                head: lastHead,
                base: base.name,
                baseTip: base.tip,
              },
              gitFn ?? gitResult,
            )
            const after = await readHeadRefOid(cwd, pr, ghFn)
            gate = { ...gate, headRefOid: after }
            if (!lastMandate.admitted || after !== lastHead) policy = 'unarmed'
          }
        }
      }
    }
  } catch (error) {
    failure = error
    policy = 'unarmed'
  }

  if (!failure && code === 1 && result.status === 'ci-failed' && gate?.state === 'OPEN') {
    try {
      await persistObservedCiStop(cwd, pr, { gh: ghFn, git: gitFn })
    } catch (error) {
      // Stop uncertainty never keeps an arm or permits the ordinary CI path.
      failure = error
    }
  }
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, pr, { records, gate, policy, gh: ghFn })
  } catch (disarmError) {
    // Preserve a merge that wins the clearing race as the merged result.
    // No reread or second cleanup can turn an unconfirmed disarm into a receipt.
    if (/merged while being disarmed/.test(errorText(disarmError))) return { status: 'merged' }
    throw failure ? stuckError(disarmError, failure) : disarmError
  }
  if (failure) throw failure
  return { ...result, ...(receipt.disarmed && { disarmed: true }) }
}

/**
 * Named non-Epic meaning of one `landPr` or `applyCiWatchExit` status.
 * Epic callers keep `landOutcome`. This does not admit a landing, re-derive the
 * review bound, or read proof policy from a graph. An unknown status fails closed.
 *
 * @param {{
 *   status?: unknown,
 *   reason?: unknown,
 *   producer?: unknown,
 *   error?: unknown,
 *   code?: unknown,
 *   armed?: unknown,
 *   watch?: unknown,
 * }} land
 */
export function featureLandOutcome(land) {
  const status = typeof land?.status === 'string' ? land.status : ''
  switch (status) {
    case 'watching':
      return typeof land.watch === 'string' && land.watch !== ''
        ? { action: /** @type {'start-watch'} */ ('start-watch'), claimMerged: false, reportProof: true }
        : blocked(status, 'watch-missing')
    case 'timeout':
      return { action: /** @type {'reattach-watch'} */ ('reattach-watch'), claimMerged: false }
    case 'ci-failed':
      return {
        action: /** @type {'next-review-step'} */ ('next-review-step'),
        ciFailed: true,
        claimMerged: false,
      }
    case 'not-approved':
      if (land.reason === 'review-bound') {
        return stop('review-bound', 'none', { reviewAgain: false })
      }
      if (land.reason === 'head-moved') {
        return {
          action: /** @type {'next-review-step'} */ ('next-review-step'),
          ciFailed: false,
          claimMerged: false,
          reason: 'head-moved',
        }
      }
      if (land.reason === 'review-unbound') {
        return stop('review-unbound', 'review-when-head-readable', { reviewAgain: false })
      }
      return {
        action: /** @type {'review-if-unspent'} */ ('review-if-unspent'),
        claimMerged: false,
        reason: typeof land.reason === 'string' ? land.reason : 'not-approved',
      }
    case 'merged':
      return { action: /** @type {'report-merged'} */ ('report-merged'), claimMerged: true, offerTail: true }
    case 'proof-blocked': {
      const reenter = proofBlockedReentry(land)
      return stop('proof-blocked', reenter, {
        bound: 'sticky',
        producer: land.producer ?? null,
        proofReason: land.reason ?? null,
        ...(reenter === 'same-head-review' ? { producerAtAdmission: false } : {}),
      })
    }
    case 'ci-cancelled':
      return stop('ci-cancelled', 'rerun-ci-then-land')
    case 'ci-blocked':
      return stop('ci-blocked', 'resolve-checks-then-land')
    case 'behind':
      return stop('behind', 'update-branch-then-land', { startWatch: false, updateBranchFromCycle: false })
    case 'watch-failed':
      return stop('watch-failed', 'none', { retainArm: 'current-authorization-only' })
    case 'evaluate-only':
      return stop('evaluate-only', 'manual-merge', {
        wait: false,
        report: 'evaluate-only — manual merge required',
        doc: 'docs/kit/ci-app-setup.md',
        retainArm: 'current-authorization-only',
      })
    case 'bad-landing':
      return stop('bad-landing', 'fix-landing-config-then-land')
    case 'no-required-checks':
      return stop('no-required-checks', 'resolve-check-enforcement-then-land')
    case 'stopped':
      return stop('stopped', 'none')
    case 'closed':
      return stop('closed', 'none')
    case 'auto-merge-failed':
      return stop('auto-merge-failed', land.armed === true ? 'clear-remainder-by-hand' : 'none', {
        armed: land.armed === true,
      })
    case 'no-pr':
      return stop('no-pr', 'none')
    case 'mandate-refused':
      return stop('mandate-refused', 'none', {
        reviewAgain: false,
        mandateReason: typeof land.reason === 'string' ? land.reason : 'unknown-binding',
      })
    default:
      return blocked(status, 'unknown-land-status')
  }
}

/** @param {string} reason @param {string} reenter @param {Record<string, unknown>} [extra] */
function stop(reason, reenter, extra) {
  return {
    action: /** @type {'stop'} */ ('stop'),
    claimMerged: false,
    reason,
    reenter,
    ...extra,
  }
}

/** @param {string} status @param {'unknown-land-status' | 'watch-missing'} reason */
function blocked(status, reason) {
  return { action: /** @type {'blocked'} */ ('blocked'), claimMerged: false, reason, status }
}

/**
 * Proof-blocked re-entry from the named cause. Unmatched text does not acquire
 * or review; the bound stays sticky either way. A moved PR head is `not-approved`.
 *
 * @param {{ error?: unknown }} land
 */
function proofBlockedReentry(land) {
  const error = typeof land.error === 'string' ? land.error : ''
  if (error.includes('Produce it outside admission')) return 'acquire'
  if (error.includes('was revised after publication')) return 'acquire-then-review'
  if (
    error.includes('not before approving review') ||
    error.includes('without a producer') ||
    error.includes('body that justifies') ||
    error.includes('has no review-input binding') ||
    error.includes('review-input binding is malformed') ||
    error.includes('is not the exact input that was reviewed') ||
    error.includes('applicability changed after review') ||
    error.includes('re-review the head')
  ) {
    return 'same-head-review'
  }
  if (
    error.includes('obtain readable GitHub metadata') ||
    error.includes('no readable native comment identity') ||
    error.includes('unreadable native creation/revision facts')
  ) {
    return 'obtain-native-metadata'
  }
  return 'after-named-cause'
}

/**
 * Clear both arms and confirm the barrier before invoking a push. No review
 * service is needed: a push invalidates the reviewed head regardless of verdict.
 * Reuse the barrier receipt after the callback, including when it throws.
 */
export async function disarmReviewedBeforePush(cwd, pr, { gh: ghFn = gh, push } = {}) {
  let gate
  let failure
  try {
    gate = await readGate(cwd, pr, ghFn)
  } catch (error) {
    failure = error
  }
  const receipt = await enforceArmedGate(cwd, pr, { gate, policy: 'unarmed', gh: ghFn })
  if (failure) throw failure
  if (push) await push()
  if (receipt.disarmed) return { disarmed: true }
  if (gate.state === 'MERGED') return { merged: true }
  if (gate.state === 'CLOSED') return { closed: true }
  return { unarmed: true }
}

/** ADR-020 §3 / #488 / #710: at most two automated corrections per PR. */
export const MAX_FIX_ROUNDS = 2

/** @param {unknown} value */
function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

/** Read selected native PR fields; a non-JSON response authorizes nothing. */
async function readPrFields(cwd, pr, ghFn, fields) {
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', fields])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  return data
}

async function readHeadRefOid(cwd, pr, ghFn) {
  return (await readPrFields(cwd, pr, ghFn, 'headRefOid')).headRefOid
}

const GATE_STATES = new Set(['OPEN', 'CLOSED', 'MERGED'])

/** Read the native head/state/arm fields on which the physical gate relies. */
async function readGate(cwd, pr, ghFn) {
  const raw = await ghFn(cwd, [
    'pr',
    'view',
    String(pr),
    '--json',
    'headRefOid,state,labels,autoMergeRequest,mergeStateStatus',
  ])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`readGate: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.labels)) {
    throw new Error(`readGate: gh pr view ${pr} carried no labels — ${preview(raw)}`)
  }
  if (!data.labels.every((label) => typeof label?.name === 'string')) {
    throw new Error(`readGate: gh pr view ${pr} carried unreadable labels — ${preview(raw)}`)
  }
  if (!GATE_STATES.has(data.state)) {
    throw new Error(`readGate: gh pr view ${pr} state is ${JSON.stringify(data.state) ?? 'missing'} — ${preview(raw)}`)
  }
  if (!('autoMergeRequest' in data) || (data.autoMergeRequest !== null && typeof data.autoMergeRequest !== 'object')) {
    throw new Error(`readGate: gh pr view ${pr} carried no auto-merge state — ${preview(raw)}`)
  }
  return data
}

function isBehind(gate) {
  return gate?.state === 'OPEN' && gate.mergeStateStatus === 'BEHIND'
}

function behindMessage(pr) {
  return `PR ${pr} is behind its base; landing stopped, with no further arming and known OPEN arms cleared; run: gh pr update-branch ${pr} — then land again`
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

const stuckError = (disarmError, readError) =>
  readError === undefined
    ? new Error(errorText(disarmError), { cause: disarmError })
    : new Error(`${errorText(disarmError)} — after: ${errorText(readError)}`, { cause: readError })

/** Clear both native arms, then prove their removal with one native read-back. */
async function disarmGate(cwd, pr, gate, ghFn) {
  if (gate.state !== 'OPEN') return false
  const labelled = gate.labels.some((label) => label?.name === 'reviewed')
  const autoOn = Boolean(gate.autoMergeRequest)
  if (!labelled && !autoOn) return false
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
  const stays = []
  if (back.autoMergeRequest) stays.push('auto-merge')
  if (back.labels.some((label) => label?.name === 'reviewed')) stays.push('the reviewed label')
  if (stays.length) throw new Error(`disarmGate: PR ${pr} stays armed — ${stays.join(' and ')}${detail}`)
  return true
}

/** @param {string | null} verdict */
function approves(verdict) {
  return verdict?.startsWith('Approve') === true
}

/** The authoritative taxonomy stays in dev-review; Feature only loads that source. */
let cachedTaxonomy
function reviewTaxonomy() {
  if (cachedTaxonomy !== undefined) return cachedTaxonomy
  const source = readFileSync(fileURLToPath(new URL('../dev-review/review-classes.yml', import.meta.url)), 'utf8')
  const taxonomy = [...source.matchAll(/^\s*-\s+class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (taxonomy.length === 0) throw new Error('reviewRecords: canonical review taxonomy is unreadable')
  cachedTaxonomy = taxonomy
  return taxonomy
}

/** @param {unknown} refusal */
function reviewRefusal(refusal) {
  const diagnostics = Array.isArray(refusal?.diagnostics) ? refusal.diagnostics : []
  const error = new Error(
    `review records refused: ${diagnostics.map((entry) => entry?.message ?? entry?.code ?? String(entry)).join('; ') || 'unknown record failure'}`,
  )
  Object.assign(error, { reviewRecords: refusal })
  return error
}

/** @param {(cwd: string, args: string[]) => Promise<string>} ghFn @param {string} cwd */
async function repositoryScope(cwd, pr, ghFn) {
  const raw = await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`readReviewRecords: repository for PR ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data?.nameWithOwner !== 'string' || !/^[^/]+\/[^/]+$/.test(data.nameWithOwner)) {
    throw new Error(`readReviewRecords: repository for PR ${pr} is unreadable`)
  }
  const number = Number(pr)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new TypeError(`readReviewRecords: invalid PR ${JSON.stringify(pr)}`)
  return githubScope(data.nameWithOwner, number)
}

/**
 * Summarize decoded canonical records. Refusals deliberately remain Result
 * failures: a partial, unknown, conflicting or legacy review can never become
 * an empty/green history.
 */
export function reviewRecords(history, { taxonomy = reviewTaxonomy(), acceptedEvidencePolicyRef = null } = {}) {
  return summarizeReviews(history, taxonomy, acceptedEvidencePolicyRef)
}

/** One strict common history serves both read authorization and stop publication. */
async function readReviewHistory(cwd, pr, ghFn) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  return decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh: ghFn })))
}

/** Strict common-adapter reader for all review authorization. */
export async function readReviewRecords(cwd, pr, { gh: ghFn = gh, taxonomy, acceptedEvidencePolicyRef = null } = {}) {
  const history = await readReviewHistory(cwd, pr, ghFn)
  return reviewRecords(history, { ...(taxonomy === undefined ? {} : { taxonomy }), acceptedEvidencePolicyRef })
}

/** The workflow needs a summary to authorize a gate; a Result failure authorizes nothing. */
async function requiredReviewRecords(cwd, pr, options) {
  const result = await readReviewRecords(cwd, pr, options)
  if (!result.ok) throw reviewRefusal(result)
  return result.value
}

const MANDATE_REASONS = new Set([
  'missing',
  'fix-only',
  'paused',
  'abandoned',
  'stale',
  'unsupported',
  'unconfirmed',
  'foreign',
  'ambiguous',
  'revoked',
  'material-spec',
  'config-drift',
  'proof-pin-drift',
  'unbound',
  'conflict',
  'incomplete',
  'unknown-binding',
  'incompatible',
  'unsafe',
  'materially-changed',
])

/** @param {unknown} reason */
function mandateReason(reason) {
  return typeof reason === 'string' && MANDATE_REASONS.has(reason) ? reason : 'unknown-binding'
}

/** @param {unknown} evidence */
function evidenceText(evidence) {
  if (typeof evidence === 'string' && evidence !== '') return evidence
  if (evidence === undefined || evidence === null) return 'landing mandate refused'
  try {
    return JSON.stringify(evidence)
  } catch {
    return 'landing mandate refused'
  }
}

/**
 * Confirm the PR workflow-binding after selection, before review or landing.
 * A missing publisher throws. Closes text, body, and branch name are not authority.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {{ issue?: number, branch?: string, base?: string }} [claim]
 */
async function confirmSelectedBinding(cwd, pr, ghFn, claim = {}) {
  const roxabi = await import('../../roxabi/workflow.ts')
  if (typeof roxabi.confirmWorkflowBinding !== 'function') {
    throw new Error('confirmWorkflowBinding is not exported')
  }
  const confirmed = await roxabi.confirmWorkflowBinding({
    cwd,
    pr: Number(pr),
    issue: claim.issue,
    branch: claim.branch,
    base: claim.base,
    gh: ghFn,
  })
  if (confirmed?.ok !== true || typeof confirmed.recordId !== 'string' || confirmed.recordId === '') {
    const reason = typeof confirmed?.reason === 'string' ? confirmed.reason : 'unconfirmed'
    return { ok: false, reason }
  }
  return { ok: true, recordId: confirmed.recordId }
}
function bindingRefusalReason(reason) {
  if (reason === 'absent') return 'missing'
  if (reason === 'conflicting') return 'conflict'
  if (reason === 'partial' || reason === 'unconfirmed' || reason === 'incomplete') return 'incomplete'
  return mandateReason(reason)
}

async function bundledLandingMandate() {
  const contracts = await import('../../dist/contracts.js')
  if (
    typeof contracts.requireLandingMandate !== 'function' ||
    typeof contracts.readLandingFacts !== 'function' ||
    typeof contracts.specDigest !== 'function' ||
    typeof contracts.shippedProductVersion !== 'function'
  ) {
    throw new Error('requireLandingMandate is not in the trusted contracts bundle')
  }
  return contracts
}

/**
 * The current mandate pin is the full effective configuration at the selected
 * trusted base, never the installed graph digest by itself.
 */
async function trustedLandingWorkflowConfig(gitCwd, gitFn, baseTip, productVersion) {
  const config = await import('../../roxabi/workflow-config.ts')
  if (
    typeof config.readEffectiveFixConfig !== 'function' ||
    !Array.isArray(config.SUPPORTED_CONFIG_VERSIONS) ||
    config.SUPPORTED_CONFIG_VERSIONS.length === 0
  ) {
    throw new Error('trusted workflow config reader is incomplete')
  }
  const current = await config.readEffectiveFixConfig({ cwd: gitCwd, commit: baseTip, git: gitFn })
  if (current?.ok !== true) {
    throw new Error(`trusted workflow config is ${typeof current?.reason === 'string' ? current.reason : 'unreadable'}`)
  }
  if (
    typeof current.version !== 'string' ||
    current.version === '' ||
    typeof current.digest !== 'string' ||
    current.digest === '' ||
    typeof current.effective?.productVersion !== 'string' ||
    current.effective.productVersion !== productVersion
  ) {
    throw new Error('trusted workflow config is incomplete')
  }
  return {
    configVersion: current.version,
    configDigest: current.digest,
    supportedConfigVersions: config.SUPPORTED_CONFIG_VERSIONS,
  }
}

/**
 * @param {{ specDigest: (body: string) => string }} contracts
 * @param {{ repository: string, target: string }[]} scopes
 * @param {{ scope: { repository: string, target: string }, body: string }[]} bodies
 */
function liveSpec(contracts, scopes, bodies) {
  if (!Array.isArray(scopes) || !Array.isArray(bodies) || bodies.length !== scopes.length) {
    throw new Error('landing facts issue bodies are incomplete')
  }
  if (scopes.length === 0) return { specDigest: null, specBody: null }
  if (scopes.length !== 1) throw new Error('landing facts issue bodies are ambiguous')
  const scope = scopes[0]
  const match = bodies.find(
    (entry) => entry?.scope?.repository === scope.repository && entry?.scope?.target === scope.target,
  )
  if (!match || typeof match.body !== 'string') throw new Error('linked issue body is unreadable')
  return { specDigest: contracts.specDigest(match.body), specBody: match.body }
}

/**
 * Pins are read at the observed base tip, not the PR head. The mandate compares
 * path and blob or absence only: a new sourceCommit or a different order does
 * not refuse. A changed blob is proof-pin-drift. proof.ts still checks recoverability.
 *
 * @param {string} gitCwd
 * @param {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} gitFn
 * @param {string} baseTip
 */
async function liveProofPins(gitCwd, gitFn, baseTip) {
  const top = await gitFn(gitCwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || typeof top.stdout !== 'string' || top.stdout.trim() === '') {
    throw new Error('git rev-parse --show-toplevel failed')
  }
  const config = await import('../../roxabi/workflow-config.ts')
  if (typeof config.readProofConfigPins !== 'function') throw new Error('shipped proof pin reader is missing')
  const pins = await config.readProofConfigPins(gitFn, top.stdout.trim(), baseTip)
  if (!Array.isArray(pins)) throw new Error('current proof pins are unreadable')
  return pins
}

/**
 * Complete composed records plus the caller's last native head, base, and tip.
 * A missing bundle export, refused read, or non-admitted decision never arms.
 * `localInhibit` stays null: landing has no separate inhibit file.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @param {{ head: string, base: string, baseTip: string }} native
 * @param {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} [gitFn]
 * @param {string} [gitCwd]
 */
export async function currentLandingMandate(cwd, pr, ghFn, native, gitFn = gitResult, gitCwd = cwd) {
  if (
    !isCommitSha(native?.head) ||
    typeof native?.base !== 'string' ||
    native.base === '' ||
    !isCommitSha(native?.baseTip)
  ) {
    throw new Error('current native landing coordinates are incomplete')
  }
  const contracts = await bundledLandingMandate()
  const pullRequest = await repositoryScope(cwd, pr, ghFn)
  const facts = await contracts.readLandingFacts(pullRequest, withRoxabiGitHubPolicy({ cwd, gh: ghFn }))
  if (facts?.ok !== true) {
    if (!facts || facts.reason === 'unreadable') {
      throw new Error(`landing facts ${facts?.reason ?? 'unreadable'}`)
    }
    // Absent or invalid binding never grants landing authority (T3). Review/fix
    // may still resolve absent-binding context elsewhere; it cannot arm or land here.
    return {
      admitted: false,
      reason: bindingRefusalReason(facts.reason),
      evidence: facts.diagnostics ?? facts.evidence,
    }
  }
  if (
    !facts.native?.pullRequest ||
    facts.native.pullRequest.repository !== pullRequest.repository ||
    facts.native.pullRequest.target !== pullRequest.target ||
    !Array.isArray(facts.native.linkedIssueScopes) ||
    !Array.isArray(facts.parentScopes) ||
    !Array.isArray(facts.linkedIssueBodies)
  ) {
    throw new Error('landing facts scopes are incomplete')
  }
  if (typeof facts.native.branch !== 'string' || facts.native.branch === '' || facts.native.base !== native.base) {
    throw new Error('landing facts branch is incomplete')
  }
  const productVersion = contracts.shippedProductVersion()
  if (typeof productVersion !== 'string' || productVersion === '') {
    throw new Error('shipped product version is missing')
  }
  const [config, proofPins] = await Promise.all([
    trustedLandingWorkflowConfig(gitCwd, gitFn, native.baseTip, productVersion),
    liveProofPins(gitCwd, gitFn, native.baseTip),
  ])
  const spec = liveSpec(contracts, facts.native.linkedIssueScopes, facts.linkedIssueBodies)
  const decision = contracts.requireLandingMandate({
    histories: facts.histories,
    native: {
      branch: facts.native.branch,
      base: native.base,
      pullRequest: facts.native.pullRequest,
      linkedIssueScopes: facts.native.linkedIssueScopes,
    },
    parentScopes: facts.parentScopes,
    current: {
      productVersion,
      configVersion: config.configVersion,
      configDigest: config.configDigest,
      supportedConfigVersions: config.supportedConfigVersions,
      proofPins,
      specDigest: spec.specDigest,
      specBody: spec.specBody,
    },
    localInhibit: null,
  })
  if (decision?.ok !== true || typeof decision.recordId !== 'string' || !Array.isArray(decision.proofPins)) {
    return {
      admitted: false,
      reason: mandateReason(decision?.reason),
      evidence: decision?.evidence,
    }
  }
  if (
    decision.proofPins.some(
      (pin) =>
        !pin ||
        typeof pin.path !== 'string' ||
        pin.path === '' ||
        typeof pin.sourceCommit !== 'string' ||
        !isCommitSha(pin.sourceCommit) ||
        (pin.blob !== null && (typeof pin.blob !== 'string' || !isCommitSha(pin.blob))),
    )
  ) {
    return {
      admitted: false,
      reason: 'unknown-binding',
      evidence: { error: 'landing mandate proof pins are malformed' },
    }
  }
  return { admitted: true, recordId: decision.recordId, proofPins: decision.proofPins }
}

/**
 * Re-admit a review's exact proof binding at its current candidate. Refusals
 * remain refusals: callers clear an arm or refuse publication, never rebind.
 */
async function admitCurrentReviewBinding(cwd, pr, records, ghFn, gitFn, proofPins) {
  if (!isCommitSha(records.head) || (proofPins !== undefined && !Array.isArray(proofPins))) return { ok: false }
  const base = await resolveLandingBase(cwd, pr, ghFn, gitFn ?? gitResult)
  if (base.refusal) return base.refusal
  return admitLanding(
    cwd,
    {
      pr: Number(pr),
      candidate: records.head,
      base: base.name,
      baseTip: base.tip,
      reviewedAt: records.at,
      reviewInput: records.input,
      ...(Array.isArray(proofPins) ? { proofPins } : {}),
    },
    { gh: ghFn, git: gitFn ?? gitResult },
  )
}

/**
 * Persist only a freshly derived third-green-plus-observed-red stop through the
 * common writer. The normal automation identity remains the adapter default.
 */
async function persistObservedCiStop(cwd, pr, { gh: ghFn = gh, git: gitFn } = {}) {
  const history = await readReviewHistory(cwd, pr, ghFn)
  const summary = reviewRecords(history)
  if (!summary.ok) throw reviewRefusal(summary)
  const gate = await readGate(cwd, pr, ghFn)
  if (!isCommitSha(gate.headRefOid) || summary.value.head !== gate.headRefOid || !approves(summary.value.verdict)) {
    throw new Error('required CI stop is no longer bound to a current approving review')
  }
  let proofAdmission = {
    ok: false,
    producer: 'candidate',
    reason: 'unreadable',
    error: 'proof admission could not be re-read while persisting the observed CI stop',
  }
  try {
    const base = await resolveLandingBase(cwd, pr, ghFn, gitFn)
    if (!base.refusal && isCommitSha(gate.headRefOid)) {
      const proofPins = await liveProofPins(cwd, gitFn ?? gitResult, base.tip)
      proofAdmission = await admitCurrentReviewBinding(cwd, pr, summary.value, ghFn, gitFn, proofPins)
    }
  } catch {
    // Preserve the actual unknown rather than inventing a positive admission.
  }
  const state = deriveReviewState(
    history,
    {
      ...history.source.scope,
      candidateGitSHA: gate.headRefOid,
      input: summary.value.input,
      proofAdmission,
      ci: 'red',
      acceptedEvidencePolicyRef: null,
    },
    reviewTaxonomy(),
  )
  if (!state.ok) throw reviewRefusal(state)
  if (state.requiredStop === null || state.requiredStop.reason !== 'ci-failed') return false
  const confirmed = history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'stop' &&
      operation.record.payload.reason === state.requiredStop.reason &&
      operation.record.payload.reviewId === state.requiredStop.reviewId,
  )
  if (confirmed !== undefined) return true
  const built = buildRecord({
    ...history.source.scope,
    version: 1,
    recordId: `review-stop-${state.requiredStop.reviewId}`,
    runId: 'normal-workflow',
    operationId: `review-stop-${state.requiredStop.reviewId}`,
    kind: 'stop',
    payload: state.requiredStop,
  })
  if (!built.ok) throw reviewRefusal(built)
  const published = await publishGitHubRecord(built.value, history, withRoxabiGitHubPolicy({ cwd, gh: ghFn }), null)
  if (published.status !== 'confirmed') throw reviewRefusal(published)
  return true
}

/**
 * Compatibility view for proof consumers. Pagination, identity and comment
 * metadata come exclusively from the shared GitHub adapter.
 */
export async function readComments(cwd, pr, { gh: ghFn = gh } = {}) {
  const scope = await repositoryScope(cwd, pr, ghFn)
  const history = await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh: ghFn }))
  return {
    me: history.expectedAuthor,
    comments: history.comments.map((comment) => ({
      author: { login: comment.author ?? '' },
      body: comment.body,
      ...(comment.nativeId !== null && /^\d+$/.test(comment.nativeId) && { id: Number(comment.nativeId) }),
      ...(comment.createdAt !== null && { createdAt: comment.createdAt }),
      ...(comment.updatedAt !== null && { updatedAt: comment.updatedAt }),
    })),
  }
}

const STOP_GUIDANCE =
  'Publish the escalation dossier (dev-review Phase 8). Automation on this PR remains stopped and disarmed: ' +
  'operator-supervised agent processing begins only after the operator explicitly approves revised scope, ' +
  'a diagnostic/correction plan and a continuation checkpoint. Agents carry the work to a NEW superseding PR ' +
  'for fresh independent review, proof, CI and normal landing admission; no extra review on this PR or ' +
  'manual merge bypass.'

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
 * May this gate stay armed? Only when the latest canonical record approves the
 * current head, no durable red bound exists, and no review is running.
 *
 * @param {{ verdict: string | null, head: string | null, reviews: number, spent: boolean }} records
 * @param {{ headRefOid?: unknown }} gate
 * @param {boolean} reviewing
 */
function reviewBoundStopped(records) {
  return records.spent
}

function mayStayArmed(records, gate, reviewing) {
  return (
    !reviewing &&
    !reviewBoundStopped(records) &&
    approves(records.verdict) &&
    isCommitSha(gate.headRefOid) &&
    records.head === gate.headRefOid
  )
}

/**
 * Re-admit the exact retained proof binding before retaining an arm. This also
 * detects a null-to-applicable producer transition at the same commit.
 */
async function hasFreshReviewInput(cwd, pr, records, { gh: ghFn = gh, git: gitFn, proofPins } = {}) {
  if (proofPins !== undefined && !Array.isArray(proofPins)) return false
  return (await admitCurrentReviewBinding(cwd, pr, records, ghFn, gitFn, proofPins)).ok
}

/**
 * The one armed-gate exit (#729). Actual `reviewing` and authorization policy
 * are separate: `unarmed` never consults records. Unknown gates authorize no
 * action; non-OPEN and already clear gates are honest no-ops. An OPEN arm may
 * remain only on current approval, otherwise the hardened primitive clears it
 * or throws naming exactly what remains.
 *
 * @param {string} cwd
 * @param {string | number} pr
 * @param {{
 *   records?: { verdict: string | null, head: string | null, spent: boolean },
 *   gate?: { state?: string, headRefOid?: unknown, labels: { name?: string }[], autoMergeRequest?: unknown },
 *   reviewing?: boolean,
 *   policy?: 'allow-approved' | 'unarmed',
 *   gh?: (cwd: string, args: string[]) => Promise<string>,
 * }} opts
 * @returns {Promise<{ allowed: boolean, disarmed?: true }>}
 */
async function enforceArmedGate(
  cwd,
  pr,
  { records, gate, reviewing = false, policy = 'allow-approved', gh: ghFn = gh },
) {
  if (gate?.state !== 'OPEN') return { allowed: false }
  if (!gate.autoMergeRequest && !gate.labels.some((label) => label?.name === 'reviewed')) return { allowed: false }
  if (policy === 'allow-approved' && records && mayStayArmed(records, gate, reviewing)) return { allowed: true }
  const disarmed = await disarmGate(cwd, pr, gate, ghFn)
  return disarmed ? { allowed: false, disarmed: true } : { allowed: false }
}

/**
 * The move canonical records allow at the PR's current head. Caller-supplied
 * verdicts never select the transition: the confirmed final decision does.
 *
 * @param {{ reviews: number, verdict: string | null, head: string | null, spent: boolean }} records
 * @param {{ head: unknown, ciFailed?: boolean }} at
 */
export function reviewStep(records, { head, ciFailed = false }) {
  const { reviews } = records
  if (reviewBoundStopped(records)) return stopStep('review-bound', reviews)
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
 * Freshly derives the one transition from complete common history, then clears
 * any OPEN arm unless that same fresh review still authorizes it. A head that
 * differs after the proof read is `head-moved`. A stale proof at that same head
 * is `proof-changed`. Head movement wins when both are true. Landing
 * admission is not a prerequisite: landPr and the CI allow exits own it.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{
 *   ciFailed?: boolean,
 *   reviewing?: boolean,
 *   gh?: (cwd: string, args: string[]) => Promise<string>,
 *   git?: import('./proof').Git,
 * }} [opts]
 */
export async function nextReviewStep(cwd, pr, { ciFailed = false, reviewing = false, gh: ghFn = gh, git: gitFn } = {}) {
  let number = pr
  let records
  let gate
  let step
  let failure
  let policy = 'allow-approved'
  try {
    if (pr === null || pr === undefined || pr === '') {
      throw new TypeError(`nextReviewStep: pr is required, got ${JSON.stringify(pr)}`)
    }
    number = await resolveReviewPr(cwd, pr, { gh: ghFn })
    gate = await readGate(cwd, number, ghFn)
    records = await requiredReviewRecords(cwd, number, { gh: ghFn })
    step = reviewStep(records, { head: gate.headRefOid, ciFailed })
    if (step.action !== 'land') policy = 'unarmed'
  } catch (error) {
    const refusal = error?.reviewRecords
    if (refusal?.spent === true) {
      try {
        gate = await readGate(cwd, number, ghFn)
        step = stopStep('review-bound', refusal.knownReviews)
        policy = 'unarmed'
      } catch (gateError) {
        failure = gateError
      }
    } else {
      failure = error
      policy = 'unarmed'
    }
  }
  if (
    records &&
    gate?.state === 'OPEN' &&
    policy !== 'unarmed' &&
    !reviewing &&
    mayStayArmed(records, gate, reviewing)
  ) {
    try {
      records = await requiredReviewRecords(cwd, number, { gh: ghFn })
      const head = await readHeadRefOid(cwd, number, ghFn)
      const base = await resolveLandingBase(cwd, number, ghFn, gitFn)
      if (base.refusal || !isCommitSha(head)) {
        policy = 'unarmed'
      } else {
        const proofPins = await liveProofPins(cwd, gitFn ?? gitResult, base.tip)
        const proofFresh = await hasFreshReviewInput(cwd, number, records, {
          gh: ghFn,
          git: gitFn,
          proofPins,
        })
        gate = { ...gate, headRefOid: await readHeadRefOid(cwd, number, ghFn) }
        const headMoved = gate.headRefOid !== records.head || gate.headRefOid !== head
        if (!proofFresh || headMoved) {
          policy = 'unarmed'
          if (!failure && step?.action === 'land') {
            step = headMoved
              ? { action: /** @type {'review'} */ ('review'), reason: 'head-moved', reviews: records.reviews }
              : { action: /** @type {'review'} */ ('review'), reason: 'proof-changed', reviews: records.reviews }
          }
        } else if (!failure) {
          step = reviewStep(records, { head: gate.headRefOid, ciFailed })
          if (step.action !== 'land') policy = 'unarmed'
        }
      }
    } catch (error) {
      failure ??= error
      policy = 'unarmed'
    }
  }

  if (!failure && step?.action === 'stop' && step.reason === 'ci-failed') {
    policy = 'unarmed'
    try {
      await persistObservedCiStop(cwd, number, { gh: ghFn, git: gitFn })
    } catch (error) {
      // The observed red is never erased: clear the gate, then refuse continuation.
      failure = error
    }
  }
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, number, { records, gate, reviewing, policy, gh: ghFn })
  } catch (disarmError) {
    if (failure) {
      throw new Error(`${errorText(failure)} — and the disarm failed: ${errorText(disarmError)}`, { cause: failure })
    }
    throw disarmError
  }
  if (failure) throw failure
  return { ...step, ...(receipt.disarmed && { disarmed: true }) }
}
