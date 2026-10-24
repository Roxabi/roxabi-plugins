#!/usr/bin/env bun
/**
 * Producer run for landing admission. It reuses a current binding proof or
 * captures and publishes producer-native proof without making an admission.
 *
 *   bun proof-acquire.ts --pr <N> [--assertledger-manifest <manifest.json>]
 *
 * stdout is one JSON line with each producer reported as `not-applicable`,
 * `reused`, or `posted`; protocol failures post no successful result.
 */
import { decodeHistory, githubScope, readGitHubHistory } from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { acquireAssertledger } from './proof-acquire-assertledger'
import { type BindingMandate, bindingOf, parseArgs } from './proof-acquire-binding'
import { acquireSemctx } from './proof-acquire-semctx'
import { assertCurrent, type Context, gh, ProtocolError, refusalText } from './proof-acquire-tools'
import { assertledgerApplies } from './proof-assertledger'
import { isMap, pinsFromApplicableMandate, repositoryOf } from './proof-base'
import { candidateFacts, refreshSelectedBase } from './proof-candidate'
import { compareApplicableProofPins } from './proof-pins'
import { gitResult } from './workflow-runtime.js'

type PullRequest = { candidate: string; branch: string; base: string }

async function openPullRequest(cwd: string, pr: number): Promise<PullRequest> {
  const view: unknown = JSON.parse(
    await gh(cwd, ['pr', 'view', String(pr), '--json', 'headRefOid,headRefName,baseRefName,state']),
  )
  const candidate = isMap(view) ? view.headRefOid : undefined
  const branch = isMap(view) ? view.headRefName : undefined
  const base = isMap(view) ? view.baseRefName : undefined
  const state = isMap(view) ? view.state : undefined
  if (typeof candidate !== 'string' || typeof branch !== 'string' || typeof base !== 'string' || state !== 'OPEN') {
    throw new ProtocolError(`PR #${pr} is not an open PR with a head and a base`)
  }
  return { candidate, branch, base }
}

async function prepareContext(
  cwd: string,
  pr: number,
  request: PullRequest,
): Promise<{ ctx: Context; branch: string }> {
  const selected = await refreshSelectedBase(cwd, request.base, gitResult, gh)
  if (!selected.ok) throw new ProtocolError(refusalText(selected))
  const facts = await candidateFacts(cwd, request.candidate, request.base, selected.tip, gitResult)
  if ('ok' in facts) throw new ProtocolError(refusalText(facts))
  const repository = await repositoryOf(gh, cwd)
  const scope = githubScope(repository, pr)
  const history = decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, gh })))
  if (!history.source.complete)
    throw new ProtocolError(`the complete common record history for PR #${pr} could not be read`)
  return {
    ctx: {
      cwd,
      pr,
      candidate: request.candidate,
      base: request.base,
      baseTip: selected.tip,
      repository,
      history,
      facts,
    },
    branch: request.branch,
  }
}

function bindingFromOperation(
  operation: Context['history']['operations'][number],
  repository: string,
  pr: number,
): BindingMandate | undefined {
  const claimsBinding = operation.claimedKinds.includes('workflow-binding')
  const record = operation.record
  if (claimsBinding && (operation.status !== 'complete' || record === null || operation.authority === 'foreign')) {
    throw new ProtocolError('workflow binding is incomplete')
  }
  if (record?.kind !== 'workflow-binding') return
  if (operation.status !== 'complete' || operation.authority === 'foreign') {
    throw new ProtocolError('workflow binding is incomplete')
  }
  const scope = githubScope(repository, pr)
  if (record.repository !== scope.repository || record.target !== scope.target) {
    throw new ProtocolError('workflow binding scope is not this pull request')
  }
  const parsed = bindingOf(record)
  if (parsed === null || parsed === 'malformed')
    throw new ProtocolError('workflow binding payload is not a mandate ref')
  return parsed
}

function workflowBinding(history: Context['history'], repository: string, pr: number): BindingMandate | undefined {
  const bindings: BindingMandate[] = []
  for (const operation of history.operations) {
    const binding = bindingFromOperation(operation, repository, pr)
    if (binding) bindings.push(binding)
  }
  if (bindings.length > 1) throw new ProtocolError('workflow binding conflicts')
  return bindings[0]
}

async function validateBinding(binding: BindingMandate | undefined, branch: string, ctx: Context): Promise<void> {
  if (!binding) return
  if (binding.branch !== branch || binding.base !== ctx.base) {
    throw new ProtocolError('workflow binding branch or base does not match the pull request')
  }
  const policy = withRoxabiGitHubPolicy({ cwd: ctx.cwd, gh })
  const mandateHistory = decodeHistory(await readGitHubHistory(binding.scope, policy))
  if (!mandateHistory.source.complete) throw new ProtocolError('bound mandate history is incomplete')
  const mandateRecord = mandateHistory.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority !== 'foreign' &&
      operation.record?.recordId === binding.recordId,
  )?.record
  if (mandateRecord?.kind !== 'mandate') {
    throw new ProtocolError('bound mandate record is not confirmed')
  }
  const parentRef = mandateRecord.payload.parent
  const external = parentRef === null ? [] : [decodeHistory(await readGitHubHistory(parentRef.scope, policy))]
  if (external.some((item) => !item.source.complete)) throw new ProtocolError('parent mandate history is incomplete')
  const pins = pinsFromApplicableMandate(mandateHistory, external)
  if (pins === null) return
  if (!Array.isArray(pins)) throw new ProtocolError(pins.error)
  const drifted = await compareApplicableProofPins(gitResult, ctx.facts, pins)
  if (!drifted.ok) throw new ProtocolError(drifted.error)
}

async function acquireProducers(
  ctx: Context,
  ledger: boolean,
  manifest: string | undefined,
): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    pr: ctx.pr,
    candidate: ctx.candidate,
    semctx: 'not-applicable',
    assertledger: 'not-applicable',
  }
  if (ctx.facts.semctx === 'configured') {
    const acquired = await acquireSemctx(ctx)
    report.semctx = acquired.outcome
    report.semctxAssessment = acquired.assessment
  }
  if (ledger) report.assertledger = await acquireAssertledger(ctx, manifest)
  else if (manifest !== undefined)
    console.error(`assertledger does not apply to PR #${ctx.pr}: the manifest was not posted`)
  return report
}

export async function main(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs(argv)
  if (!args) {
    console.error('usage: bun proof-acquire.ts --pr <N> [--assertledger-manifest <manifest.json>]')
    return 2
  }
  try {
    const request = await openPullRequest(cwd, args.pr)
    const { ctx, branch } = await prepareContext(cwd, args.pr, request)
    const binding = workflowBinding(ctx.history, ctx.repository, ctx.pr)
    await validateBinding(binding, branch, ctx)
    const ledger = await assertledgerApplies(cwd, ctx.facts, { pr: args.pr }, { gh, git: gitResult }, ctx.repository)
    if (typeof ledger === 'object') throw new ProtocolError(refusalText(ledger))
    await assertCurrent(ctx)
    const report = await acquireProducers(ctx, ledger, args.manifest)
    await assertCurrent(ctx)
    console.log(JSON.stringify(report))
    return 0
  } catch (error) {
    console.error(`proof-acquire: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd()))
