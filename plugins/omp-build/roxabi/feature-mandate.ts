// Source: plugins/omp-build/roxabi/workflow.ts:1999-2007,2158-2225
import { randomUUID } from 'node:crypto'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { MandatePayload } from '../engine/workflow-mandate-schema.ts'
import { baseFromStack } from '../skills/feature/epic-ci.ts'
import { type Contracts, type History, publishRecord, type Scope } from './feature-engine.ts'
import type { InitialMandateCheckout } from './feature-initial-checkout.ts'
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
  initial: Pick<MandatePayload, 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'> & {
    parent: ExternalRecordRef | null
  },
  checkout: InitialMandateCheckout,
  git: GitRunner,
  gh: Gh,
  cwd: string,
  parentHistories: readonly History[],
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly { code: string; message: string }[] }> {
  const productVersion = contracts.shippedProductVersion()
  const { base, branch, lineageHead } = checkout
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
        role: checkout.kind === 'parent' ? 'epic' : 'feature',
        format: 'omp-build-mandate/4',
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
        inheritedOwnSpecRefs: initial.inheritedOwnSpecRefs,
        coverage: initial.coverage,
        permissions: { landing: true, correct: true },
        run: randomUUID().slice(0, 8),
      },
    },
    gh,
    cwd,
    parentHistories,
  )
}
