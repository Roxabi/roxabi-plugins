import { command, refText, sameRef } from '../adapters/github-native/debt.ts'
import type { CanonicalRecord } from '../dist/contracts.js'
import {
  decodeHistory,
  githubScope,
  readGitHubHistory,
  validateDecisionBindings,
  validateRetainedUnusableLabels,
} from '../dist/contracts.js'
import type { DebtIssue, ProcessRunner, Source } from './debt-filing-contract.ts'
import { reviewBoundDecision, selectedDecision } from './debt-filing-decision.ts'
import type { DebtFilingInput } from './debt-filing-port.ts'
import { withRoxabiGitHubPolicy } from './github-policy'

export function mismatch(actual: DebtIssue, expected: { title: string; body: string; author: string }): string[] {
  const result: string[] = []
  if (actual.title !== expected.title) result.push('title')
  if (actual.body !== expected.body) result.push('body')
  if (actual.author !== expected.author) result.push('author')
  return result
}

export function relationshipConflict(actual: DebtIssue, source: Source): string[] {
  const conflicts: string[] = []
  if (
    source.parent === null ? actual.parent !== null : actual.parent !== null && !sameRef(actual.parent, source.parent)
  )
    conflicts.push('parent')
  if (
    source.issue === null
      ? actual.blockedBy.length > 0
      : actual.blockedBy.some((entry) => !sameRef(entry, source.issue))
  )
    conflicts.push('blocked-by')
  return conflicts
}

export function missingMetadata(actual: DebtIssue, source: Source): string[] {
  const missing: string[] = []
  if (actual.type?.toLowerCase() !== 'fix') missing.push('--type', 'fix')
  const sizes = actual.labels.filter(
    (label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full',
  )
  if (sizes.length !== 1 || sizes[0] !== `size:${source.size}`) missing.push('--size', source.size)
  if (source.parent !== null && actual.parent === null) missing.push('--parent', refText(source.parent))
  if (source.issue !== null && actual.blockedBy.length === 0) missing.push('--blocked-by', refText(source.issue))
  return missing
}

export async function expectedAuthor(
  input: DebtFilingInput,
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ author: string; decision: Extract<CanonicalRecord, { kind: 'decision' }> }> {
  const options = withRoxabiGitHubPolicy({
    cwd,
    gh: async (cwd, args) => command(runner, 'gh', args, cwd, env),
  })
  const history = decodeHistory(
    await readGitHubHistory(githubScope(input.target.repository, input.target.number), options),
  )
  const decision = selectedDecision(input, history)
  if (decision === null) throw new Error('debt-decision-unconfirmed')
  const bindings = validateDecisionBindings(decision, history)
  if (!bindings.admissible)
    throw new Error(`debt-decision-unbound:${bindings.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`)
  const retainedLabels = validateRetainedUnusableLabels(decision, bindings)
  if (!retainedLabels.ok)
    throw new Error(
      `debt-retained-label-unbound:${retainedLabels.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  if (!reviewBoundDecision(input, decision, bindings.records)) throw new Error('debt-review-binding-unconfirmed')
  if (
    decision.payload.judgment.policy.version === 'evidence-v1' &&
    decision.payload.judgment.policy.acceptanceRef !== input.acceptedEvidencePolicyRef
  ) {
    throw new Error('debt-decision-evidence-policy-unaccepted')
  }
  return { author: history.source.expectedAuthor, decision }
}
