/**
 * OMP /build — sequential SDLC after spec validation.
 *
 * agent() has no cwd. Isolated apply lands on the *session* HEAD.
 * Therefore this script never `git switch`s the principal checkout.
 *
 * Two entries:
 *   principal → create ~/.omp/worktrees/<repo>/<type>-<issue>-<slug>, return
 *               need-relaunch (omp --cwd ω). Do not implement here.
 *   already in ω → run the pipeline. Session HEAD is the feature branch.
 *
 * Review = sibling agent() (reviewer, security-reviewer). No nested task.
 * NEVER pipeline() this chain.
 */

export const PRINCIPALS = ['staging', 'main', 'master']
const HOME = process.env.HOME || ''

/** @typedef {{ issue: number, specPath: string, cwd: string, principal: string, branch: string, worktree: string, principalPath: string }} BuildContext */

/** Hook vars that redirect git. Same set as check-principal-branch.sh git_probe. */
export const GIT_HOOK_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
]

export function stripGitHookEnv(env = process.env) {
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

export function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function parseSpecMeta(text, { issue, specPath } = {}) {
  const type = (text.match(/^type:\s*["']?(\w+)/m) || [])[1] || 'feat'
  const title = (text.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || ''
  const fmIssue = (text.match(/^issue:\s*(\d+)/m) || [])[1]
  const fromName = specPath?.match(/(\d+)-(.+)-spec\.md$/)
  const n = issue ?? (fmIssue ? Number(fmIssue) : null)
  const slug = fromName?.[2] || kebab(title) || (n ? `issue-${n}` : 'wip')
  return { type, slug, title, issue: n }
}

export async function readSpecMeta(specPath, issue) {
  const text = await Bun.file(specPath).text()
  return parseSpecMeta(text, { issue, specPath })
}

export async function findSpecForIssue(root, issue) {
  const glob = new Bun.Glob(`artifacts/specs/${issue}-*-spec.md`)
  for await (const p of glob.scan({ cwd: root, absolute: true })) return p
  return null
}

const fetched = new Set()

export function pickPrincipal(present) {
  for (const b of PRINCIPALS) {
    if (present.has(b)) return b
  }
  return null
}

export function startPointFor(principal, hasOrigin) {
  return hasOrigin ? `origin/${principal}` : principal
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

export async function repoName(cwd) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  return root.split('/').pop() || 'repo'
}

export async function isWorktree(cwd) {
  const gitDir = await git(cwd, ['rev-parse', '--git-dir'])
  const common = await git(cwd, ['rev-parse', '--git-common-dir'])
  return gitDir !== common
}

/** Policy: no branch without an issue. Mint first, then <type>/<issue>-<slug>. */
export async function resolveNames({ cwd, type, slug, issue }) {
  if (!issue) throw new Error('resolveNames: mint first')
  if (!type || !slug) throw new Error('resolveNames: type and slug required')
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  const principal = await detectPrincipal(root)
  const name = await repoName(root)
  return {
    type,
    slug,
    issue,
    principal,
    branch: `${type}/${issue}-${slug}`,
    worktree: `${HOME}/.omp/worktrees/${name}/${type}-${issue}-${slug}`,
    principalPath: root,
  }
}

export async function resolveNamesFromSpec({ cwd, issue, specPath }) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  let spec = specPath || null
  if (!spec && issue) spec = await findSpecForIssue(root, issue)
  if (!spec) throw new Error('resolveNamesFromSpec: spec required')
  const meta = await readSpecMeta(spec, issue)
  if (!meta.issue) throw new Error('resolveNamesFromSpec: spec has no issue: — mint first')
  return {
    ...(await resolveNames({ cwd: root, type: meta.type, slug: meta.slug, issue: meta.issue })),
    ...meta,
    specPath: spec,
  }
}

/** Create ω from principal. Never switch principal HEAD. `names` from resolveNames. */
export async function ensureWorktree(principalPath, names) {
  const head = await git(principalPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!PRINCIPALS.includes(head)) {
    throw new Error(`principal HEAD is ${head}, not staging|main|master — refuse`)
  }
  const resolved = names.branch ? names : await resolveNames({ cwd: principalPath, ...names })
  const listed = await git(principalPath, ['worktree', 'list', '--porcelain'])
  if (listed.includes(resolved.worktree)) return resolved

  const dirty = await git(principalPath, ['status', '--porcelain'])
  if (dirty) throw new Error(`principal dirty — refuse\n${dirty}`)

  resolved.principal = await detectPrincipal(principalPath)
  if (head === resolved.principal && (await refExists(principalPath, `refs/remotes/origin/${resolved.principal}`))) {
    await git(principalPath, ['merge', '--ff-only', `origin/${resolved.principal}`])
  }

  await Bun.$`mkdir -p ${resolved.worktree.split('/').slice(0, -1).join('/')}`.quiet()
  const branchExists = await git(principalPath, ['rev-parse', '--verify', resolved.branch])
    .then(() => true)
    .catch(() => false)
  if (branchExists) {
    await git(principalPath, ['worktree', 'add', resolved.worktree, resolved.branch])
  } else {
    const start = startPointFor(
      resolved.principal,
      await refExists(principalPath, `refs/remotes/origin/${resolved.principal}`),
    )
    await git(principalPath, ['worktree', 'add', '-b', resolved.branch, resolved.worktree, start])
  }
  return resolved
}

/**
 * Commit dirty tree if any, then push the feature branch.
 *
 * Exported since #494: `/feature` mode 2 drives the deterministic steps — commit,
 * push, open, land — from skill prose, and prose cannot call a module-private
 * function. `run()` still calls it in-module (expand–contract: #497 deletes the
 * driver, not this).
 */
export async function commitPush(cwd, branch, message) {
  const status = await git(cwd, ['status', '--porcelain'])
  if (status) {
    await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-m', message])
  }
  await git(cwd, ['push', '-u', 'origin', branch])
}

/**
 * @param {BuildContext} ctx
 * @param {string} stage
 * @param {Record<string, unknown>} [extra]
 */
async function runStage(ctx, stage, extra = {}) {
  const { issue, specPath, cwd, principal, branch } = ctx
  const planPath = `artifacts/plans/${issue}-plan.md`
  const reviewPath = `artifacts/reviews/${issue}-review.md`

  const prompts = {
    plan: `# Target
Issue #${issue}, spec: ${specPath}, cwd: ${cwd} (feature worktree on ${branch})

# Change
Read the spec. Write ${planPath} with phased steps tied to Acceptance. Seed todos (todo tool).
Do not touch the principal checkout. Do not git switch.

# Acceptance
${planPath} exists. Reply one line: \`plan: ok\``,

    implement: `# Target
Issue #${issue}, plan: ${planPath}, spec: ${specPath}, cwd: ${cwd} (${branch})

# Change
Read spec + plan. Implement here. Root-cause only. Do not switch branch. Do not git commit or push.
For every Acceptance criterion, exercise its public seam; if repository-executable automation can observe the outcome and no collected test protects it, add the smallest public-seam test asserting that outcome. Report the exact command and result.

# Acceptance
Acceptance met. Command + result reported. Reply one line: \`implement: ok\``,

    pr: `# Target
Issue #${issue}, spec: ${specPath}, cwd: ${cwd}

# Change
github pr_create. head=${branch} base=${principal}. Link #${issue}.
The branch is already pushed. Do not create an empty PR.

# Acceptance
PR open. Reply one line: \`pr: <number>\``,

    review: `# Target
Issue #${issue}, spec: ${specPath}, cwd: ${cwd}, PR head ${branch}

# Change
You ARE the reviewer. Review the PR diff against spec Acceptance.
Independently run collected tests covering Acceptance. Reject skipped/uncollected tests, name-only mappings, tautologies, implementation-mirroring, internal-seam assertions. Manual only when repo-executable code cannot observe the outcome — require technical blocker, procedure, observed result.
Do not spawn subagents. Write ${reviewPath} with \`verdict: green|red\` and R₁ findings.

# Acceptance
Reply one line: \`review: green\` or \`review: red\``,

    'review-sec': `# Target
Issue #${issue}, spec: ${specPath}, cwd: ${cwd}

# Change
You ARE the security-reviewer. Audit the PR diff. Do not spawn subagents.
Append ## Security to ${reviewPath}. End with \`review: green\` or \`review: red\`.

# Acceptance
Reply one line: \`review: green\` or \`review: red\``,

    fix: `# Target
Issue #${issue}, review: ${reviewPath}, spec: ${specPath}, cwd: ${cwd} (${branch})

# Change
Fix root causes (R₁) on this worktree. Do not switch branch. Do not git commit or push.

# Acceptance
Reply one line: \`fix: ok\``,
  }

  const prompt = prompts[stage]
  if (!prompt) throw new Error(`Unknown stage: ${stage}`)

  const opts = {
    handle: true,
    label: `build-${stage}-${issue}`,
  }
  if (extra.agent) opts.agent = extra.agent

  const result = await agent(prompt, opts)
  const text = (result?.text ?? result?.output ?? String(result)).trim()
  return { text, result }
}

function parseVerdict(text) {
  const m = String(text).match(/review:\s*(green|red)/i)
  if (m) return m[1].toLowerCase()
  if (/green/i.test(text) && !/red/i.test(text)) return 'green'
  if (/red/i.test(text)) return 'red'
  return 'red'
}

async function reviewPair(ctx) {
  const a = await runStage(ctx, 'review', { agent: 'reviewer' })
  const b = await runStage(ctx, 'review-sec', { agent: 'security-reviewer' })
  const verdict = parseVerdict(a.text) === 'red' || parseVerdict(b.text) === 'red' ? 'red' : 'green'
  return { verdict }
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
 * @param {(cwd: string, args: string[]) => Promise<string>} ghFn
 * @returns {Promise<number | null>}
 */
async function findOpenPr(cwd, head, base, ghFn) {
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
 * `runStage(ctx, 'pr')` asks a subagent to open the PR and then recovers the number by
 * regexing `pr:\s*(\S+)` out of whatever it replied (`run()`, below). That number is an
 * agent's wording: a reply of `pr: opened!` yields the string `opened!`, which reaches
 * `landPr` as a PR id and fails there, one stage late. Here the number is the `number`
 * field of the client's own response, or nothing at all.
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

const WATCH_MS = 20 * 60 * 1000
const WATCH_EVERY = 15_000

const CI_FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'])

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

/**
 * @param {Array<{ name?: string, conclusion?: string | null, status?: string }>} checks
 * @param {string[]} required
 */
export function evaluateRequiredRollup(checks, required) {
  if (!required?.length) return { ready: false, status: 'no-required-checks' }

  const failed = []
  const skipped = []
  const pending = []
  const missing = []

  for (const ctx of required) {
    const check = checks.find((c) => c.name === ctx)
    if (!check) {
      missing.push(ctx)
      pending.push(ctx)
      continue
    }
    const { conclusion, status } = check
    if (CI_FAILED.has(conclusion)) {
      failed.push(ctx)
      continue
    }
    if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
      skipped.push(ctx)
      continue
    }
    if (!conclusion || conclusion === '' || status !== 'COMPLETED' || conclusion !== 'SUCCESS') {
      pending.push(ctx)
    }
  }

  if (failed.length) return { ready: false, status: 'ci-failed', failed }
  if (skipped.length) return { ready: false, status: 'ci-skipped', skipped }
  if (pending.length || missing.length) return { ready: false, status: 'pending', pending, missing }
  return { ready: true, status: 'ok' }
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

/** Wait for required rollup SUCCESS, then label `reviewed` and auto-merge. */
export async function landPr(
  cwd,
  pr,
  { now = Date.now, sleep = (ms) => Bun.sleep(ms), timeout = WATCH_MS, gh: ghFn = gh, requiredContexts } = {},
) {
  const required = requiredContexts !== undefined ? [...requiredContexts] : await resolveRequiredContexts(cwd, pr, ghFn)

  if (required.length === 0) return { status: 'no-required-checks' }

  let labeled = false
  const deadline = now() + timeout

  while (now() < deadline) {
    const j = JSON.parse(await ghFn(cwd, ['pr', 'view', String(pr), '--json', 'state,statusCheckRollup']))
    if (j.state === 'MERGED') return { status: 'merged' }
    if (j.state === 'CLOSED') return { status: 'closed' }

    const rollup = evaluateRequiredRollup(j.statusCheckRollup || [], required)
    if (rollup.status === 'ci-failed') return { status: 'ci-failed', failed: rollup.failed }
    if (rollup.status === 'ci-skipped') return { status: 'ci-skipped', skipped: rollup.skipped }

    if (rollup.status === 'pending') {
      await sleep(WATCH_EVERY)
      continue
    }

    if (!labeled) {
      await ghFn(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
      labeled = true
      try {
        await ghFn(cwd, ['pr', 'merge', String(pr), '--auto', '--merge'])
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!/already enabled/i.test(msg)) return { status: 'auto-merge-failed' }
      }
    }

    await sleep(WATCH_EVERY)
  }
  return { status: 'timeout' }
}

/** ADR-020 §3 / #488: at most two review→fix rounds. The third red stops. */
export const MAX_FIX_ROUNDS = 2

/**
 * The durable half of the bound.
 *
 * `createReviewLoop` on its own is a counter in one agent's process: it binds an agent
 * that keeps the handle and nothing else, and ADR-020 names that agent untrustworthy.
 * So the count is also written on the PR, in a line a machine can read back — a PR
 * comment carrying `<!-- omp-build:review-rounds reviews=N fixes=M -->`. A fresh loop
 * built with `resumeReviewLoop` starts from what the PR says, not from zero.
 */
const ROUNDS_MARKER = /<!--\s*omp-build:review-rounds\s+reviews=(\d+)\s+fixes=(\d+)\s*-->/g

/**
 * The highest round counts any marker in `text` carries, or `null` when there is none.
 *
 * Highest, not last: the marker is evidence that rounds were spent, so re-posting an
 * older one must not hand a round back.
 *
 * @param {string} text
 * @returns {{ reviews: number, fixes: number } | null}
 */
export function parseReviewRounds(text) {
  let found = null
  for (const [, reviews, fixes] of String(text ?? '').matchAll(ROUNDS_MARKER)) {
    const seen = { reviews: Number(reviews), fixes: Number(fixes) }
    found = found ? { reviews: Math.max(found.reviews, seen.reviews), fixes: Math.max(found.fixes, seen.fixes) } : seen
  }
  return found
}

/**
 * Read the rounds already spent on `pr`. `{ reviews: 0, fixes: 0 }` when the PR carries
 * no marker — that is a PR whose first review has not happened yet.
 *
 * Fails closed, like `findOpenPr`: a response that is not the promised shape throws
 * rather than reading as "no rounds spent", because "no rounds spent" is the answer that
 * refunds the bound.
 *
 * @param {string} cwd
 * @param {number | string} pr
 * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
 * @returns {Promise<{ reviews: number, fixes: number }>}
 */
export async function readReviewRounds(cwd, pr, { gh: ghFn = gh } = {}) {
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
  const bodies = data.comments.map((c) => (typeof c?.body === 'string' ? c.body : '')).join('\n')
  return parseReviewRounds(bodies) ?? { reviews: 0, fixes: 0 }
}

/**
 * The loop for a PR that may already have spent rounds — the constructor to use in
 * `/feature` §6.4, so that re-entering mode 2 (or re-creating the loop mid-session)
 * **resumes** the bound instead of restarting it.
 *
 * @param {string} cwd
 * @param {{ pr: number | string, maxFixRounds?: number, gh?: (cwd: string, args: string[]) => Promise<string> }} options
 */
export async function resumeReviewLoop(cwd, { pr, maxFixRounds = MAX_FIX_ROUNDS, gh: ghFn = gh } = {}) {
  if (pr === null || pr === undefined || pr === '') {
    throw new TypeError(`resumeReviewLoop: pr is required — there is nothing to resume from, got ${JSON.stringify(pr)}`)
  }
  const spent = await readReviewRounds(cwd, pr, { gh: ghFn })
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
 * only from a green verdict.
 *
 * Rounds, on the ticket's wording: review → red → fix → review → red → fix → review.
 * Two fix rounds; the third red returns `stop`, and `stop` means the PR keeps no
 * `reviewed` label and no auto-merge — `landPr` is never called. `enforceStop` makes
 * that true of the PR rather than of this object: the `reviewed` label is the only
 * observable consequence the loop has, so on `stop` it is read back and removed.
 *
 * ```js
 * const loop = await resumeReviewLoop(cwd, { pr })   // resumes rounds already spent
 * let step = loop.record(verdict)                    // after every dev-review verdict
 * await loop.persist(cwd)                            // the count, on the PR
 * while (step.action === 'fix') { …run fix, re-review… ; step = loop.record(verdict); await loop.persist(cwd) }
 * if (step.action === 'land') {
 *   const land = await landPr(cwd, pr)
 *   if (land.status === 'ci-failed') step = loop.reopen('ci-failed')   // costs a round
 * } else print((await loop.enforceStop(cwd)).message)
 * ```
 *
 * @param {{ pr?: number | string | null, maxFixRounds?: number, reviews?: number, fixes?: number, gh?: (cwd: string, args: string[]) => Promise<string> }} [options]
 */
export function createReviewLoop({
  pr = null,
  maxFixRounds = MAX_FIX_ROUNDS,
  reviews: seedReviews = 0,
  fixes: seedFixes = 0,
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
  const subject = pr === null || pr === undefined || pr === '' ? 'The PR' : `PR #${pr}`
  let reviews = seedReviews
  let fixes = seedFixes
  /** @type {'land' | 'stop' | null} */
  let closed = null
  /** @type {string} */
  let closedReason = 'review-bound'

  /** @param {string} reason */
  function stopStep(reason) {
    closed = 'stop'
    closedReason = reason
    const why =
      reason === 'ci-failed'
        ? `A required check failed after the panel approved, and no fix round is left: ${reviews} reviews, ${fixes} fix rounds.`
        : `Review bound reached: ${reviews} reviews, ${fixes} fix rounds, still red.`
    return {
      action: /** @type {'stop'} */ ('stop'),
      reason,
      reviews,
      fixes,
      message: `${why} ${subject} stays unlabelled and unmerged — no \`reviewed\` label, no auto-merge. Read the findings on the PR, then fix by hand or close it.`,
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
    get remaining() {
      return Math.max(0, maxFixRounds - fixes)
    },
    /**
     * Record one `dev-review` verdict and get the next move.
     *
     * `verdict` is the panel's word — `green` or `red`, nothing else. A sentence, a
     * missing value or a third word throws: reading a verdict out of prose is the
     * failure this slice exists to remove, and a defaulted verdict would either burn
     * a round for free or land an unreviewed PR.
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
        return { action: 'land', reviews, fixes }
      }
      if (fixes >= maxFixRounds) return stopStep('review-bound')
      fixes += 1
      return { action: 'fix', reviews, fixes, remaining: maxFixRounds - fixes }
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
          `createReviewLoop: reopen("ci-failed") only follows a green verdict that closed the loop with "land", not ${JSON.stringify(closed)}`,
        )
      }
      closed = null
      if (fixes >= maxFixRounds) return stopStep('ci-failed')
      fixes += 1
      return { action: 'fix', reviews, fixes, remaining: maxFixRounds - fixes, reason: 'ci-failed' }
    },
    /**
     * Write the rounds spent onto the PR, so the bound survives this process.
     *
     * Called after every `record`. What it buys: a re-entry, a compaction or a crash
     * resumes through `resumeReviewLoop` at the count the PR carries. What it does not
     * buy: anything against an agent that never calls it — a skipped `persist` leaves
     * the count in memory only, which is why §6.6 states it as a step rather than a
     * guarantee.
     *
     * @param {string} cwd
     * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
     */
    async persist(cwd, { gh: ghFn = ghDefault } = {}) {
      const number = requirePr('persist')
      const body = `<!-- omp-build:review-rounds reviews=${reviews} fixes=${fixes} -->\nReview bound: ${reviews} review(s), ${fixes} of ${maxFixRounds} fix round(s) spent (\`/feature\` §6.6).`
      await ghFn(cwd, ['pr', 'comment', number, '--body', body])
      return { reviews, fixes }
    },
    /**
     * Make `stop` true of the PR, not just of this object.
     *
     * `stop` promises "no `reviewed` label, no auto-merge", and that label is the only
     * thing the promise can be measured against: `.github/workflows/auto-merge.yml`
     * turns it into `gh pr merge --auto --merge`. Anything that wrote it earlier — a
     * fix round run in labelling mode, a `dev-review` Phase 8 "Merge as-is", a human —
     * would merge a PR the loop just refused. So on `stop` the label is read back and
     * removed before the operator is told nothing merged.
     *
     * @param {string} cwd
     * @param {{ gh?: (cwd: string, args: string[]) => Promise<string> }} [deps]
     * @returns {Promise<{ removed: boolean, labels: string[], message: string }>}
     */
    async enforceStop(cwd, { gh: ghFn = ghDefault } = {}) {
      if (closed !== 'stop') {
        throw new Error(`createReviewLoop: enforceStop only follows a stop, not ${JSON.stringify(closed)}`)
      }
      const number = requirePr('enforceStop')
      const raw = await ghFn(cwd, ['pr', 'view', number, '--json', 'labels'])
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error(`createReviewLoop: \`gh pr view ${number} --json labels\` returned no JSON — ${preview(raw)}`)
      }
      if (!Array.isArray(data?.labels)) {
        throw new Error(`createReviewLoop: \`gh pr view ${number} --json labels\` carried no labels — ${preview(raw)}`)
      }
      const labels = data.labels.map((l) => (typeof l?.name === 'string' ? l.name : '')).filter(Boolean)
      const stop = stopStep(closedReason)
      let removed = false
      if (labels.includes('reviewed')) {
        await ghFn(cwd, ['pr', 'edit', number, '--remove-label', 'reviewed'])
        removed = true
      }
      const message = removed
        ? `${stop.message}\nA \`reviewed\` label was already on ${subject} — removed, so auto-merge cannot pick it up.`
        : stop.message
      return { removed, labels, message }
    },
  }
}

/**
 * @param {{ issue: number, specPath: string, cwd: string }} input
 */
export async function run({ issue, specPath, cwd }) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const names = await resolveNamesFromSpec({ cwd: top, issue, specPath })
  const expectedBranch = names.branch
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const ω = await isWorktree(cwd)

  if (!ω || head !== expectedBranch) {
    const created = await ensureWorktree(top, names)
    return {
      status: 'need-relaunch',
      worktree: created.worktree,
      branch: created.branch,
      principal: created.principal,
      cmd: `omp --cwd ${created.worktree}`,
    }
  }

  const principal = await detectPrincipal(cwd)
  const common = await git(cwd, ['rev-parse', '--git-common-dir'])
  const principalPath = await git(common.replace(/\/\.git$/, '') || common, ['rev-parse', '--show-toplevel']).catch(
    async () => {
      const root = common.replace(/\/\.git$/, '')
      return root || top
    },
  )

  const ctx = {
    issue,
    specPath,
    cwd,
    principal,
    branch: expectedBranch,
    worktree: cwd,
    principalPath,
  }
  const reviewPath = `artifacts/reviews/${issue}-review.md`

  await runStage(ctx, 'plan')
  await runStage(ctx, 'implement')
  await commitPush(cwd, expectedBranch, `feat(#${issue}): implement`)

  const { text: prText } = await runStage(ctx, 'pr')
  const prMatch = prText.match(/pr:\s*(\S+)/i)
  const pr = prMatch ? prMatch[1] : prText

  let { verdict } = await reviewPair(ctx)
  await commitPush(cwd, expectedBranch, `docs(#${issue}): review`)
  if (verdict === 'red') {
    await runStage(ctx, 'fix')
    await commitPush(cwd, expectedBranch, `fix(#${issue}): review R1`)
    ;({ verdict } = await reviewPair(ctx))
    await commitPush(cwd, expectedBranch, `docs(#${issue}): review 2`)
  }

  if (verdict === 'red') {
    return { status: 'red', reviewPath, branch: expectedBranch, worktree: cwd, pr }
  }

  const land = await landPr(cwd, pr)
  if (land.status !== 'merged') {
    return { status: 'red', reason: land.status, reviewPath, branch: expectedBranch, worktree: cwd, pr }
  }
  return {
    status: 'green',
    pr,
    branch: expectedBranch,
    worktree: cwd,
    cleanup: `git -C ${principalPath} worktree remove ${cwd} && git -C ${principalPath} branch -D ${expectedBranch}`,
  }
}
