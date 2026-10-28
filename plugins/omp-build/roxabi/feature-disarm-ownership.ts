import type { Gh } from '../adapters/github/types.ts'
import { selectWorkflowBinding } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import { type Contracts, isRecord } from './feature-engine.ts'

export type SelectedMandateAuthority = { loaded: Contracts; mandate: ScopedRecordRef }

async function authenticatePullRequest(
  gh: Gh,
  cwd: string,
  repository: string,
  pr: number,
  authority: SelectedMandateAuthority | null,
): Promise<void> {
  if (authority === null) throw new Error('selected-mandate-unavailable')
  const raw = await gh(cwd, ['pr', 'view', String(pr), '--repo', repository, '--json', 'headRefName,baseRefName'])
  const native: unknown = JSON.parse(raw)
  if (
    !isRecord(native) ||
    typeof native.headRefName !== 'string' ||
    !native.headRefName ||
    typeof native.baseRefName !== 'string' ||
    !native.baseRefName
  )
    throw new Error('pull-request-metadata-unavailable')
  const scope = authority.loaded.githubScope(repository, pr)
  const histories = await authority.loaded.readComposedWorkflowHistory([scope, authority.mandate.scope], { cwd, gh })
  if (!histories.ok) throw new Error('pull-request-history-unavailable')
  const selected = selectWorkflowBinding({
    pullRequest: scope,
    histories: histories.histories,
    native: { branch: native.headRefName, base: native.baseRefName },
  })
  if (
    selected.status !== 'bound' ||
    selected.mandate.kind !== authority.mandate.kind ||
    selected.mandate.recordId !== authority.mandate.recordId ||
    selected.mandate.scope.repository !== authority.mandate.scope.repository ||
    selected.mandate.scope.target !== authority.mandate.scope.target
  )
    throw new Error('pull-request-binding-not-owned')
}

export async function authenticateOwnPullRequests(
  gh: Gh,
  cwd: string,
  repository: string,
  numbers: Set<number>,
  authority: SelectedMandateAuthority | null,
): Promise<{ numbers: Set<number>; incomplete: boolean; evidence: unknown[] }> {
  const owned = new Set<number>()
  const evidence: unknown[] =
    authority === null ? [{ status: 'unconfirmed', error: 'selected-mandate-unavailable' }] : []
  let incomplete = authority === null
  for (const pr of numbers) {
    try {
      await authenticatePullRequest(gh, cwd, repository, pr, authority)
      owned.add(pr)
      evidence.push({ pr, status: 'owned' })
    } catch (error) {
      incomplete = true
      evidence.push({
        pr,
        status: 'unconfirmed',
        error: error instanceof Error ? error.message : 'ownership-unavailable',
      })
    }
  }
  return { numbers: owned, incomplete, evidence }
}
