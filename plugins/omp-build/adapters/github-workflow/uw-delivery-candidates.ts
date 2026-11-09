import type { DecodedHistory } from '../../engine/history-schema.ts'
import { equalScope } from '../../engine/record-diagnostics.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { Result } from '../../engine/result.ts'
import type { UwDeliveryFacts } from '../../engine/uw-completion-types.ts'
import { selectWorkflowBinding } from '../../engine/workflow-pr-binding.ts'
import { selectWorkflowBindingClaims } from '../../engine/workflow-pr-binding-chain.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { readNativePullRequestFacts } from './native-facts.ts'
import type { Candidate } from './uw-delivery-enumeration.ts'

function actionFailure(code: string, message: string): Result<never> {
  return { ok: false, diagnostics: [{ code, message }] }
}

async function decodeScope(scope: Scope, options: GitHubOptions): Promise<Result<DecodedHistory>> {
  try {
    return { ok: true, value: decodeHistory(await readGitHubHistory(scope, options)) }
  } catch (error) {
    return actionFailure(
      'record-unreadable',
      `${scope.repository} ${scope.target} history is unreadable: ${error instanceof Error ? error.message : 'GitHub read failed'}`,
    )
  }
}

function mandateHomes(history: DecodedHistory): Scope[] {
  const scopes: Scope[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (record?.kind !== 'workflow-binding') continue
    const scope = record.payload.mandate.scope
    if (scopes.some((item) => item.repository === scope.repository && item.target === scope.target)) continue
    scopes.push(scope)
  }
  return scopes
}

async function resolveCandidateBinding(
  candidate: Candidate,
  pr: DecodedHistory,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
): Promise<Result<ReturnType<typeof selectWorkflowBinding>>> {
  const native = { branch: candidate.branch, base: candidate.base }
  let selected = selectWorkflowBinding({ pullRequest: candidate.scope, histories: [...loaded.values()], native })
  if (selected.status === 'incomplete') {
    for (const scope of mandateHomes(pr)) {
      if (loaded.has(`${scope.repository}\0${scope.target}`)) continue
      const read = await decodeScope(scope, options)
      if (!read.ok) return read
      loaded.set(`${scope.repository}\0${scope.target}`, read.value)
      if (!read.value.source.complete)
        return actionFailure('incomplete', `History for ${scope.repository} ${scope.target} is incomplete`)
    }
    selected = selectWorkflowBinding({ pullRequest: candidate.scope, histories: [...loaded.values()], native })
  }
  return { ok: true, value: selected }
}

async function candidateHistory(
  candidate: Candidate,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
): Promise<Result<DecodedHistory>> {
  const key = `${candidate.scope.repository}\0${candidate.scope.target}`
  const previous = loaded.get(key)
  if (previous !== undefined) return { ok: true, value: previous }
  const read = await decodeScope(candidate.scope, options)
  if (read.ok) loaded.set(key, read.value)
  return read
}

function retainCandidateMandateHomes(
  pr: DecodedHistory,
  loaded: ReadonlyMap<string, DecodedHistory>,
  kept: DecodedHistory[],
): void {
  for (const scope of mandateHomes(pr)) {
    const history = loaded.get(`${scope.repository}\0${scope.target}`)
    if (history !== undefined && !kept.includes(history)) kept.push(history)
  }
}

async function collectCandidate(
  candidate: Candidate,
  uw: Scope,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
  kept: DecodedHistory[],
): Promise<Result<boolean>> {
  const read = await candidateHistory(candidate, options, loaded)
  if (!read.ok) return read
  const pr = read.value
  if (!pr.source.complete) {
    if (!kept.includes(pr)) kept.push(pr)
    return actionFailure(
      'incomplete',
      `History for ${candidate.scope.repository} ${candidate.scope.target} is incomplete`,
    )
  }
  const claims = selectWorkflowBindingClaims({
    pullRequest: candidate.scope,
    histories: [pr],
    native: { branch: candidate.branch, base: candidate.base },
  })
  if (
    Array.isArray(claims) &&
    claims.length > 0 &&
    claims.every((record) => !equalScope(record.payload.mandate.scope, uw))
  )
    return { ok: true, value: false }
  if (!kept.includes(pr)) kept.push(pr)
  const binding = await resolveCandidateBinding(candidate, pr, options, loaded)
  retainCandidateMandateHomes(pr, loaded, kept)
  if (!binding.ok) return binding
  const selected = binding.value
  if (selected.status === 'absent') return { ok: true, value: false }
  if (selected.status !== 'bound') {
    return actionFailure(
      selected.diagnostics[0]?.code ?? 'incomplete',
      selected.diagnostics[0]?.message ?? 'Pull request binding is unresolved',
    )
  }
  if (!equalScope(selected.mandateRecord.payload.ownSpec.uw, uw)) return { ok: true, value: false }
  const home = loaded.get(`${selected.mandate.scope.repository}\0${selected.mandate.scope.target}`)
  if (home !== undefined && !kept.includes(home)) kept.push(home)
  return { ok: true, value: true }
}

async function readCandidateNative(
  candidate: Candidate,
  options: GitHubOptions,
): Promise<Result<UwDeliveryFacts['pullRequests'][number]>> {
  try {
    const number = Number(candidate.scope.target.slice(candidate.scope.target.lastIndexOf('#') + 1))
    const native = await readNativePullRequestFacts(candidate.scope.repository, number, options)
    if (native.branch !== candidate.branch || native.base !== candidate.base)
      return actionFailure('incomplete', `${candidate.scope.target} changed during delivery observation`)
    return {
      ok: true,
      value: {
        pullRequest: candidate.scope,
        branch: native.branch,
        base: native.base,
        head: native.head,
        baseTip: native.baseTip,
        state: native.state,
        mergeCommit: native.mergeCommit,
      },
    }
  } catch (error) {
    return actionFailure(
      'record-unreadable',
      `${candidate.scope.target} native facts: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function collectDeliveryCandidates(
  items: readonly Candidate[],
  uw: Scope,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
  kept: DecodedHistory[],
  pulls: UwDeliveryFacts['pullRequests'][number][],
): Promise<Result<void>> {
  for (const candidate of items) {
    if (candidate.scope.repository !== uw.repository)
      return actionFailure(
        'incomplete',
        `Pull request ${candidate.scope.target} repository does not match canonical ${uw.repository}`,
      )
    const binding = await collectCandidate(candidate, uw, options, loaded, kept)
    if (!binding.ok) return binding
    if (!binding.value) continue
    const native = await readCandidateNative(candidate, options)
    if (!native.ok) return native
    pulls.push(native.value)
  }
  return { ok: true, value: undefined }
}
