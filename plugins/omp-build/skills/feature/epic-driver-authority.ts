import { type DecodedHistory, githubScope, selectApplicableMandate, specDigest } from '../../dist/contracts.js'
import { configCompatibility } from '../../roxabi/workflow-overrides.ts'
import { gather } from './epic-driver-gather'
import { historyFor, issueHistory, repoName } from './epic-driver-github'
import { Assisted, currentEpicEffects, Refused } from './epic-driver-runtime'
import { frameEpic } from './epic-frame'
import { BASE_NAME, RUN_ID } from './epic-naming'
import type { Facts } from './epic-types'

// ── Confirmed mandate ─────────────────────────────────────────────────────────

export type EpicChildGrant = { scope: { repository: string; target: string }; specDigest: string; specBody: string }

export type EpicAuthority = {
  epic: number
  repository: string
  mandateId: string
  run: string
  base: string
  children: EpicChildGrant[]
  /** Child scopes a confirmed epic-fix record on this epic issue already admits. */
  extensions: { repository: string; target: string }[]
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function childGrantOf(value: unknown): EpicChildGrant | string {
  if (!isObject(value) || !('scope' in value) || !('specDigest' in value) || !('specBody' in value)) {
    return 'epic mandate child snapshot is unreadable'
  }
  if (!isObject(value.scope)) return 'epic mandate child scope is unreadable'
  const { repository, target } = value.scope
  if (typeof repository !== 'string' || typeof target !== 'string' || repository === '' || target === '') {
    return 'epic mandate child scope is unreadable'
  }
  if (typeof value.specBody !== 'string' || typeof value.specDigest !== 'string') {
    return 'epic mandate child has no approved spec snapshot'
  }
  if (specDigest(value.specBody) !== value.specDigest) {
    return 'epic mandate child specDigest does not match specBody'
  }
  return {
    scope: { repository, target },
    specDigest: value.specDigest,
    specBody: value.specBody,
  }
}

export function childGrants(value: unknown): EpicChildGrant[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'epic mandate names no approved child'
  const grants: EpicChildGrant[] = []
  for (const item of value) {
    const grant = childGrantOf(item)
    if (typeof grant === 'string') return grant
    grants.push(grant)
  }
  return grants
}

function parentScopeOf(
  record: DecodedHistory['operations'][number]['record'],
): { repository: string; target: string } | null {
  const payload = record?.kind === 'mandate' ? record.payload : null
  if (!isObject(payload) || !('parent' in payload) || payload.parent == null) return null
  if (!isObject(payload.parent) || !isObject(payload.parent.scope)) {
    throw new Refused('epic mandate parent reference is unreadable')
  }
  const { repository, target } = payload.parent.scope
  if (typeof repository !== 'string' || typeof target !== 'string') {
    throw new Refused('epic mandate parent reference is unreadable')
  }
  return { repository, target }
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

function selectedMandate(
  history: DecodedHistory,
  external: DecodedHistory[],
  epic: number,
): { mandateId: string; payload: Record<string, unknown> } {
  const selected = selectApplicableMandate(history, external)
  if (selected.status === 'refused') {
    if (selected.reason === 'missing') throw new Assisted(`${ASSISTED_MANDATE} #${epic}`)
    throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
  }
  if (!isObject(selected.mandate.payload)) throw new Refused('epic mandate payload is unreadable')
  return { mandateId: selected.mandate.recordId, payload: selected.mandate.payload }
}

type ConfirmedEpicMandate = Omit<EpicAuthority, 'epic' | 'repository' | 'extensions'>

async function confirmedEpicMandate(
  repo: string,
  epic: number,
  mandateId: string,
  payload: Record<string, unknown>,
): Promise<ConfirmedEpicMandate> {
  if (payload.role !== 'epic') throw new Refused(`#${epic} mandate role is ${String(payload.role)}, not epic`)
  if (!isObject(payload.permissions) || payload.permissions.landing !== true) {
    throw new Refused(`epic #${epic} mandate does not grant landing`)
  }
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`epic #${epic} mandate run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`epic #${epic} mandate base is not a branch name`)
  }
  const children = childGrants(payload.children)
  if (typeof children === 'string') throw new Refused(children)
  const config = isObject(payload.config) ? payload.config : null
  if (
    config === null ||
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string' ||
    !('effective' in config)
  ) {
    throw new Refused('epic mandate config identity is incomplete')
  }
  await assertConfig(repo, config.effective)
  return {
    mandateId,
    run: payload.run,
    base: payload.base,
    children,
    config: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      effective: config.effective,
    },
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
  const inhibit = localInhibit(history, mandate.mandateId)
  if (inhibit) throw new Refused(`continuation inhibited: ${inhibit} is requested and not confirmed`)
  const confirmed = await confirmedEpicMandate(repo, epic, mandate.mandateId, mandate.payload)
  return {
    epic,
    repository: full,
    extensions: extensionScopes(history),
    ...confirmed,
  }
}

function extensionScopeOf(value: unknown): { repository: string; target: string } | null {
  if (!isObject(value)) return null
  if (value.event !== 'epic-fix' && value.event !== 'mark-fix') return null
  if (!isObject(value.child) || !isObject(value.child.scope)) return null
  const { repository, target } = value.child.scope
  return typeof repository === 'string' && typeof target === 'string' ? { repository, target } : null
}

export function extensionScopes(history: DecodedHistory): { repository: string; target: string }[] {
  const scopes: { repository: string; target: string }[] = []
  for (const operation of history.operations) {
    if (operation.record?.kind !== 'epic-event') continue
    const scope = extensionScopeOf(operation.record.payload)
    if (scope !== null) scopes.push(scope)
  }
  return scopes
}

export function assertChildGrant(authority: EpicAuthority, facts: Facts, ticket: number): void {
  const scope = githubScope(authority.repository, ticket)
  const grant = authority.children.find(
    (child) => child.scope.repository === scope.repository && child.scope.target === scope.target,
  )
  const extended = authority.extensions.some(
    (entry) => entry.repository === scope.repository && entry.target === scope.target,
  )
  if (!grant && !extended) throw new Refused(`#${ticket} is outside the epic mandate's approved child scope`)
  const live = facts.children.find((child) => child.number === ticket)
  if (!live) throw new Refused(`#${ticket} is not a sub-issue of #${authority.epic}`)
  if (grant && live.body !== grant.specBody) {
    throw new Refused(`#${ticket} issue body differs from the approved spec snapshot`)
  }
}

/** Order and blocked children for a publisher. Does not authorize a run or emit objective text. */
export async function frameEpicChildren(
  repo: string,
  epic: number,
  base: string,
): Promise<
  { order: number[]; blocked: { ticket: number; blockers: number[] }[] } | { error: string; missing?: number[] }
> {
  if (!BASE_NAME.test(base) || base.includes('..')) throw new Refused(`base ${base} is not a branch name`)
  const { facts } = await gather(repo, epic, '00000000', base, { git: false })
  return frameEpic({ base, children: facts.children })
}
