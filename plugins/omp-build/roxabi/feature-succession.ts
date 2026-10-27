// Source: plugins/omp-build/roxabi/workflow.ts:638-705,2009-2156

import { randomUUID } from 'node:crypto'
import type { UwTier } from '../engine/uw-spec.ts'
import type { AcceptedChildCommitment, MandatePayload } from '../engine/workflow-mandate-schema.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import {
  type Contracts,
  type History,
  type HistoryRecord,
  isRecord,
  payload,
  publishRecord,
  type Scope,
} from './feature-engine.ts'
import { preserveSuccessorBinding } from './feature-succession-binding.ts'

export type { Gh } from './feature-succession-binding.ts'

import type { Gh } from './feature-succession-binding.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'

type MandateRecord = Extract<HistoryRecord, { kind: 'mandate' }>
type SuccessorShared = Pick<
  MandateRecord['payload'],
  'format' | 'branch' | 'base' | 'lineageHead' | 'config' | 'parent' | 'antecedent' | 'ownSpec' | 'tier' | 'children'
>

export function mandatesInHistory(history: History): MandateRecord[] {
  const mandates: MandateRecord[] = []
  for (const operation of history.operations) {
    if (operation.status === 'complete' && operation.record?.kind === 'mandate') mandates.push(operation.record)
  }
  return mandates
}

export function selectSuccessorControl(
  history: History,
  predecessor: { scope: Scope; recordId: string; kind: 'mandate' },
): { successor: { scope: Scope; recordId: string; kind: string } } | null {
  for (const operation of history.operations) {
    const record = operation.record
    if (operation.status !== 'complete' || record?.kind !== 'operator-control') continue
    const body = payload(record)
    if (body.control !== 'select-successor' || !isRecord(body.predecessor)) continue
    const pred = body.predecessor
    if (
      isRecord(pred.scope) &&
      pred.scope.repository === predecessor.scope.repository &&
      pred.scope.target === predecessor.scope.target &&
      pred.recordId === predecessor.recordId &&
      pred.kind === 'mandate' &&
      isRecord(body.successor) &&
      typeof body.successor.recordId === 'string' &&
      isRecord(body.successor.scope)
    ) {
      return {
        successor: {
          scope: body.successor.scope,
          recordId: body.successor.recordId,
          kind: body.successor.kind,
        },
      }
    }
  }
  return null
}

/** Intact abandoned/revoked tip that `/feature new` must succeed. */
export function successionAntecedent(
  history: History,
): { mandate: MandateRecord; ref: { scope: Scope; recordId: string; kind: 'mandate' } } | { reason: string } {
  const mandates = mandatesInHistory(history)
  if (mandates.length === 0) return { reason: 'mandate-missing' }
  const last = mandates[mandates.length - 1]
  if (last === undefined) return { reason: 'mandate-missing' }
  const ref = {
    scope: { repository: last.repository, target: last.target },
    recordId: last.recordId,
    kind: 'mandate' as const,
  }
  const existing = selectSuccessorControl(history, ref)
  if (existing === null) return { mandate: last, ref }
  const tip = mandates.find((mandate) => mandate.recordId === existing.successor.recordId)
  if (tip === undefined) return { reason: 'successor-unconfirmed' }
  return {
    mandate: tip,
    ref: { scope: { repository: tip.repository, target: tip.target }, recordId: tip.recordId, kind: 'mandate' },
  }
}

type SuccessorAntecedent = { scope: Scope; recordId: string; kind: 'mandate' }

export async function publishSuccessorMandate(input: {
  loaded: Contracts
  history: History
  scope: Scope
  issue: { title: string; labels: string[] }
  ownSpec: MandatePayload['ownSpec']
  tier: UwTier
  children: AcceptedChildCommitment[]
  number: number
  git: GitRunner
  gh: Gh
  cwd: string
  parents: readonly History[]
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const antecedent = successionAntecedent(input.history)
  if ('reason' in antecedent) return { ok: false, reason: antecedent.reason }
  const productVersion = input.loaded.shippedProductVersion()
  const prior = antecedent.mandate.payload
  const baseAndBranch = await successorBaseAndBranch(input, prior)
  if (!baseAndBranch.ok) return baseAndBranch
  const shared = await successorShared(input, antecedent.ref, prior, baseAndBranch, productVersion)
  if (!shared.ok) return shared
  const rolePayload = successorRolePayload(prior, shared.shared)
  if (rolePayload.role === 'epic' && !/^[a-z0-9]{8}$/.test(rolePayload.run)) {
    return { ok: false, reason: 'epic-run-unreadable' }
  }
  const successorId = randomUUID()
  const controlId = randomUUID()
  const mandatePublished = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: successorId,
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'mandate',
      payload: rolePayload,
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!mandatePublished.ok) return { ok: false, reason: mandatePublished.reason }
  const refreshed = await input.loaded.readComposedWorkflowHistory([input.scope], { cwd: input.cwd, gh: input.gh })
  if (!refreshed.ok || !refreshed.histories[0]) return { ok: false, reason: 'successor-unconfirmed' }
  const controlPublished = await publishRecord(
    input.loaded,
    refreshed.histories[0],
    successorControlRecord(input.scope, antecedent.ref, successorId, controlId),
    input.gh,
    input.cwd,
    refreshed.histories.slice(1),
  )
  const bound = await preserveSuccessorBinding({
    loaded: input.loaded,
    gh: input.gh,
    cwd: input.cwd,
    issueHistory: refreshed.histories[0],
    successorId,
    successorScope: input.scope,
    antecedentRecordId: antecedent.mandate.recordId,
    branch: baseAndBranch.branch,
    base: baseAndBranch.base,
  })
  if (!bound.ok) return bound
  return controlPublished.ok ? { ok: true } : { ok: false, reason: controlPublished.reason }
}

async function successorBaseAndBranch(
  input: { git: GitRunner; cwd: string; number: number; issue: { title: string; labels: string[] } },
  prior: MandateRecord['payload'],
): Promise<{ ok: true; base: string; branch: string } | { ok: false; reason: string }> {
  const branch =
    prior.branch ?? branchFor({ number: input.number, title: input.issue.title, labels: input.issue.labels })
  return { ok: true, base: prior.base, branch }
}

async function successorShared(
  input: {
    loaded: Contracts
    scope: Scope
    ownSpec: MandatePayload['ownSpec']
    tier: UwTier
    children: AcceptedChildCommitment[]
    git: GitRunner
    cwd: string
  },
  antecedent: SuccessorAntecedent,
  prior: MandateRecord['payload'],
  baseAndBranch: { base: string; branch: string },
  productVersion: string,
): Promise<{ ok: true; shared: SuccessorShared } | { ok: false; reason: string }> {
  const head = await input.git(input.cwd, ['rev-parse', 'HEAD'])
  const override = await input.git(input.cwd, ['show', `refs/remotes/origin/${baseAndBranch.base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason }
  const effective = effectiveWorkflowConfig(productVersion, parsed.additionalRequirements)
  return {
    ok: true as const,
    shared: {
      format: 'omp-build-mandate/3',
      branch: baseAndBranch.branch,
      base: baseAndBranch.base,
      lineageHead: head.code === 0 ? head.stdout.trim() : null,
      config: { productVersion, version: WORKFLOW_CONFIG_VERSION, digest: configPinDigest(effective), effective },
      parent: prior.parent,
      antecedent,
      ownSpec: input.ownSpec,
      tier: input.tier,
      children: input.children,
    },
  }
}

function successorRolePayload(prior: MandateRecord['payload'], shared: SuccessorShared): MandateRecord['payload'] {
  if (prior.role === 'epic') {
    return {
      role: 'epic',
      ...shared,
      run: prior.run,
      permissions: prior.permissions,
    }
  }
  if (prior.role === 'fix-only') {
    return {
      role: 'fix-only',
      ...shared,
      run: null,
      permissions: { landing: false, correct: true },
    }
  }
  return {
    role: 'feature',
    ...shared,
    run: prior.run,
    permissions: prior.permissions,
  }
}

function successorControlRecord(
  scope: Scope,
  antecedent: SuccessorAntecedent,
  successorId: string,
  controlId: string,
): Omit<Extract<HistoryRecord, { kind: 'operator-control' }>, 'inputs'> {
  return {
    repository: scope.repository,
    target: scope.target,
    version: 1,
    recordId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId,
      predecessor: antecedent,
      successor: { scope, recordId: successorId, kind: 'mandate' },
      mandate: antecedent,
    },
  }
}
