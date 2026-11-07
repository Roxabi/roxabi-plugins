import { randomUUID } from 'node:crypto'
import authorization from './head-authorization.cjs'

import { errorText, gh, preview } from './workflow-runtime.js'

const GATE_STATES = new Set(['OPEN', 'CLOSED', 'MERGED'])

export function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

export async function readPrFields(cwd, pr, ghFn, fields) {
  const raw = await ghFn(cwd, ['pr', 'view', String(pr), '--json', fields])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`landPr: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  return data
}

export async function readHeadRefOid(cwd, pr, ghFn) {
  return (await readPrFields(cwd, pr, ghFn, 'headRefOid')).headRefOid
}

export async function readGate(cwd, pr, ghFn = gh) {
  const raw = await ghFn(cwd, [
    'pr',
    'view',
    String(pr),
    '--json',
    'headRefOid,state,labels,autoMergeRequest,mergeStateStatus',
  ])
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`readGate: gh pr view ${pr} returned no JSON — ${preview(raw)}`)
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.labels)) {
    throw new Error(`readGate: gh pr view ${pr} carried no labels — ${preview(raw)}`)
  }
  if (!data.labels.every((label) => typeof label?.name === 'string')) {
    throw new Error(`readGate: gh pr view ${pr} carried unreadable labels — ${preview(raw)}`)
  }
  if (!GATE_STATES.has(data.state)) {
    throw new Error(`readGate: gh pr view ${pr} state is ${JSON.stringify(data.state) ?? 'missing'} — ${preview(raw)}`)
  }
  if (!('autoMergeRequest' in data) || (data.autoMergeRequest !== null && typeof data.autoMergeRequest !== 'object')) {
    throw new Error(`readGate: gh pr view ${pr} carried no auto-merge state — ${preview(raw)}`)
  }
  return { ...data, authorization: await readAuthority(cwd, pr, ghFn) }
}

async function readAuthority(cwd, pr, ghFn) {
  const policy = await authorization.policyFromRepository({ cwd, gh: ghFn })
  if (policy === null) return { configured: false, allowed: false, receipt: null }
  const state = await authorization.readAuthorization({ cwd, gh: ghFn, prNumber: Number(pr), policy })
  return { ...state, configured: true }
}

export function isBehind(gate) {
  return gate?.state === 'OPEN' && gate.mergeStateStatus === 'BEHIND'
}

export function behindMessage(pr) {
  return `PR ${pr} is behind its base; landing stopped, with no further arming and known OPEN arms cleared; run: gh pr update-branch ${pr} — then land again`
}

function gateArming(gate) {
  return {
    labelled: gate.labels.some((label) => label?.name === 'reviewed'),
    autoOn: Boolean(gate.autoMergeRequest),
  }
}

async function revokeGateArming(cwd, pr, ghFn, { autoOn, labelled }) {
  const failures = []
  const actions = [
    [autoOn, ['pr', 'merge', String(pr), '--disable-auto'], '--disable-auto'],
    [labelled, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'], '--remove-label'],
  ]
  for (const [enabled, args, label] of actions) {
    if (!enabled) continue
    try {
      await ghFn(cwd, args)
    } catch (error) {
      failures.push(`${label} failed: ${errorText(error)}`)
    }
  }
  return failures
}

async function confirmGateDisarmed(cwd, pr, ghFn, detail, barrier) {
  let back
  try {
    back = await readGate(cwd, pr, ghFn)
  } catch (error) {
    throw new Error(
      `disarmGate: PR ${pr} could not be read back; auto-merge and reviewed may stay armed${detail} — ${errorText(error)}`,
    )
  }
  if (back.state === 'MERGED') throw new Error(`disarmGate: PR ${pr} merged while being disarmed${detail}`)
  if (
    barrier === null
      ? back.authorization?.configured !== false
      : !Number.isSafeInteger(barrier?.id) ||
        back.authorization?.allowed ||
        back.authorization?.receipt?.id !== barrier.id
  ) {
    throw new Error(`disarmGate: PR ${pr} withdrawal barrier changed during cleanup${detail}`)
  }
  if (back.state === 'CLOSED') return true
  const stays = [
    back.autoMergeRequest && 'auto-merge',
    back.labels.some((label) => label?.name === 'reviewed') && 'the reviewed label',
  ].filter(Boolean)
  if (stays.length) throw new Error(`disarmGate: PR ${pr} stays armed — ${stays.join(' and ')}${detail}`)
  return true
}

export async function disarmGate(cwd, pr, gate, ghFn) {
  if (gate?.state === 'MERGED') throw new Error(`disarmGate: PR ${pr} merged while being disarmed`)
  const policy = await authorization.policyFromRepository({ cwd, gh: ghFn })
  const barrier =
    policy === null
      ? null
      : await authorization.withdrawAuthorization({
          cwd,
          gh: ghFn,
          prNumber: Number(pr),
          policy,
          operationId: randomUUID(),
          reason: 'native lifecycle disarm',
        })
  if (!gate) return { barrier }
  const failures = gate.state === 'CLOSED' ? [] : await revokeGateArming(cwd, pr, ghFn, gateArming(gate))
  const detail = failures.length ? ` (${failures.join('; ')})` : ''
  await confirmGateDisarmed(cwd, pr, ghFn, detail, barrier)
  return { barrier }
}

export function approves(verdict) {
  return verdict?.startsWith('Approve') === true
}

export function reviewBoundStopped(records) {
  return records.spent
}

export function mayStayArmed(records, gate, reviewing) {
  return (
    !reviewing &&
    !reviewBoundStopped(records) &&
    approves(records.verdict) &&
    isCommitSha(gate.headRefOid) &&
    records.head === gate.headRefOid
  )
}

export async function enforceArmedGate(
  cwd,
  pr,
  { records, gate, reviewing = false, policy = 'allow-approved', gh: ghFn = gh, withdrawOnReadFailure = false },
) {
  if (gate?.state === 'MERGED') return { allowed: false }
  if (policy === 'unarmed' || reviewing || !gate) {
    const { barrier } = await disarmGate(cwd, pr, gate, ghFn)
    return { allowed: false, disarmed: true, barrier }
  }
  if (gate.state === 'CLOSED') return { allowed: false }
  let authority
  try {
    authority = await readAuthority(cwd, pr, ghFn)
  } catch (error) {
    if (withdrawOnReadFailure) await disarmGate(cwd, pr, gate, ghFn)
    throw error
  }
  const armed = authority.allowed || gate.autoMergeRequest
  if (!armed) return { allowed: false }
  if (
    policy === 'allow-approved' &&
    records &&
    mayStayArmed(records, gate, reviewing) &&
    (!authority.allowed || authority.receipt?.record?.headSha === gate.headRefOid)
  ) {
    return { allowed: true }
  }
  const { barrier } = await disarmGate(cwd, pr, gate, ghFn)
  return { allowed: false, disarmed: true, barrier }
}
