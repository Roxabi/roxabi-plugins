import {
  type DecodedHistory,
  effectiveMandateRole,
  githubScope,
  resolveAcceptedSpec,
  selectApplicableMandate,
} from '../../dist/contracts.js'
import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import type { AcceptedChildCommitment } from '../../engine/workflow-mandate-schema.ts'
import { configCompatibility } from '../../roxabi/workflow-overrides.ts'
import { gather } from './epic-driver-gather'
import { historyFor, issueHistory, repoName } from './epic-driver-github'
import { Assisted, currentEpicEffects, Refused } from './epic-driver-runtime'
import { frameEpic } from './epic-frame'
import { BASE_NAME, RUN_ID } from './epic-naming'
import { hasFramedOwnUw, ownUwRefusal } from './epic-own-uw'
import { isDone } from './epic-progress'
import type { Facts } from './epic-types'

// ── Confirmed mandate ─────────────────────────────────────────────────────────

export type EpicChildGrant = AcceptedChildCommitment

export type EpicAuthority = {
  epic: number
  repository: string
  mandateId: string
  run: string
  base: string
  children: readonly EpicChildGrant[]
  config: { productVersion: string; version: string; digest: string; effective: unknown }
}

const ASSISTED_MANDATE = 'no confirmed mandate authorizes epic'

export function evidenceText(evidence: { message?: string }[] | undefined): string {
  return (
    evidence
      ?.map((item) => item.message)
      .filter(Boolean)
      .join('; ') || 'mandate refused'
  )
}

export function localInhibit(history: DecodedHistory, mandateId: string): 'pause' | 'abandon' | null {
  const confirmed = new Set<string>()
  const controls: { id: string; control: string }[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (record?.kind !== 'operator-control' || !record.payload || typeof record.payload !== 'object') continue
    const payload = record.payload as {
      control?: unknown
      mandate?: { recordId?: unknown }
      predecessor?: { recordId?: unknown }
    }
    if (typeof payload.control !== 'string') {
      throw new Refused('operator-control record has no control phase; continuation is not confirmed')
    }
    if (typeof payload.mandate?.recordId !== 'string') {
      throw new Refused('operator-control record has no mandate target; continuation is not confirmed')
    }
    if (payload.mandate.recordId !== mandateId) continue
    if (payload.control === 'pause-confirmed' && typeof payload.predecessor?.recordId === 'string') {
      confirmed.add(payload.predecessor.recordId)
    }
    controls.push({ id: record.recordId, control: payload.control })
  }
  if (controls.some((item) => item.control === 'abandon')) return 'abandon'
  if (controls.some((item) => item.control === 'pause-requested' && !confirmed.has(item.id))) return 'pause'
  return null
}

export async function assertConfig(repo: string, effective: unknown): Promise<void> {
  const injected = currentEpicEffects()?.configCompatible
  const checked = await (injected ?? configCompatibility)(repo, effective)
  if (!checked.ok) throw new Refused(checked.error)
}

function parentScopeOf(
  record: DecodedHistory['operations'][number]['record'],
): { repository: string; target: string } | null {
  if (record?.kind !== 'mandate' || record.payload.parent === null) return null
  return record.payload.parent.scope
}

async function parentMandateHistories(repo: string, history: DecodedHistory): Promise<DecodedHistory[]> {
  const external: DecodedHistory[] = []
  for (const operation of history.operations) {
    const scope = parentScopeOf(operation.record)
    if (scope === null) continue
    const parentHistory = await historyFor(repo, scope)
    if (!parentHistory.source.complete) throw new Refused('parent mandate history is incomplete')
    external.push(parentHistory)
  }
  return external
}

function selectedMandate(history: DecodedHistory, external: DecodedHistory[], epic: number): MandateRecord {
  const selected = selectApplicableMandate(history, external)
  if (selected.status === 'refused') {
    if (selected.reason === 'missing') throw new Assisted(`${ASSISTED_MANDATE} #${epic}`)
    throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
  }
  return selected.mandate
}

export type ConfirmedEpicMandate = Omit<EpicAuthority, 'epic' | 'repository'>

/**
 * Projects immutable mandate identity and current authenticated own-Spec state.
 * This establishes no active continuation, landing, or config compatibility.
 */
export function confirmedEpicMandate(record: MandateRecord, accepted: AcceptedOwnSpec): ConfirmedEpicMandate {
  const payload = record.payload
  if (payload.role === 'fix-only') throw new Refused(`mandate ${record.recordId} is fix-only, not normal authority`)
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`mandate ${record.recordId} run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`mandate ${record.recordId} base is not a branch name`)
  }
  const { config } = payload
  if (
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string' ||
    !('effective' in config)
  ) {
    throw new Refused(`mandate ${record.recordId} config identity is incomplete`)
  }
  return {
    mandateId: record.recordId,
    run: payload.run,
    base: payload.base,
    children: accepted.children,
    config,
  }
}

/**
 * The confirmed epic mandate on the epic issue. A missing record is assisted.
 * Pause, abandon, drift, and an unreadable parent are refusals. This does not
 * claim the epic is paused or disarmed.
 */
export async function readEpicAuthority(repo: string, epic: number): Promise<EpicAuthority> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) {
    throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  }
  const external = await parentMandateHistories(repo, history)
  const mandate = selectedMandate(history, external, epic)
  const inhibit = localInhibit(history, mandate.recordId)
  if (inhibit) throw new Refused(`continuation inhibited: ${inhibit} is requested and not confirmed`)
  const resolved = resolveAcceptedSpec(mandate, [history, ...external])
  if (!resolved.ok)
    throw new Refused(`epic parent accepted Spec ${resolved.reason}: ${evidenceText(resolved.evidence)}`)
  const confirmed = confirmedEpicMandate(mandate, resolved.spec)
  if (effectiveMandateRole(mandate.payload.role, resolved.spec) !== 'epic') {
    throw new Refused(`epic #${epic} accepted own Spec names no approved child`)
  }
  if (mandate.payload.permissions.landing !== true) {
    throw new Refused(`epic #${epic} mandate does not grant landing`)
  }
  await assertConfig(repo, confirmed.config.effective)
  return {
    epic,
    repository: full,
    ...confirmed,
  }
}

/**
 * Re-reads the active authority with current native children, then establishes
 * that every current child is accepted and ready before a delivery step.
 */
export async function frameEpicChildren(
  repo: string,
  epic: number,
): Promise<{
  authority: EpicAuthority
  facts: Facts
  order: number[]
  blocked: { ticket: number; blockers: number[] }[]
}> {
  const authority = await readEpicAuthority(repo, epic)
  const { facts } = await gather(repo, epic, authority.run, authority.base)
  if (
    facts.children.length !== authority.children.length ||
    facts.children.some(
      (child) =>
        !authority.children.some(
          (grant) =>
            grant.scope.repository === authority.repository &&
            grant.scope.target === `${authority.repository}#${child.number}`,
        ),
    )
  ) {
    throw new Refused('current native epic children differ from the accepted own Spec')
  }
  for (const child of facts.children) {
    if (!isDone(child, authority.base)) assertChildGrant(authority, facts, child.number)
  }
  const framed = frameEpic({ base: authority.base, children: facts.children })
  if ('error' in framed) throw new Refused(framed.error)
  return { authority, facts, ...framed }
}

export function assertChildGrant(authority: EpicAuthority, facts: Facts, ticket: number): void {
  const scope = githubScope(authority.repository, ticket)
  const grant = authority.children.find(
    (child) => child.scope.repository === scope.repository && child.scope.target === scope.target,
  )
  if (!grant) throw new Refused(`#${ticket} is outside the epic mandate's approved child scope`)
  const live = facts.children.find((child) => child.number === ticket)
  if (!live) throw new Refused(`#${ticket} is not a sub-issue of #${authority.epic}`)
  if (live.ownUw.status === 'refused') {
    const nativeDiagnostics = live.ownUw.diagnostics
      .flatMap((diagnostic) => {
        const { location } = diagnostic
        if (location.kind !== 'native') return []
        const page = location.page === undefined ? '' : ` page=${location.page}`
        return [`${location.uw.target} native.${location.connection}${page}`]
      })
      .join(', ')
    throw new Refused(
      `#${ticket} ${live.ownUw.reason}-child: ${ownUwRefusal(live)}${nativeDiagnostics ? ` [${nativeDiagnostics}]` : ''}`,
    )
  }
  if (!hasFramedOwnUw(live)) {
    throw new Refused(`#${ticket} unsettled-child: own UW is not completely framed with durable identity allocations`)
  }
  const current =
    live.ownUw.status === 'accepted'
      ? { snapshot: live.ownUw.accepted.snapshot, tier: live.ownUw.accepted.tier }
      : live.ownUw
  if (
    current.tier !== grant.tier ||
    current.snapshot.spec.version !== grant.specVersion ||
    current.snapshot.spec.version !== grant.snapshot.spec.version
  ) {
    throw new Refused(
      `#${ticket} changed-child: fresh own UW no longer matches the committed child Spec version or tier`,
    )
  }
}
