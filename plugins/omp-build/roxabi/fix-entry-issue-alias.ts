import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { decodeHistory, githubScope, readGitHubHistory, readWorkflowBinding } from '../dist/contracts.js'
import { discoverDeliveryPr } from './feature-delivery-discovery.ts'
import { confirmedWorkflowBinding, sameScope } from './fix-checkpoint-binding.ts'
import type { FixActionResult } from './fix-contract.ts'
import { execFileAsync, fail, type Gh, object } from './fix-entry-target-core.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'

export type IssueAliasReadPort = {
  readHistory(scope: Scope): Promise<DecodedHistory>
  readBinding(scope: Scope): Promise<unknown | null>
}

export function createIssueAliasReadPort(options: GitHubOptions): IssueAliasReadPort {
  return {
    readHistory: async (scope) => decodeHistory(await readGitHubHistory(scope, options)),
    readBinding: async (scope) => {
      const result = await readWorkflowBinding(scope, options)
      return result.ok ? result.value : null
    },
  }
}

async function aliasMandate(
  scope: Scope,
  port: IssueAliasReadPort,
): Promise<FixActionResult<{ branch: string; base: string; recordId: string }>> {
  let history: DecodedHistory
  try {
    history = await port.readHistory(scope)
  } catch {
    return fail('fix-issue-alias-no-mandate')
  }
  if (!history.source.complete || !sameScope(history.source.scope, scope)) return fail('fix-issue-alias-no-mandate')
  const mandate = currentAccountedMandate(history)
  if (!mandate.ok)
    return fail(
      mandate.diagnostics.some((item) => item.code === 'action-input-cycle')
        ? 'fix-issue-alias-ambiguous'
        : 'fix-issue-alias-no-mandate',
    )
  const { branch, base } = mandate.value.payload
  if (!branch || !base) return fail('fix-issue-alias-no-branch')
  return { ok: true, value: { branch, base, recordId: mandate.value.recordId } }
}

async function aliasCandidate(
  cwd: string,
  gh: Gh,
  repository: string,
  branch: string,
  base: string,
): Promise<FixActionResult<number>> {
  const discovered = await discoverDeliveryPr(gh, cwd, repository, branch, base)
  if (!discovered.ok) {
    switch (discovered.reason) {
      case 'pr-discovery-ambiguous':
        return fail('fix-issue-alias-ambiguous')
      case 'pr-discovery-incomplete':
        return fail('fix-issue-alias-incomplete')
      case 'pr-discovery-closed':
        return fail('fix-issue-alias-closed')
      default:
        return fail('fix-issue-alias-no-pr')
    }
  }
  if (discovered.number === null) return fail('fix-issue-alias-no-pr')
  return { ok: true, value: discovered.number }
}

async function aliasBranch(cwd: string, gh: Gh, number: number, branch: string): Promise<FixActionResult<void>> {
  let details: Record<string, unknown> | null
  try {
    details = object(JSON.parse(await gh(cwd, ['pr', 'view', String(number), '--json', 'state,headRefName'])))
  } catch {
    return fail('fix-issue-alias-no-pr')
  }
  if (details?.state === 'MERGED') return fail('fix-issue-alias-merged')
  if (details?.state !== 'OPEN') return fail('fix-issue-alias-closed')
  try {
    const local = await execFileAsync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' })
    if (String(local.stdout).trim() !== branch || details.headRefName !== branch)
      return fail('fix-issue-alias-branch-mismatch')
  } catch {
    return fail('fix-issue-alias-branch-mismatch')
  }
  return { ok: true, value: undefined }
}

async function aliasBinding(
  scope: Scope,
  mandateId: string,
  pull: Scope,
  port: IssueAliasReadPort,
): Promise<FixActionResult<void>> {
  try {
    const binding = await port.readBinding(pull)
    if (binding === null) return fail('fix-issue-alias-binding-missing')
    const confirmed = confirmedWorkflowBinding(binding)
    if (confirmed === null || !confirmed.history.source.complete) return fail('fix-issue-alias-binding-missing')
    if (!sameScope(confirmed.mandateScope, scope) || confirmed.mandateRecordId !== mandateId)
      return fail('fix-issue-alias-binding-mismatch')
  } catch {
    return fail('fix-issue-alias-binding-missing')
  }
  return { ok: true, value: undefined }
}

export async function resolveIssueAlias(
  cwd: string,
  gh: Gh,
  repository: string,
  number: number,
  port: IssueAliasReadPort,
): Promise<FixActionResult<number>> {
  const scope = githubScope(repository, number)
  const mandate = await aliasMandate(scope, port)
  if (!mandate.ok) return mandate
  const candidate = await aliasCandidate(cwd, gh, repository, mandate.value.branch, mandate.value.base)
  if (!candidate.ok) return candidate
  const branch = await aliasBranch(cwd, gh, candidate.value, mandate.value.branch)
  if (!branch.ok) return branch
  const binding = await aliasBinding(scope, mandate.value.recordId, githubScope(repository, candidate.value), port)
  if (!binding.ok) return binding
  return candidate
}
