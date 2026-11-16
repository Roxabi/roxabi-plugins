import {
  bindExternalRef,
  discoverSelectedRecoveryOwner,
  type GitHubOptions,
  githubScope,
  readWorkflowBinding,
} from '../dist/contracts.js'
import { failure } from './fix-contract.ts'
import { createIssueAliasReadPort } from './fix-entry-issue-alias.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'
import { type Gh, object } from './fix-entry-target-core.ts'
import { createResolver } from './fix-entry-target-resolver.ts'
import { observeFixOwnerAdmission } from './fix-owner-admission-observation.ts'
import type { UwReadPort } from './uw-contract.ts'

async function resolveRecoveryTarget(input: { cwd: string; pr: string; gh: Gh; github: GitHubOptions }) {
  const repo = object(JSON.parse(await input.gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
  if (repo === null || typeof repo.nameWithOwner !== 'string') return failure('fix-recovery-repository-unavailable')
  const repository = repo.nameWithOwner
  const resolver = createResolver(input.cwd, input.gh, repository, createIssueAliasReadPort(input.github))
  const resolved = await resolver.resolveExplicit(input.pr)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (target === null || target.state !== 'open') return failure('fix-recovery-target-unavailable')
  const binding = await resolvePublishBinding(input.cwd, input.gh, repository, target)
  if (!binding.ok) return binding
  const pullRequest = githubScope(repository, target.number)
  const workflow = await readWorkflowBinding(pullRequest, input.github)
  if (!workflow.ok || workflow.value.binding.kind !== 'workflow-binding')
    return failure('fix-recovery-binding-unavailable')
  return {
    ok: true as const,
    value: {
      repository,
      resolver,
      target,
      binding: binding.value,
      pullRequest,
      uw: workflow.value.binding.payload.mandate.scope,
    },
  }
}

/** Resolve an actual PR and current binding before a lease; returned facts are not execution authority. */
export async function resolveRecoveryEntry(input: {
  cwd: string
  pr: string
  gh: Gh
  github: GitHubOptions
  reader: UwReadPort
}) {
  try {
    const resolved = await resolveRecoveryTarget(input)
    if (!resolved.ok) return resolved
    const { repository, resolver, target, binding, pullRequest, uw } = resolved.value
    const observed = await observeFixOwnerAdmission({
      uw,
      pullRequest,
      destination: binding.destination,
      intent: 'recovery',
      github: input.github,
      reader: input.reader,
    })
    if (!observed.ok) return observed
    if (observed.value.admission.status !== 'recovery') return failure('fix-recovery-owner-unavailable')
    const admission = observed.value.admission
    const home = observed.value.histories.find(
      (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
    )
    if (home === undefined) return failure('fix-recovery-owner-history-unavailable')
    const opening = bindExternalRef(admission.opened, home)
    const settlement = bindExternalRef(admission.settled, home)
    if (
      !opening.ok ||
      opening.value.kind !== 'fix-owner' ||
      opening.value.payload.phase !== 'opened' ||
      !settlement.ok ||
      settlement.value.kind !== 'fix-owner' ||
      settlement.value.payload.phase !== 'settled'
    )
      return failure('fix-recovery-owner-unconfirmed')
    const discovery = discoverSelectedRecoveryOwner({
      uw,
      histories: observed.value.histories,
      graph: observed.value.current.graph,
      opened: admission.opened,
    })
    if (discovery.status !== 'interrupted') return failure('fix-recovery-anchor-unavailable')
    const refreshTarget = async () => {
      const refreshed = await resolver.resolveExplicit(target.target)
      if (!refreshed.ok) return refreshed
      if (refreshed.value === null) return failure('fix-recovery-target-unavailable')
      const next = await resolvePublishBinding(input.cwd, input.gh, repository, refreshed.value)
      return next.ok ? { ok: true as const, value: { target: refreshed.value, binding: next.value } } : next
    }
    return {
      ok: true as const,
      value: {
        uw,
        target,
        binding,
        pullRequest,
        admission,
        opening: { ...opening.value, payload: opening.value.payload },
        settlement: { ...settlement.value, payload: settlement.value.payload },
        discovery,
        resolver,
        refreshTarget,
        histories: observed.value.histories,
      },
    }
  } catch (error) {
    return failure('fix-recovery-target-unreadable', error instanceof Error ? error.message : String(error))
  }
}
