import { randomUUID } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  githubScope,
  parseRecord,
  type Result,
  readGitHubHistory,
  selectWorkflowBinding,
} from '../dist/contracts.js'
import { defaultGh } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import { createPreparedReviewRunner } from './review-entry.ts'
import type { PreparedReviewInputs } from './review-input-contract.ts'
import { prepareReviewInputs } from './review-pr-inputs.ts'
import {
  collectWorkflowBindings,
  hostGrantInterruptedReviewReplacement,
  hostReplaceInterruptedReview,
  hostTerminalizeInterruptedReview,
  type RecoveryHostPorts,
} from './review-recovery-host.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>

async function readRepository(cwd: string, gh: Gh): Promise<Result<string>> {
  try {
    const raw = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
    const repository = String(raw).trim()
    if (!repository.includes('/'))
      return { ok: false, diagnostics: [{ code: 'unreadable', message: 'repository missing' }] }
    return { ok: true, value: repository }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ code: 'unreadable', message: error instanceof Error ? error.message : String(error) }],
    }
  }
}

function recoveryPublish(publisher: ReturnType<typeof createGitHubRecordPublisher>): RecoveryHostPorts['publish'] {
  return async (record) => {
    const saved = await publisher.publish(record)
    return saved.ok
      ? { ok: true, value: { recordId: record.recordId } }
      : { ok: false, diagnostics: saved.diagnostics.map((code) => ({ code, message: code })) }
  }
}

async function recoveryPorts(input: {
  cwd: string
  pr: number
  gh?: Gh
}): Promise<Result<RecoveryHostPorts & { repository: string; scopeTarget: string }>> {
  const gh = input.gh ?? defaultGh()
  const repository = await readRepository(input.cwd, gh)
  if (!repository.ok) return repository
  const scope = githubScope(repository.value, input.pr)
  const github = withRoxabiGitHubPolicy({ cwd: input.cwd, gh })
  const publisher = createGitHubRecordPublisher(scope, github, null)
  return {
    ok: true,
    value: {
      repository: repository.value,
      scopeTarget: scope.target,
      runId: randomUUID(),
      publish: recoveryPublish(publisher),
      readPullRequestHistory: async () => decodeHistory(await readGitHubHistory(scope, github)),
      readExternalHistories: async (bindings) => {
        const out: DecodedHistory[] = []
        const seen = new Set<string>()
        for (const binding of bindings) {
          const mandateScope = binding.payload.mandate.scope
          const key = `${mandateScope.repository}\0${mandateScope.target}`
          if (seen.has(key)) continue
          seen.add(key)
          if (mandateScope.repository === scope.repository && mandateScope.target === scope.target) continue
          out.push(decodeHistory(await readGitHubHistory(mandateScope, github)))
        }
        return out
      },
    },
  }
}

function replacementTemplate(input: { cwd: string; prepared: PreparedReviewInputs }): ReviewRoot | null {
  if (input.prepared.capture.input === null) return null
  const inventory = createPreparedReviewRunner(
    input.prepared,
    {
      cwd: input.cwd,
      readAuthor: input.prepared.automationLogin,
      writeAuthor: input.prepared.automationLogin,
    },
    async () => ({ ok: true }),
  ).initialBatch().inventory
  const parsed = parseRecord(inventory)
  return parsed.ok && parsed.value.kind === 'review-attempt' ? parsed.value : null
}

async function readFreshBinding(input: {
  ports: RecoveryHostPorts & { repository: string; scopeTarget: string }
  prepared: PreparedReviewInputs
}): Promise<Result<WorkflowBinding>> {
  const history = await input.ports.readPullRequestHistory()
  const bindings = collectWorkflowBindings(history)
  const external = await input.ports.readExternalHistories(bindings)
  const selected = selectWorkflowBinding({
    pullRequest: { repository: input.ports.repository, target: input.ports.scopeTarget },
    histories: [history, ...external],
    native: { branch: input.prepared.pr.branch, base: input.prepared.pr.base },
  })
  if (selected.status === 'bound') return { ok: true, value: selected.binding }
  return {
    ok: false,
    diagnostics:
      selected.status === 'absent'
        ? [{ code: 'unbound', message: 'No active workflow binding is available for recovery' }]
        : selected.diagnostics,
  }
}

/** Live GitHub terminalize for one PR. */
export async function ghTerminalizeInterruptedReview(input: {
  cwd: string
  pr: number
  gh?: Gh
}): Promise<Result<{ recordId: string }>> {
  const ports = await recoveryPorts(input)
  if (!ports.ok) return ports
  return hostTerminalizeInterruptedReview(ports.value)
}

/** Live GitHub grant: capture fresh review input and select the sole active binding. */
export async function ghGrantInterruptedReviewReplacement(input: {
  cwd: string
  pr: number
  contextWindow: number
  gh?: Gh
  operations: UwOperations
  pluginPin?: TrustedHostPluginPin
  prepareReview?: typeof prepareReviewInputs
}): Promise<Result<{ recordId: string }>> {
  const ports = await recoveryPorts(input)
  if (!ports.ok) return ports
  const prepare = input.prepareReview ?? prepareReviewInputs
  const prepared = await prepare({
    cwd: input.cwd,
    pr: input.pr,
    contextWindow: input.contextWindow,
    gh: input.gh,
    operations: input.operations,
    ...(input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin }),
  })
  if (!prepared.ok) return prepared
  if (prepared.value.capture.input === null) {
    return {
      ok: false,
      diagnostics: [{ code: 'unbound', message: 'Fresh review input digest is null; grant requires a non-null input' }],
    }
  }
  const binding = await readFreshBinding({ ports: ports.value, prepared: prepared.value })
  if (!binding.ok) return binding
  return hostGrantInterruptedReviewReplacement({
    ports: ports.value,
    binding: binding.value,
    candidateGitSHA: prepared.value.pr.head,
    digest: prepared.value.capture.input,
    branch: prepared.value.pr.branch,
    base: prepared.value.pr.base,
  })
}

/** Live GitHub replace: confirm and activate the deterministic linked inventory. */
export async function ghReplaceInterruptedReview(input: {
  cwd: string
  pr: number
  contextWindow: number
  gh?: Gh
  operations: UwOperations
  pluginPin?: TrustedHostPluginPin
  prepareReview?: typeof prepareReviewInputs
}): Promise<Result<{ recordId: string; grantId: string; inventory: ReviewRoot; input: PreparedReviewInputs }>> {
  const ports = await recoveryPorts(input)
  if (!ports.ok) return ports
  const prepare = input.prepareReview ?? prepareReviewInputs
  const prepared = await prepare({
    cwd: input.cwd,
    pr: input.pr,
    contextWindow: input.contextWindow,
    gh: input.gh,
    operations: input.operations,
    ...(input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin }),
  })
  if (!prepared.ok) return prepared
  const template = replacementTemplate({ cwd: input.cwd, prepared: prepared.value })
  if (template === null) {
    return {
      ok: false,
      diagnostics: [
        { code: 'unbound', message: 'Fresh review input could not build a replacement inventory template' },
      ],
    }
  }
  const binding = await readFreshBinding({ ports: ports.value, prepared: prepared.value })
  if (!binding.ok) return binding
  const published = await hostReplaceInterruptedReview({
    ports: ports.value,
    template,
    binding: binding.value,
    branch: prepared.value.pr.branch,
    base: prepared.value.pr.base,
  })
  if (!published.ok) return published
  return { ok: true, value: { ...published.value, input: prepared.value } }
}
