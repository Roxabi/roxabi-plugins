// Source: plugins/omp-build/roxabi/workflow.ts:1999-2007,2158-2225
import { randomUUID } from 'node:crypto'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { MandatePayload } from '../engine/workflow-mandate-schema.ts'
import { baseFromStack } from '../skills/feature/epic-ci.ts'
import { type Contracts, type History, publishRecord, type Scope } from './feature-engine.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

export async function resolveBase(git: GitRunner, principal: string): Promise<{ base: string } | { reason: string }> {
  const shown = await git(principal, ['show', 'HEAD:.dev/stack.yml'])
  if (shown.code !== 0) return { reason: 'base-unreadable' }
  const parsed: unknown = Bun.YAML.parse(shown.stdout)
  const remote = await git(principal, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const fallback = remote.stdout.trim().replace(/^origin\//, '')
  const resolved = baseFromStack(parsed, () => fallback)
  return 'error' in resolved ? { reason: resolved.error } : { base: resolved.base }
}

export async function publishFirstMandate(
  contracts: Contracts,
  history: History,
  scope: Scope,
  initial: Pick<MandatePayload, 'ownSpec' | 'tier' | 'children'> & { parent: ExternalRecordRef | null },
  branch: string,
  git: GitRunner,
  gh: Gh,
  cwd: string,
  parentHistories: readonly History[],
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly { code: string; message: string }[] }> {
  const productVersion = contracts.shippedProductVersion()
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  const lineageHead = head.code === 0 ? head.stdout.trim() : null
  const resolvedBase = await resolveBase(git, cwd)
  if ('reason' in resolvedBase) return { ok: false, reason: resolvedBase.reason }
  const base = resolvedBase.base
  const override = await git(cwd, ['show', `refs/remotes/origin/${base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const requirements = parsed.additionalRequirements
  const effective = effectiveWorkflowConfig(productVersion, requirements)
  return publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'mandate',
      payload: {
        role: initial.children.length === 0 ? 'feature' : 'epic',
        format: 'omp-build-mandate/3',
        branch,
        base,
        lineageHead,
        config: {
          productVersion,
          version: WORKFLOW_CONFIG_VERSION,
          digest: configPinDigest(effective),
          effective,
        },
        parent: initial.parent,
        antecedent: null,
        ownSpec: initial.ownSpec,
        tier: initial.tier,
        children: initial.children,
        permissions: { landing: true, correct: true },
        run: randomUUID().slice(0, 8),
      },
    },
    gh,
    cwd,
    parentHistories,
  )
}
