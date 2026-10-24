import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import { explicitParentHistories } from './feature-context.ts'
import { type Contracts, type History, loadContracts } from './feature-engine.ts'

const execFileAsync = promisify(execFile)

function defaultGh(): Gh {
  return async (cwd, args) => {
    const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return out.stdout
  }
}

function bindingMatches(payload: Record<string, unknown>, mandateId: string, branch: string, base: string): boolean {
  const mandate = payload.mandate
  if (mandate === null || typeof mandate !== 'object' || !('recordId' in mandate)) return false
  return mandate.recordId === mandateId && payload.branch === branch && payload.base === base
}

type BindingFailure = { ok: false; reason: string }

async function readNativeBindingTarget(
  input: { cwd: string; pr: number; branch: string; base: string },
  gh: Gh,
): Promise<BindingFailure | { ok: true; repository: string }> {
  const repoRaw = await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  const repoParsed: unknown = JSON.parse(repoRaw)
  if (repoParsed === null || typeof repoParsed !== 'object' || !('nameWithOwner' in repoParsed)) {
    return { ok: false, reason: 'repository-unreadable' }
  }
  if (typeof repoParsed.nameWithOwner !== 'string') return { ok: false, reason: 'repository-unreadable' }
  const repository = repoParsed.nameWithOwner
  const prRaw = await gh(input.cwd, [
    'pr',
    'view',
    String(input.pr),
    '--repo',
    repository,
    '--json',
    'headRefName,baseRefName',
  ])
  const prParsed: unknown = JSON.parse(prRaw)
  if (
    prParsed === null ||
    typeof prParsed !== 'object' ||
    !('headRefName' in prParsed) ||
    !('baseRefName' in prParsed)
  ) {
    return { ok: false, reason: 'native-metadata-unreadable' }
  }
  return prParsed.headRefName === input.branch && prParsed.baseRefName === input.base
    ? { ok: true, repository }
    : { ok: false, reason: 'native-metadata-mismatch' }
}

async function readBindingContext(
  loaded: Contracts,
  input: { cwd: string; pr: number; issue: number },
  gh: Gh,
  repository: string,
) {
  const issueScope = loaded.githubScope(repository, input.issue)
  const prScope = loaded.githubScope(repository, input.pr)
  const issueHistory = await loaded.readComposedWorkflowHistory([issueScope], { cwd: input.cwd, gh })
  if (!issueHistory.ok) return { ok: false as const, reason: issueHistory.reason }
  const issueRecord = issueHistory.histories[0]
  if (!issueRecord) return { ok: false as const, reason: 'incomplete' }
  const localMandate =
    [...issueRecord.operations]
      .reverse()
      .find((operation) => operation.status === 'complete' && operation.record?.kind === 'mandate')?.record ?? null
  const parents = await explicitParentHistories(loaded, localMandate, { cwd: input.cwd, gh })
  if (!parents.ok) return { ok: false as const, reason: parents.reason }
  const selected = loaded.selectApplicableMandate(issueRecord, [...issueHistory.histories.slice(1), ...parents.parents])
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { ok: false as const, reason: selected.status === 'refused' ? selected.reason : 'mandate-missing' }
  }
  const prHistory = await loaded.readComposedWorkflowHistory([prScope], { cwd: input.cwd, gh })
  if (!prHistory.ok) return { ok: false as const, reason: prHistory.reason }
  const history = prHistory.histories[0]
  if (!history) return { ok: false as const, reason: 'incomplete' }
  return { ok: true as const, issueScope, prScope, issueHistory, parents, history, mandate: selected.mandate }
}

function bindingRecords(history: History) {
  return history.operations.flatMap((operation) => {
    const record = operation.record
    return record === null || record.kind !== 'workflow-binding'
      ? []
      : [{ status: operation.status, recordId: record.recordId, payload: record.payload }]
  })
}

/**
 * Publish the one PR-to-mandate association after native head/base match.
 * A confirmed matching record is reused. A conflict is not replaced.
 */
export async function confirmWorkflowBinding(input: {
  cwd: string
  pr: number
  issue: number
  branch: string
  base: string
  gh?: Gh
}): Promise<{ ok: true; recordId: string } | { ok: false; reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { ok: false, reason: `engine-unavailable:${loaded.missing}` }
  const gh = input.gh ?? defaultGh()
  const native = await readNativeBindingTarget(input, gh)
  if (!native.ok) return native
  const context = await readBindingContext(loaded, input, gh, native.repository)
  if (!context.ok) return context
  const bindings = bindingRecords(context.history)
  if (bindings.some((item) => item.status !== 'complete')) return { ok: false, reason: 'binding-partial' }
  const matches = bindings.filter((item) =>
    bindingMatches(item.payload, context.mandate.recordId, input.branch, input.base),
  )
  if (bindings.length > 1 || (bindings.length === 1 && matches.length === 0)) {
    return { ok: false, reason: 'binding-conflict' }
  }
  const existing = matches[0]
  if (existing) return { ok: true, recordId: existing.recordId }
  const recordId = `workflow-binding:${context.prScope.target}:${context.mandate.recordId}`
  const built = loaded.buildRecord({
    repository: context.prScope.repository,
    target: context.prScope.target,
    version: 1,
    recordId,
    runId: recordId,
    operationId: recordId,
    kind: 'workflow-binding',
    payload: {
      mandate: { scope: context.issueScope, recordId: context.mandate.recordId, kind: 'mandate' },
      branch: input.branch,
      base: input.base,
    },
  })
  if (!built.ok) return { ok: false, reason: built.diagnostics.map((item) => item.code).join(',') || 'record-invalid' }
  const published = await loaded.publishConfirmedWorkflowRecord(
    built.value,
    context.history,
    { cwd: input.cwd, gh },
    null,
    [...context.issueHistory.histories, ...context.parents.parents],
  )
  return published.status === 'confirmed' ? { ok: true, recordId } : { ok: false, reason: published.status }
}
