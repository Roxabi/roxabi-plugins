import { randomUUID } from 'node:crypto'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { UwTier } from '../engine/uw-spec.ts'
import type { ContextSuccessionProposal } from '../engine/workflow-context-disposition-schema.ts'
import type { AcceptedChildCommitment, MandatePayload } from '../engine/workflow-mandate-schema.ts'
import type { ContextHandoffObservation } from './feature-context-handoff-observation.ts'
import type { Contracts, History, HistoryRecord, Scope } from './feature-engine.ts'
import type { publishSuccessorMandate } from './feature-succession.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'

export const handoffStages = {
  preselection: {
    observation: 'preselection-observation',
    reconciliation: 'preselection-reconciliation',
    admission: 'preselection-admission',
    config: 'preselection-config',
  },
  premandate: {
    observation: 'premandate-observation',
    reconciliation: 'premandate-reconciliation',
    admission: 'premandate-admission',
    config: 'premandate-config',
  },
} as const

type MandateRecord = Extract<HistoryRecord, { kind: 'mandate' }>
type SuccessorAntecedent = { scope: Scope; recordId: string; kind: 'mandate' }
type SuccessorShared = Pick<
  MandateRecord['payload'],
  | 'format'
  | 'branch'
  | 'base'
  | 'lineageHead'
  | 'config'
  | 'parent'
  | 'antecedent'
  | 'ownSpec'
  | 'tier'
  | 'children'
  | 'inheritedOwnSpecRefs'
  | 'coverage'
>

export function sameHandoffObservation(
  observed: ContextHandoffObservation,
  proposal: ContextSuccessionProposal,
): boolean {
  return (
    canonicalValueDigest(observed.reconciliation) === canonicalValueDigest(proposal.reconciliation) &&
    canonicalValueDigest(observed.negative) === canonicalValueDigest(proposal.negative) &&
    canonicalValueDigest(observed.replacementAccepted) === canonicalValueDigest(proposal.replacementAccepted)
  )
}

export async function readPublishedSuccessorHistory(
  input: Parameters<typeof publishSuccessorMandate>[0],
): Promise<History | null> {
  const options = {
    cwd: input.cwd,
    gh: input.gh,
    readAuthor: input.history.source.expectedAuthor,
    ...(input.history.source.stopAuthor === null ? {} : { stopAuthor: input.history.source.stopAuthor }),
  }
  const refreshed = await input.loaded.readComposedWorkflowHistory([input.scope], options)
  return refreshed.ok ? (refreshed.histories[0] ?? null) : null
}

export async function successorShared(
  input: {
    loaded: Contracts
    scope: Scope
    ownSpec: MandatePayload['ownSpec']
    tier: UwTier
    children: AcceptedChildCommitment[]
    inheritedOwnSpecRefs: MandatePayload['inheritedOwnSpecRefs']
    coverage: MandatePayload['coverage']
    git: GitRunner
    cwd: string
  },
  antecedent: SuccessorAntecedent,
  prior: MandateRecord['payload'],
  baseAndBranch: { base: string; branch: string | null },
  productVersion: string,
): Promise<{ ok: true; shared: SuccessorShared } | { ok: false; reason: string }> {
  const head = await input.git(input.cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim()))
    return { ok: false, reason: 'successor-head-unreadable' }
  const override = await input.git(input.cwd, ['show', `refs/remotes/origin/${baseAndBranch.base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason }
  const effective = effectiveWorkflowConfig(productVersion, parsed.additionalRequirements)
  return {
    ok: true as const,
    shared: {
      format: 'omp-build-mandate/4',
      branch: baseAndBranch.branch,
      base: baseAndBranch.base,
      lineageHead: head.stdout.trim(),
      config: { productVersion, version: WORKFLOW_CONFIG_VERSION, digest: configPinDigest(effective), effective },
      parent: prior.parent,
      antecedent,
      ownSpec: input.ownSpec,
      tier: input.tier,
      children: input.children,
      inheritedOwnSpecRefs: input.inheritedOwnSpecRefs,
      coverage: input.coverage,
    },
  }
}

export function successorRolePayload(
  prior: MandateRecord['payload'],
  shared: SuccessorShared,
): MandateRecord['payload'] {
  if (prior.role === 'epic') return { role: 'epic', ...shared, run: prior.run, permissions: prior.permissions }
  if (prior.role === 'fix-only')
    return { role: 'fix-only', ...shared, run: null, permissions: { landing: false, correct: true } }
  return { role: 'feature', ...shared, run: prior.run, permissions: prior.permissions }
}

export function successorControlRecord(
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
