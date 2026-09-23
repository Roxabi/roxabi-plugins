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

async function gh(cwd, args) {
  const proc = Bun.spawn(['gh', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`gh ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
  return stdout.trim()
}

/** First 200 characters of a client response, for an error message that names what arrived. */
function preview(raw) {
  const text = String(raw ?? '')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || '(empty)'
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
 * | the create races another opener | `{ number, status: 'existing' }` — GitHub's 422 is re-read as a lookup, not swallowed |
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
    // Between the lookup above and this call another opener may have won; re-read
    // rather than fail, but only on that message — every other failure propagates.
    const message = error instanceof Error ? error.message : String(error)
    if (/already exists/i.test(message)) {
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
 * `reviewed` label and no auto-merge — `landPr` is never called.
 *
 * ```js
 * const loop = createReviewLoop({ pr })
 * let step = loop.record(verdict)        // after every dev-review verdict
 * while (step.action === 'fix') { …run fix, re-review… ; step = loop.record(verdict) }
 * if (step.action === 'land') await landPr(cwd, pr)
 * else print(step.message)               // stop: nothing is labelled, nothing merges
 * ```
 *
 * @param {{ pr?: number | string | null, maxFixRounds?: number }} [options]
 */
export function createReviewLoop({ pr = null, maxFixRounds = MAX_FIX_ROUNDS } = {}) {
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0) {
    throw new TypeError(
      `createReviewLoop: maxFixRounds must be a non-negative integer, got ${JSON.stringify(maxFixRounds)}`,
    )
  }
  const subject = pr === null || pr === undefined || pr === '' ? 'The PR' : `PR #${pr}`
  let reviews = 0
  let fixes = 0
  /** @type {'land' | 'stop' | null} */
  let closed = null

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
      if (fixes >= maxFixRounds) {
        closed = 'stop'
        return {
          action: 'stop',
          reason: 'review-bound',
          reviews,
          fixes,
          message: `Review bound reached: ${reviews} reviews, ${fixes} fix rounds, still red. ${subject} stays unlabelled and unmerged — no \`reviewed\` label, no auto-merge. Read the findings on the PR, then fix by hand or close it.`,
        }
      }
      fixes += 1
      return { action: 'fix', reviews, fixes, remaining: maxFixRounds - fixes }
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
