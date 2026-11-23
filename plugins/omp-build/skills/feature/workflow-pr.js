import { featurePullBody } from './generated-pr-body.js'
import { confirmSelectedBinding } from './workflow-binding.js'
import { gh, git, preview } from './workflow-runtime.js'

const DUPLICATE_HEAD = /\ba pull request already exists\b/i

function httpStatus(error, text) {
  const declared = Number(error?.status)
  if (Number.isInteger(declared) && declared > 0) return declared
  const found = text.match(/\bHTTP[\s:]*(\d{3})\b/i) || text.match(/\((?:HTTP\s*)?(\d{3})\)/)
  return found ? Number(found[1]) : null
}

function ghFailurePayload(error) {
  if (error !== null && typeof error === 'object') {
    const fields = ['stderr', 'stdout', 'body']
      .map((key) => error[key])
      .filter((value) => typeof value === 'string' && value.trim())
    if (fields.length) {
      const text = fields.join('\n')
      return { status: httpStatus(error, text), text }
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const tail = message.match(/^[\s\S]*\sfailed \(\d+\):[ \t]*([\s\S]*)$/)
  return tail ? { status: httpStatus(error, tail[1]), text: tail[1] } : null
}

function isDuplicateHeadFailure(error) {
  const payload = ghFailurePayload(error)
  if (payload === null || (payload.status !== null && payload.status !== 422)) return false
  const start = payload.text.indexOf('{')
  try {
    const messages =
      start === -1
        ? []
        : JSON.parse(payload.text.slice(start))
            ?.errors?.map((entry) => entry?.message)
            .filter(Boolean)
    return messages?.length
      ? messages.some((message) => DUPLICATE_HEAD.test(message))
      : DUPLICATE_HEAD.test(payload.text)
  } catch {
    return DUPLICATE_HEAD.test(payload.text)
  }
}

function requireField(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`openPr: ${label} is required, got ${JSON.stringify(value)}`)
  return value.trim()
}

function bodyFor(body, issue) {
  return featurePullBody(body, issue)
}

function sameRepositoryPrs(entries, caller) {
  for (const entry of entries)
    if (typeof entry?.isCrossRepository !== 'boolean') throw new Error(`${caller}: invalid PR discovery response`)
  return entries.filter((entry) => entry.isCrossRepository === false)
}

function repositoryCandidates(data, base) {
  if (data.some((entry) => !['OPEN', 'CLOSED', 'MERGED'].includes(entry.state)))
    throw new Error('openPr: invalid PR discovery response')
  const open = data.filter((entry) => entry.state === 'OPEN')
  if (open.length === 1 && open[0].baseRefName !== base)
    throw Object.assign(new Error('openPr: open PR targets another base'), { reason: 'conflicting-pr' })
  if (open.length === 0 && data.length !== 0)
    throw Object.assign(new Error('openPr: branch already has a terminal PR'), { reason: 'conflicting-pr' })
  return open
}

export async function findOpenPr(cwd, head, base, ghFn, repository) {
  const raw = await ghFn(cwd, [
    'pr',
    'list',
    '--head',
    head,
    ...(repository === undefined
      ? ['--base', base, '--state', 'open']
      : ['--repo', repository, '--state', 'all', '--limit', '100']),
    '--json',
    repository === undefined ? 'number,isCrossRepository' : 'number,isCrossRepository,state,baseRefName',
  ])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned no JSON — ${preview(raw)}`)
  }
  if (!Array.isArray(data)) throw new Error(`openPr: \`gh pr list --head ${head}\` returned no array — ${preview(raw)}`)
  if (repository !== undefined && data.length >= 100)
    throw Object.assign(new Error('openPr: too many PR candidates to resolve'), { reason: 'ambiguous-pr' })
  if (data.some((entry) => !Number.isInteger(entry?.number) || entry.number <= 0))
    throw new Error(`openPr: \`gh pr list --head ${head}\` returned an entry with no PR number — ${preview(raw)}`)
  const sameRepo = sameRepositoryPrs(data, 'openPr')
  const candidates = repository === undefined ? sameRepo : repositoryCandidates(sameRepo, base)
  if (candidates.length > 1)
    throw Object.assign(new Error('openPr: multiple PR candidates'), { reason: 'ambiguous-pr' })
  return candidates[0]?.number ?? null
}

async function bindOpened(cwd, number, ghFn, claim, status, confirm) {
  if (confirm === undefined) {
    const binding = await confirmSelectedBinding(cwd, number, ghFn, claim)
    if (!binding.ok) throw new Error(`openPr: workflow binding refused: ${binding.reason}`)
    return { number, status }
  }
  let binding
  try {
    binding = await confirm(number)
  } catch (error) {
    throw Object.assign(new Error(`openPr: binding for #${number} unconfirmed`, { cause: error }), { pr: number })
  }
  if (binding.ok) return { number, status, binding: binding.recordId }
  const error = new Error(`openPr: workflow binding refused: ${binding.reason}`)
  if (status === 'existing' && binding.reason === 'binding-conflict')
    throw Object.assign(error, { reason: binding.reason })
  throw Object.assign(error, { pr: number })
}

export async function resolveReviewPr(cwd, explicitPr, { gh: ghFn = gh, git: gitFn = git } = {}) {
  if (explicitPr !== undefined && explicitPr !== null && explicitPr !== '') {
    const number = Number(explicitPr)
    if (!/^[1-9]\d*$/.test(String(explicitPr)) || !Number.isSafeInteger(number))
      throw new TypeError('resolveReviewPr: expected a positive PR number')
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
  const sameRepo = sameRepositoryPrs(entries, 'resolveReviewPr')
  if (
    sameRepo.some(
      (entry) =>
        !Number.isSafeInteger(entry?.number) ||
        entry.number <= 0 ||
        !['OPEN', 'CLOSED', 'MERGED'].includes(entry.state),
    )
  )
    throw new Error('resolveReviewPr: invalid PR discovery response')
  const open = sameRepo.filter((entry) => entry.state === 'OPEN')
  if (open.length > 1) throw new Error('resolveReviewPr: multiple open PRs for this branch; pass the PR number')
  if (open.length === 1) return open[0].number
  if (sameRepo.some((entry) => entry.state === 'CLOSED'))
    throw new Error('resolveReviewPr: this branch has a closed PR; use an explicit superseding branch')
  return null
}

export async function openPr(
  cwd,
  { issue, branch, base, title, body } = {},
  { gh: ghFn = gh, repository, beforeCreate, confirm } = {},
) {
  const number = Number(issue)
  if (!Number.isInteger(number) || number <= 0)
    throw new TypeError(`openPr: issue must be a positive issue number, got ${JSON.stringify(issue)}`)
  const claim = { issue: number, branch: requireField(branch, 'branch'), base: requireField(base, 'base') }
  const prTitle = requireField(title, 'title')
  const existing = await findOpenPr(cwd, claim.branch, claim.base, ghFn, repository)
  if (existing !== null) return bindOpened(cwd, existing, ghFn, claim, 'existing', confirm)
  await beforeCreate?.()
  let created
  try {
    created = await ghFn(cwd, [
      'api',
      '--method',
      'POST',
      `repos/${repository ?? '{owner}/{repo}'}/pulls`,
      '-f',
      `head=${claim.branch}`,
      '-f',
      `base=${claim.base}`,
      '-f',
      `title=${prTitle}`,
      '-f',
      `body=${bodyFor(body, number)}`,
    ])
  } catch (error) {
    const raced = isDuplicateHeadFailure(error)
      ? await findOpenPr(cwd, claim.branch, claim.base, ghFn, repository)
      : null
    if (raced !== null) return bindOpened(cwd, raced, ghFn, claim, 'existing', confirm)
    throw error
  }
  let data
  try {
    data = JSON.parse(created)
  } catch {
    throw new Error(`openPr: \`gh api … pulls\` returned no JSON — ${preview(created)}`)
  }
  if (!Number.isInteger(data?.number) || data.number <= 0)
    throw new Error(`openPr: \`gh api … pulls\` carried no PR number — ${preview(created)}`)
  return bindOpened(cwd, data.number, ghFn, claim, 'created', confirm)
}

function addStringContexts(out, contexts) {
  if (!Array.isArray(contexts)) return
  for (const context of contexts) if (typeof context === 'string') out.add(context)
}

function addCheckContexts(out, checks) {
  if (!Array.isArray(checks)) return
  for (const check of checks) if (check && typeof check.context === 'string') out.add(check.context)
}

function addRulesetContexts(out, rules) {
  for (const rule of rules) {
    if (rule?.type === 'required_status_checks') addCheckContexts(out, rule.parameters?.required_status_checks)
  }
}

function addClassicContexts(out, data) {
  const requiredStatusChecks = data.required_status_checks ?? data
  addStringContexts(out, requiredStatusChecks.contexts)
  addCheckContexts(out, requiredStatusChecks.checks)
}

export function parseRequiredContexts(apiJson) {
  const out = new Set()
  try {
    const data = JSON.parse(apiJson)
    if (!data || typeof data !== 'object') return out
    if (Array.isArray(data)) addRulesetContexts(out, data)
    else addClassicContexts(out, data)
  } catch {
    /* parse failure → ∅ */
  }
  return out
}

export async function resolveRequiredContexts(cwd, base, ghFn = gh) {
  const out = new Set()
  try {
    const { nameWithOwner } = JSON.parse(await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    const [owner, repo] = (nameWithOwner || '').split('/')
    if (!owner || !repo) return []
    for (const endpoint of [
      `repos/${owner}/${repo}/branches/${base}/protection/required_status_checks`,
      `repos/${owner}/${repo}/rules/branches/${base}`,
    ]) {
      try {
        for (const context of parseRequiredContexts(await ghFn(cwd, ['api', endpoint]))) out.add(context)
      } catch {}
    }
  } catch {}
  return [...out]
}
