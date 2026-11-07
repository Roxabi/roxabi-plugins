'use strict'

const core = require('../../vendor/kit-head-authorization/index.cjs')
const {
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
} = require('./head-authorization-reader.cjs')

function sameScope(a, b, requireBaseSha = false) {
  return [
    'repositoryId',
    'pullRequestId',
    'pullRequest',
    'headSha',
    'baseRef',
    'authorId',
    ...(requireBaseSha ? ['baseSha'] : []),
  ].every((key) => a?.[key] === b?.[key])
}
async function operator(cwd, gh, policy) {
  const user = await json(cwd, gh, ['api', 'user'])
  if (
    !positive(user.id) ||
    user.type !== 'User' ||
    !policy.operatorIds.includes(user.id) ||
    user.id === policy.botUserId
  )
    throw new Error('authenticated user is not an authorized operator')
}
function matching(comments, policy, operationId) {
  return comments.filter(
    (comment) => core.classifyIssuer(comment, policy) && core.decode(comment.body)?.operationId === operationId,
  )
}
async function publish(args, record, before, kind) {
  const { cwd, gh, policy } = args
  const body = core.render(record)
  if (matching(before.comments, policy, record.operationId).length)
    throw new Error('authorization operation already exists')
  await operator(cwd, gh, policy)
  let postError
  try {
    await (gh || defaultGh)(cwd, [
      'api',
      '--method',
      'POST',
      `${route(before.repo)}/issues/${record.pullRequest}/comments`,
      '-f',
      `body=${body}`,
    ])
  } catch (error) {
    postError = error
  }
  let after
  try {
    after = await inspect({ cwd, gh, repo: before.repo, prNumber: record.pullRequest, policy })
  } catch (error) {
    throw new Error(`authorization write outcome uncertain: ${error.message}`, { cause: postError || error })
  }
  const matches = matching(after.comments, policy, record.operationId)
  if (
    matches.length !== 1 ||
    matches[0].body !== body ||
    after.receipt?.id !== matches[0].id ||
    after.receipt.body !== body ||
    !sameScope(after.scope, before.scope, record.lane === 'dependabot' || args.requireBaseSha === true) ||
    (kind === 'grant' ? !after.allowed : after.reason !== 'withdrawn')
  )
    throw new Error('authorization write not confirmed', { cause: postError })
  const createdAt = matches[0].created_at
  if (
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw new Error('authorization receipt has invalid creation time')
  return { ...after.receipt, createdAt }
}
async function issueAuthorization(args) {
  const { snapshot, lane, source, evidence, operationId } = args
  if (!snapshot?.scope) throw new Error('missing authorization snapshot')
  const before = await inspect({ ...args, repo: args.repo || snapshot.repo, prNumber: snapshot.scope.pullRequest })
  if (
    !sameScope(before.scope, snapshot.scope, lane === 'dependabot' || args.requireBaseSha === true) ||
    before.previous !== snapshot.previous
  )
    throw new Error('authorization snapshot moved')
  const s = snapshot.scope
  const record = {
    version: 1,
    kind: 'grant',
    operationId,
    repositoryId: s.repositoryId,
    pullRequestId: s.pullRequestId,
    pullRequest: s.pullRequest,
    headSha: s.headSha,
    baseRef: s.baseRef,
    baseSha: s.baseSha,
    lane,
    source,
    previous: snapshot.previous,
    evidence,
  }
  return publish(args, record, before, 'grant')
}
async function withdrawAuthorization(args) {
  const before = await inspect(args)
  const s = before.scope
  const record = {
    version: 1,
    kind: 'withdraw',
    operationId: args.operationId,
    repositoryId: s.repositoryId,
    pullRequestId: s.pullRequestId,
    pullRequest: s.pullRequest,
    headSha: s.headSha,
    baseRef: s.baseRef,
    baseSha: s.baseSha,
    lane: 'all',
    source: 'revoke',
    previous: before.previous,
    evidence: args.reason,
  }
  return publish(args, record, before, 'withdraw')
}
module.exports = {
  policyFromEnv,
  policyFromRepository,
  resolveRepository,
  captureAuthorization,
  readAuthorization,
  issueAuthorization,
  withdrawAuthorization,
}
