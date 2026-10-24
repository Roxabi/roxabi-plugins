// Source: plugins/omp-build/roxabi/workflow.ts:1999-2007,2158-2225
import { randomUUID } from 'node:crypto'
import { baseFromStack } from '../skills/feature/epic-ci.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { type Contracts, type History, publishRecord, type Scope } from './feature-engine.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'
import { type GitRunner, readProofConfigPins } from './workflow-pins.ts'

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
  issue: { title: string; body: string; labels: string[]; updatedAt: string },
  number: number,
  git: GitRunner,
  gh: Gh,
  cwd: string,
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly { code: string; message: string }[] }> {
  const productVersion = contracts.shippedProductVersion()
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  const lineageHead = head.code === 0 ? head.stdout.trim() : null
  const resolvedBase = await resolveBase(git, cwd)
  if ('reason' in resolvedBase) return { ok: false, reason: resolvedBase.reason }
  const base = resolvedBase.base
  let pins: Awaited<ReturnType<typeof readProofConfigPins>>
  try {
    pins = await readProofConfigPins(git, cwd, `refs/remotes/origin/${base}`)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'proof-pin-unreadable' }
  }
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
        role: 'feature',
        branch: branchFor({ number, title: issue.title, labels: issue.labels }),
        base,
        lineageHead,
        config: {
          productVersion,
          version: WORKFLOW_CONFIG_VERSION,
          digest: configPinDigest(effective),
          effective,
        },
        proofPins: pins,
        parent: null,
        antecedent: null,
        spec: {
          reference: scope.target,
          body: issue.body,
          bodySha256: contracts.specDigest(issue.body),
          lastEditedAt: issue.updatedAt,
        },
        permissions: { landing: true, correct: true },
        run: null,
        children: null,
      },
    },
    gh,
    cwd,
  )
}
