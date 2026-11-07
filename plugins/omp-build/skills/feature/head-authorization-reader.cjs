'use strict'
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const core = require('../../vendor/kit-head-authorization/index.cjs')
const execFileAsync = promisify(execFile)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)

function policyFromEnv(env = process.env) {
  const numeric = (name) => {
    const text = env[name]
    if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text) || !positive(Number(text)))
      throw new Error(`invalid ${name}`)
    return Number(text)
  }
  let operatorIds
  try {
    operatorIds = JSON.parse(env.HEAD_AUTH_OPERATOR_IDS)
  } catch {
    throw new Error('invalid HEAD_AUTH_OPERATOR_IDS')
  }
  if (
    !Array.isArray(operatorIds) ||
    !operatorIds.length ||
    operatorIds.some((id) => !positive(id)) ||
    new Set(operatorIds).size !== operatorIds.length
  )
    throw new Error('invalid HEAD_AUTH_OPERATOR_IDS')
  return {
    repositoryId: numeric('HEAD_AUTH_REPOSITORY_ID'),
    operatorIds,
    appId: numeric('HEAD_AUTH_APP_ID'),
    botUserId: numeric('HEAD_AUTH_BOT_USER_ID'),
  }
}

async function defaultGh(cwd, args) {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}
async function json(cwd, gh, args) {
  const result = JSON.parse(await (gh || defaultGh)(cwd, args))
  if (!result || typeof result !== 'object' || result.errors) throw new Error('invalid GitHub API response')
  return result
}
async function resolveRepository({ cwd, gh } = {}) {
  const data = await json(cwd, gh, ['repo', 'view', '--json', 'nameWithOwner'])
  if (typeof data.nameWithOwner !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(data.nameWithOwner))
    throw new Error('invalid repository')
  const [owner, repo] = data.nameWithOwner.split('/')
  return { owner, repo }
}
function route(repo) {
  if (
    !repo ||
    typeof repo.owner !== 'string' ||
    typeof repo.repo !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(repo.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo.repo)
  )
    throw new Error('invalid repository route')
  return `repos/${repo.owner}/${repo.repo}`
}
function variablesPage(data, expected) {
  if (
    !Number.isSafeInteger(data?.total_count) ||
    data.total_count < 0 ||
    !Array.isArray(data.variables) ||
    data.variables.length > 100 ||
    (expected !== null && expected !== data.total_count)
  )
    throw new Error('invalid repository variables page')
}
function collectVariables(items, seen, names, variables) {
  for (const variable of items) {
    if (
      typeof variable?.name !== 'string' ||
      !variable.name ||
      typeof variable.value !== 'string' ||
      seen.has(variable.name)
    )
      throw new Error('invalid repository variable')
    seen.add(variable.name)
    if (names.includes(variable.name)) variables[variable.name] = variable.value
  }
}
function validateVariablesNext(value, root, page) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !url.pathname.endsWith(`/${root}/actions/variables`) ||
    url.searchParams.get('per_page') !== '100' ||
    url.searchParams.get('page') !== String(page + 1) ||
    [...url.searchParams.keys()].length !== 2
  )
    throw new Error('invalid variables next page')
}
function variablesNext(headers, root, page) {
  const lines = headers.split(/\r?\n/).filter((line) => /^link:/i.test(line))
  if (lines.length > 1) throw new Error('ambiguous variables pagination')
  let next = false
  if (lines.length) {
    for (const link of lines[0].slice(lines[0].indexOf(':') + 1).split(',')) {
      const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
      if (!match) throw new Error('invalid variables pagination link')
      if (match[2] !== 'next') continue
      if (next) throw new Error('duplicate variables pagination link')
      validateVariablesNext(match[1], root, page)
      next = true
    }
  }
  return next
}
async function policyFromRepository({ cwd, gh, repo } = {}) {
  repo = repo || (await resolveRepository({ cwd, gh }))
  const root = route(repo)
  const names = ['HEAD_AUTH_REPOSITORY_ID', 'HEAD_AUTH_OPERATOR_IDS', 'HEAD_AUTH_APP_ID', 'HEAD_AUTH_BOT_USER_ID']
  const variables = {}
  const seen = new Set()
  let expected = null
  for (let page = 1; ; page++) {
    const raw = await (gh || defaultGh)(cwd, [
      'api',
      '--include',
      `${root}/actions/variables?per_page=100&page=${page}`,
    ])
    const split = raw.match(/^(HTTP\/\S+ 200[^\r\n]*\r?\n[\s\S]*?)\r?\n\r?\n([\s\S]*)$/i)
    if (!split) throw new Error('missing repository variables pagination headers')
    const data = JSON.parse(split[2])
    variablesPage(data, expected)
    expected = data.total_count
    collectVariables(data.variables, seen, names, variables)
    const next = variablesNext(split[1], root, page)
    if (!next) break
    if (!data.variables.length) throw new Error('empty variables pagination page')
  }
  if (seen.size !== expected) throw new Error('incomplete repository variables')
  const count = names.filter((name) => Object.hasOwn(variables, name)).length
  if (!count) return null
  if (count !== names.length) throw new Error('incomplete repository authorization policy')
  return policyFromEnv(variables)
}
function checkPolicy(policy) {
  if (
    !policy ||
    !positive(policy.repositoryId) ||
    !positive(policy.appId) ||
    !positive(policy.botUserId) ||
    !Array.isArray(policy.operatorIds) ||
    !policy.operatorIds.length ||
    policy.operatorIds.some((id) => !positive(id)) ||
    new Set(policy.operatorIds).size !== policy.operatorIds.length
  )
    throw new Error('invalid authorization policy')
}
const query =
  'query($id: ID!) { node(id: $id) { ... on IssueComment { id fullDatabaseId lastEditedAt repository { fullDatabaseId } pullRequest { fullDatabaseId number } } } }'
async function readScope({ cwd, gh, root, prNumber, policy }) {
  const repository = await json(cwd, gh, ['api', root])
  const pr = await json(cwd, gh, ['api', `${root}/pulls/${prNumber}`])
  if (
    repository.id !== policy.repositoryId ||
    !positive(pr.id) ||
    pr.number !== prNumber ||
    pr.base?.repo?.id !== repository.id ||
    !sha(pr.head?.sha) ||
    typeof pr.base?.ref !== 'string' ||
    !pr.base.ref ||
    !positive(pr.user?.id)
  )
    throw new Error('invalid pull request scope')
  const refPath = pr.base.ref.split('/').map(encodeURIComponent).join('/')
  const base = await json(cwd, gh, ['api', `${root}/git/ref/heads/${refPath}`])
  if (base.ref !== `refs/heads/${pr.base.ref}` || !sha(base.object?.sha)) throw new Error('invalid base ref')
  const scope = {
    repositoryId: repository.id,
    pullRequestId: pr.id,
    pullRequest: prNumber,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseSha: base.object.sha,
    authorId: pr.user.id,
  }
  return scope
}
function commentsNext(headers, root, prNumber, page) {
  const lines = headers.split(/\r?\n/).filter((line) => /^link:/i.test(line))
  if (lines.length > 1) throw new Error('ambiguous pagination headers')
  if (!lines.length) return false
  const links = lines[0].slice(lines[0].indexOf(':') + 1).split(',')
  let next = false
  for (const link of links) {
    const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (!match) throw new Error('invalid pagination link')
    if (match[2] !== 'next') continue
    if (next) throw new Error('duplicate pagination link')
    const url = new URL(match[1])
    if (
      url.protocol !== 'https:' ||
      !url.pathname.endsWith(`/${root}/issues/${prNumber}/comments`) ||
      url.searchParams.get('per_page') !== '100' ||
      url.searchParams.get('page') !== String(page + 1) ||
      [...url.searchParams.keys()].length !== 2
    )
      throw new Error('invalid next page')
    next = true
  }
  return next
}
async function readComments({ cwd, gh, root, prNumber }) {
  const comments = []
  for (let page = 1; ; page++) {
    const raw = await (gh || defaultGh)(cwd, [
      'api',
      '--include',
      `${root}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    ])
    const split = raw.match(/^(HTTP\/\S+ 200[^\r\n]*\r?\n[\s\S]*?)\r?\n\r?\n([\s\S]*)$/i)
    if (!split) throw new Error('missing GitHub pagination headers')
    const part = JSON.parse(split[2])
    if (!Array.isArray(part) || part.length > 100) throw new Error('incomplete authorization comments')
    comments.push(...part)
    const next = commentsNext(split[1], root, prNumber, page)
    if (!next && part.length < 100) break
    if (next && part.length === 0) throw new Error('empty intermediate pagination page')
  }
  return comments
}
function authorizationStream(comments, policy) {
  let last = 0
  const stream = []
  for (const comment of comments) {
    if (!positive(comment?.id) || comment.id <= last) throw new Error('invalid comment ordering')
    last = comment.id
    if (
      core.classifyIssuer(comment, policy) &&
      typeof comment.body === 'string' &&
      comment.body.startsWith(core.PREFIX)
    )
      stream.push(comment)
  }
  return stream
}
async function commentProofs({ cwd, gh, stream, scope, prNumber }) {
  const proofs = {}
  for (const comment of stream.slice(-2)) {
    if (typeof comment.node_id !== 'string' || !comment.node_id) throw new Error('missing comment node ID')
    const result = await json(cwd, gh, ['api', 'graphql', '-f', `query=${query}`, '-f', `id=${comment.node_id}`])
    const node = result.data?.node
    if (
      !node ||
      node.id !== comment.node_id ||
      node.fullDatabaseId !== String(comment.id) ||
      node.repository?.fullDatabaseId !== String(scope.repositoryId) ||
      node.pullRequest?.fullDatabaseId !== String(scope.pullRequestId) ||
      node.pullRequest?.number !== prNumber ||
      !Object.hasOwn(node, 'lastEditedAt')
    )
      throw new Error('invalid comment association proof')
    proofs[comment.id] = {
      id: comment.id,
      nodeId: node.id,
      repositoryId: scope.repositoryId,
      pullRequestId: scope.pullRequestId,
      lastEditedAt: node.lastEditedAt,
    }
  }
  return proofs
}
async function inspect({ cwd, gh, repo, prNumber, policy }) {
  checkPolicy(policy)
  if (!positive(prNumber)) throw new Error('invalid pull request number')
  repo = repo || (await resolveRepository({ cwd, gh }))
  const root = route(repo)
  const scope = await readScope({ cwd, gh, root, prNumber, policy })
  const comments = await readComments({ cwd, gh, root, prNumber })
  const stream = authorizationStream(comments, policy)
  const proofs = await commentProofs({ cwd, gh, stream, scope, prNumber })
  return { repo, scope, comments, ...core.project({ comments, policy, scope, proofs }) }
}
async function readAuthorization(args) {
  const { scope, allowed, receipt, reason, previous } = await inspect(args)
  return { scope, allowed, receipt, reason, previous }
}
async function captureAuthorization(args) {
  const { scope, previous, repo } = await inspect(args)
  return { scope, previous, repo }
}
module.exports = {
  policyFromEnv,
  policyFromRepository,
  resolveRepository,
  captureAuthorization,
  readAuthorization,
  inspect,
  route,
  json,
  defaultGh,
  positive,
}
