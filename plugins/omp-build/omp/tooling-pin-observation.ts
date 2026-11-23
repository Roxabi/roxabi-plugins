import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../adapters/github/types.ts'
import { captureOrigin } from '../roxabi/feature-framing-controller-lease.ts'
import type { ToolingPinActivationProposal } from '../roxabi/uw-action-contract.ts'
import { githubRepository } from '../roxabi/uw-git-bytes.ts'
import { installedPluginIdentity, resolvePluginPin } from '../roxabi/uw-plugin-pin.ts'
import { composedHostPluginPin } from './host-plugin-pin.ts'
import { INSTALL_ROOT } from './install-root.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { featureOperationOccupied } from './omp-feature-composition.ts'
import { canonicalRepository, gitScope } from './tooling-pin-state.ts'

const VARIABLE = 'OMP_BUILD_TOOLING_SHA'
const SHA = /^[0-9a-f]{40}$/

export function assertNoOwnedWork(pi: OmpBuildExtensionApi): void {
  if (featureOperationOccupied(pi)) throw new Error('tooling-pin-work-active')
}

async function readPinCandidates(cwd: string, gh: Gh, repository: string, targetRepository: string) {
  let sharedCommit: string, candidate: string, branch: string, head: string
  try {
    sharedCommit = (await gh(cwd, ['variable', 'get', VARIABLE, '--repo', repository])).trim()
    candidate = (await gh(cwd, ['variable', 'get', VARIABLE, '--repo', targetRepository])).trim()
    const repo = JSON.parse(await gh(cwd, ['api', `repos/${repository}`]))
    branch = repo.default_branch
    const commit = JSON.parse(await gh(cwd, ['api', `repos/${repository}/commits/${encodeURIComponent(branch)}`]))
    head = commit.sha
  } catch {
    throw new Error('tooling-pin-candidate-unavailable')
  }
  if (
    !SHA.test(candidate) ||
    !SHA.test(sharedCommit) ||
    typeof branch !== 'string' ||
    !branch ||
    typeof head !== 'string' ||
    !SHA.test(head)
  )
    throw new Error('tooling-pin-candidate-missing')
  return { sharedCommit, candidate, branch, head }
}

async function verifyPinCandidates(
  cwd: string,
  gh: Gh,
  repository: string,
  candidates: { sharedCommit: string; candidate: string; head: string },
) {
  const { sharedCommit, candidate, head } = candidates
  const checkedShared = await resolvePluginPin({
    cwd,
    gh,
    trusted: { repository, commit: sharedCommit, installedRoot: INSTALL_ROOT },
  })
  if (
    checkedShared.ok ||
    checkedShared.diagnostics.length !== 1 ||
    checkedShared.diagnostics[0].code !== 'plugin-pin-mismatch'
  )
    throw new Error('tooling-pin-shared-unavailable')
  try {
    const comparison = JSON.parse(await gh(cwd, ['api', `repos/${repository}/compare/${candidate}...${head}`]))
    if (comparison.status !== 'ahead' && comparison.status !== 'identical') throw new Error('unreachable')
  } catch {
    throw new Error('tooling-pin-candidate-unreachable')
  }
  const checked = await resolvePluginPin({
    cwd,
    gh,
    trusted: { repository, commit: candidate, installedRoot: INSTALL_ROOT },
  })
  if (!checked.ok) throw new Error(checked.diagnostics.map((d) => d.code).join(', '))
  return checked.value
}

async function observeTargetScope(cwd: string, gh: Gh, sourceRepository: string) {
  const scope = gitScope(cwd)
  if (!scope) throw new Error('tooling-pin-scope-unavailable')
  const origin = githubRepository(scope.originUrl)
  if (origin === null) throw new Error('tooling-pin-target-ambiguous')
  const targetRepository = await canonicalRepository(gh, cwd)
  if (!targetRepository || origin.toLowerCase() !== targetRepository.toLowerCase())
    throw new Error('tooling-pin-target-ambiguous')
  if (targetRepository.toLowerCase() === sourceRepository.toLowerCase())
    throw new Error('tooling-pin-source-repository')
  return { scope, targetRepository }
}

export async function observeToolingPin(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  gh: Gh,
  operationId: string,
): Promise<ToolingPinActivationProposal> {
  if (ctx.agent.kind !== 'main' || ctx.agent.depth !== 0 || !ctx.hasUI || ctx.mode !== 'tui' || !ctx.ui)
    throw new Error('tooling-pin-unavailable')
  if (composedHostPluginPin(pi)) throw new Error('tooling-pin-composed')
  assertNoOwnedWork(pi)
  const identity = installedPluginIdentity()
  if (!identity.ok) throw new Error(identity.diagnostics.map((d) => d.code).join(', '))
  const { scope, targetRepository } = await observeTargetScope(ctx.cwd, gh, identity.value.repository)
  const shared = await resolvePluginPin({ cwd: ctx.cwd, gh })
  if (shared.ok) throw new Error('tooling-pin-not-needed')
  if (shared.diagnostics.length !== 1 || shared.diagnostics[0].code !== 'plugin-pin-mismatch')
    throw new Error(`tooling-pin-shared-unavailable: ${shared.diagnostics.map((d) => d.code).join(', ')}`)
  const candidates = await readPinCandidates(ctx.cwd, gh, identity.value.repository, targetRepository)
  const plugin = await verifyPinCandidates(ctx.cwd, gh, identity.value.repository, candidates)
  const { sharedCommit, branch, head } = candidates
  return Object.freeze<ToolingPinActivationProposal>({
    format: 'omp-build-tooling-pin-activation/1',
    operationId,
    plugin,
    installedRoot: INSTALL_ROOT,
    packageDigest: identity.value.packageDigest,
    scope: { targetRepository, gitCommonDir: scope.commonDir, originUrl: scope.originUrl, lifetime: 'session' },
    source: { repository: identity.value.repository, variable: VARIABLE, defaultBranch: branch, defaultHead: head },
    shared: { repository: identity.value.repository, commit: sharedCommit, status: 'mismatch' },
    origin: captureOrigin(ctx),
  })
}
