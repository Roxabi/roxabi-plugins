import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { refreshLandingAuthorization } from './landing-initial.js'
import { readReviewHistory } from './workflow-records.js'
import { gh, gitResult } from './workflow-runtime.js'

const require = createRequire(import.meta.url)
const authorization = require('./head-authorization.cjs')

function argumentsFor(argv) {
  const [command, ...rest] = argv
  const allowed = {
    inspect: ['pr'],
    withdraw: ['pr', 'reason'],
    'issue-manual': ['pr', 'head', 'evidence'],
  }[command]
  if (!allowed || rest.length !== allowed.length * 2) throw new Error('invalid command or arguments')
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].startsWith('--') ? rest[index].slice(2) : ''
    const value = rest[index + 1]
    if (!allowed.includes(key) || Object.hasOwn(values, key) || !value || !value.trim()) {
      throw new Error('invalid command or arguments')
    }
    values[key] = value
  }
  if (!/^[1-9]\d*$/.test(values.pr) || !Number.isSafeInteger(Number(values.pr))) throw new Error('invalid PR number')
  if (command === 'issue-manual' && !/^[0-9a-f]{40}$/.test(values.head))
    throw new Error('head must be a lowercase 40-character SHA')
  return { command, ...values, pr: Number(values.pr) }
}

async function requireNativeAdmission(input, common, snapshot, options) {
  const { cwd, gh: ghFn } = common
  const git = options.git ?? gitResult
  const history = await (options.readHistory ?? readReviewHistory)(cwd, input.pr, ghFn)
  if (
    !history?.source?.complete ||
    !Array.isArray(history.source.diagnostics) ||
    history.source.diagnostics.length ||
    !Array.isArray(history.diagnostics) ||
    history.diagnostics.length ||
    !Array.isArray(history.operations)
  ) {
    throw new Error('native ownership history is incomplete or invalid')
  }
  if (history.operations.length) {
    const scope = snapshot.scope
    const state = {
      records: { head: scope.headSha },
      landingBase: scope.baseRef,
      landingContext: { name: scope.baseRef, tip: scope.baseSha },
    }
    const admitted = await (options.refreshAdmission ?? refreshLandingAuthorization)(
      cwd,
      input.pr,
      ghFn,
      git,
      state,
      false,
    )
    if (admitted.terminal || admitted.state?.admitted !== input.head || admitted.state?.records?.head !== input.head) {
      throw new Error('native owner did not admit the reviewed head')
    }
  }
  return history.operations.length > 0
}

async function issueManual(input, common, api, options, operationId) {
  const { cwd, gh: ghFn, repo, policy } = common
  const snapshot = await api.captureAuthorization(common)
  if (snapshot.scope.headSha !== input.head) throw new Error('reviewed head does not match current PR head')
  const requireBaseSha = await requireNativeAdmission(input, common, snapshot, options)
  // Once issuance is invoked, a lost POST response may still leave a live grant.
  const attempt = {
    repo,
    prNumber: input.pr,
    snapshot,
    lane: 'reviewed',
    source: 'manual',
    evidence: input.evidence,
    operationId,
  }
  try {
    return await api.issueAuthorization({
      cwd,
      gh: ghFn,
      policy,
      ...attempt,
      requireBaseSha,
    })
  } catch (cause) {
    const withdrawalOperationId = randomUUID()
    try {
      await api.withdrawAuthorization({
        ...common,
        operationId: withdrawalOperationId,
        reason: 'manual grant issuance failed',
      })
    } catch (withdrawalError) {
      const error = new Error(
        `manual grant outcome uncertain; withdrawal unconfirmed (repository ${repo.owner}/${repo.repo}, PR ${input.pr}, grant operation ${operationId}, withdrawal operation ${withdrawalOperationId}): ${withdrawalError instanceof Error ? withdrawalError.message : String(withdrawalError)}; original error: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
      error.attempt = attempt
      error.withdrawalOperationId = withdrawalOperationId
      error.withdrawalError = withdrawalError
      throw error
    }
    const error = new Error(
      `manual grant issuance failed; withdrawal confirmed (repository ${repo.owner}/${repo.repo}, PR ${input.pr}, grant operation ${operationId}, withdrawal operation ${withdrawalOperationId}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    error.attempt = attempt
    error.withdrawalOperationId = withdrawalOperationId
    throw error
  }
}

export async function runHeadAuthorization(argv, options = {}) {
  const input = argumentsFor(argv)
  const cwd = options.cwd ?? process.cwd()
  const api = options.authorization ?? authorization
  const ghFn = options.gh ?? gh
  const repo = await api.resolveRepository({ cwd, gh: ghFn })
  const policy = await api.policyFromRepository({ cwd, gh: ghFn, repo })
  if (!policy) throw new Error('repository authorization policy is not configured')
  const common = { cwd, gh: ghFn, repo, prNumber: input.pr, policy }
  if (input.command === 'inspect') return api.readAuthorization(common)
  const operationId = (options.operationId ?? randomUUID)()
  if (input.command === 'withdraw') return api.withdrawAuthorization({ ...common, operationId, reason: input.reason })
  return issueManual(input, common, api, options, operationId)
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runHeadAuthorization(process.argv.slice(2))))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
