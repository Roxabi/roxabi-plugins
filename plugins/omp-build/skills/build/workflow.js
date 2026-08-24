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

async function git(cwd, args) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
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
  const slug = (fromName && fromName[2]) || kebab(title) || (n ? `issue-${n}` : 'wip')
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

/** Commit dirty tree if any, then push the feature branch. */
async function commitPush(cwd, branch, message) {
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

# Acceptance
Acceptance met. Reply one line: \`implement: ok\``,

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

const WATCH_MS = 20 * 60 * 1000
const WATCH_EVERY = 15_000

/** Label PR `reviewed`, enable auto-merge, watch until MERGED. No mid-CI merge. */
export async function landPr(cwd, pr, { now = Date.now, sleep = (ms) => Bun.sleep(ms), timeout = WATCH_MS } = {}) {
  await gh(cwd, ['pr', 'edit', String(pr), '--add-label', 'reviewed'])
  try {
    await gh(cwd, ['pr', 'merge', String(pr), '--auto', '--merge'])
  } catch {
    /* merge-on-green: label is the gate */
  }
  const deadline = now() + timeout
  while (now() < deadline) {
    const j = JSON.parse(await gh(cwd, ['pr', 'view', String(pr), '--json', 'state,statusCheckRollup']))
    if (j.state === 'MERGED') return { status: 'merged' }
    if (j.state === 'CLOSED') return { status: 'closed' }
    const checks = j.statusCheckRollup || []
    if (checks.some((c) => ['FAILURE', 'CANCELLED', 'TIMED_OUT'].includes(c.conclusion))) {
      return { status: 'ci-failed' }
    }
    await sleep(WATCH_EVERY)
  }
  return { status: 'timeout' }
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
