import type { Gh } from '../adapters/github/types.ts'
import type { CanonicalRecord, DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest, discoverSelectedRecoveryOwner } from '../dist/contracts.js'
import type { FixRecoveryCurrentFacts } from '../engine/fix-recovery-observation.ts'
import type {
  Destination,
  FixOwnerOpenedPayload,
  FixOwnerSettledPayload,
  RootLifetime,
} from '../engine/fix-recovery-schema.ts'
import type { DestinationAdmissionLease } from '../omp/review-runtime/destination-admission-lease.ts'
import type { FixActionResult, FixTarget, PublishBinding } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { object } from './fix-entry-target-core.ts'
import { readFixOwnerHistories } from './fix-owner-admission-observation.ts'
import { readRecoveryDecisionCatalogues } from './fix-recovery-catalogue.ts'
import { observeRecoveryConfiguration } from './fix-recovery-configuration.ts'
import { observeRecoveryGit } from './fix-recovery-git-observation.ts'
import { observeRecoveryOwner } from './fix-recovery-owner-observation.ts'
import { observeRecoveryPlugin } from './fix-recovery-plugin-observation.ts'
import { pinRecoveryRecord } from './fix-recovery-record-pin.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { UwReadPort } from './uw-contract.ts'

type Owner = Extract<CanonicalRecord, { kind: 'fix-owner' }>
type Opened = Owner & { payload: FixOwnerOpenedPayload }
type Settled = Owner & { payload: FixOwnerSettledPayload }

/** Fresh native PR, Git, authority, plugin, process and raw-history facts, not recovery eligibility. */
export async function readFixRecoveryCurrent(input: {
  uw: Scope
  opening: Opened
  settlement: Settled
  cwd: string
  github: GitHubOptions
  gh: Gh
  reader: UwReadPort
  lease: DestinationAdmissionLease
  root: RootLifetime
  rootCurrent: () => boolean
  trustedPlugin?: TrustedHostPluginPin
  decision?: Extract<CanonicalRecord, { kind: 'decision' }>
  refreshTarget: () => Promise<
    FixActionResult<{ target: FixTarget; binding: PublishBinding & { destination: Destination } }>
  >
}): Promise<
  FixActionResult<{
    histories: DecodedHistory[]
    graph: Awaited<ReturnType<UwReadPort['readUw']>>['graph']
    current: FixRecoveryCurrentFacts
  }>
> {
  const refreshed = await input.refreshTarget()
  if (!refreshed.ok) return refreshed
  const { target, binding } = refreshed.value
  if (target.state !== 'open' || target.candidateGitSHA === null || target.baseGitSHA === null)
    return failure('fix-recovery-pull-request-unavailable')
  const native = object(object(binding.observed)?.pr)
  if (
    native === null ||
    typeof native.headRepository !== 'string' ||
    typeof native.headRefName !== 'string' ||
    typeof native.baseRefName !== 'string'
  )
    return failure('fix-recovery-pull-request-unavailable')
  const pullRequest = { repository: target.repository, target: target.target }
  const read = await readFixOwnerHistories({ uw: input.uw, pullRequest, github: input.github, reader: input.reader })
  if (!read.ok) return read
  const histories = read.value.histories
  const common = input.opening.payload.common
  const validateAuthority = (): FixActionResult<void> => {
    const ownerHome = histories.find(
      (history) =>
        history.source.scope.repository === common.uw.repository && history.source.scope.target === common.uw.target,
    )
    if (ownerHome === undefined) return failure('fix-recovery-current-authority-unconfirmed')
    const opening = bindExternalRef(
      { scope: common.uw, kind: 'fix-owner', recordId: input.opening.recordId },
      ownerHome,
    )
    const settlement = bindExternalRef(
      { scope: common.uw, kind: 'fix-owner', recordId: input.settlement.recordId },
      ownerHome,
    )
    if (
      !opening.ok ||
      !settlement.ok ||
      canonicalValueDigest(opening.value) !== canonicalValueDigest(input.opening) ||
      canonicalValueDigest(settlement.value) !== canonicalValueDigest(input.settlement)
    )
      return failure('fix-recovery-current-authority-unconfirmed')
    const discovery = discoverSelectedRecoveryOwner({
      uw: input.uw,
      histories,
      graph: read.value.current.graph,
      opened: { scope: common.uw, kind: 'fix-owner', recordId: input.opening.recordId },
    })
    if (
      discovery.status !== 'interrupted' ||
      discovery.settled.recordId !== input.settlement.recordId ||
      discovery.settled.scope.repository !== input.settlement.repository ||
      discovery.settled.scope.target !== input.settlement.target
    )
      return failure(
        'fix-recovery-current-authority-unconfirmed',
        ...(discovery.status === 'blocked'
          ? discovery.diagnostics.flatMap((item) => [item.code, `${item.code}:${item.message}`])
          : []),
      )
    return { ok: true, value: undefined }
  }
  const authority = validateAuthority()
  if (!authority.ok) return authority
  const [plugin, config, local, host] = await Promise.all([
    observeRecoveryPlugin({
      opening: input.opening.payload,
      cwd: input.cwd,
      gh: input.gh,
      trusted: input.trustedPlugin,
    }),
    observeRecoveryConfiguration({
      opening: input.opening.payload,
      histories,
      cwd: input.cwd,
      candidateGitSHA: target.candidateGitSHA,
    }),
    observeRecoveryGit({ cwd: input.cwd, target, publishBinding: binding }),
    observeRecoveryOwner({
      opening: input.opening,
      settlement: input.settlement,
      histories,
      lease: input.lease,
      root: input.root,
      rootCurrent: input.rootCurrent,
    }),
  ])
  // Discovery has independently resolved the current effective Spec against the native graph and
  // compared its complete authenticated vector to this opening; this is not an admission grant.
  if (!plugin.ok) return plugin
  if (!config.ok) return config
  if (!local.ok) return local
  if (!host.ok) return host
  const bindingPin = pinRecoveryRecord({ ...common.binding, histories })
  if (!bindingPin.ok) return bindingPin
  const mandatePin = pinRecoveryRecord({ ...common.mandate, histories })
  if (!mandatePin.ok) return mandatePin
  const loadCatalogues = async (): Promise<FixActionResult<FixRecoveryCurrentFacts['catalogues']>> => {
    const decision = input.decision
    if (decision === undefined) return { ok: true, value: undefined }
    const home = histories.find(
      (history) =>
        history.source.scope.repository === decision.repository && history.source.scope.target === decision.target,
    )
    if (home === undefined) return failure('fix-recovery-decision-history-unavailable')
    return readRecoveryDecisionCatalogues({ decision, history: home, cwd: input.cwd, gh: input.gh })
  }
  const cataloguesResult = await loadCatalogues()
  if (!cataloguesResult.ok) return cataloguesResult
  const catalogues = cataloguesResult.value
  return {
    ok: true,
    value: {
      histories,
      graph: read.value.current.graph,
      current: {
        authority: {
          binding: bindingPin.value,
          mandate: mandatePin.value,
          plugin: plugin.value,
          configuration: config.value,
          accepted: common.accepted,
        },
        pullRequest: {
          scope: pullRequest,
          state: 'open',
          candidateGitSHA: target.candidateGitSHA,
          baseGitSHA: target.baseGitSHA,
          headRepository: native.headRepository,
          branch: native.headRefName,
          base: native.baseRefName,
          destination: binding.destination,
        },
        local: local.value,
        host: host.value,
        ...(catalogues === undefined ? {} : { catalogues }),
      },
    },
  }
}
