import type { FailedCheckFailure } from '../engine/record-digests.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'

export type ModelActionInput =
  | {
      action: 'attribute-ci'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      ciEvidence: {
        evidenceDigest: string
        failures: FailedCheckFailure[]
        supplied: unknown
        candidateGitSHA: string
        scope: Scope
        acceptedSemanticContext: string
      }
    }
  | {
      action: 'assess-spec'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      assessExact: AssessSpecExact
    }
  | {
      action: 'implement'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      approved: {
        specBlock: string
        requirementsBlock: string
        acceptanceLine?: string
      }
      planBlock: string
    }

export function batch(operationId: string, tasks: { name: string; agent: string; task: string }[]): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'omp-build workflow action',
      tasks: tasks.map((item) => ({
        name: item.name,
        agent: item.agent,
        task: item.task,
        solutionSpace: 'one named workflow action; no second review loop',
      })),
    },
  }
}

function actionAgent(action: ModelActionInput['action']): string {
  if (action === 'assess-spec') return 'R-workflow-assess-spec'
  if (action === 'attribute-ci') return 'R-workflow-attribute-ci'
  return 'R-workflow-implement'
}

function actionTask(input: ModelActionInput): string {
  if (input.action === 'implement') {
    return [
      `Implement the confirmed plan in this worktree for ${input.scope.target}.`,
      input.approved.acceptanceLine ?? 'Acceptance criteria: (none).',
      input.approved.specBlock ?? 'Accepted Spec: (missing).',
      input.planBlock ?? 'Confirmed plan: (missing).',
      'Use only the accepted Spec and confirmed plan above with the mandate effective additionalRequirements; do not substitute local or current defaults.',
      'Run the changed path. Update affected docs. For a frontend or shared UI surface, record browser URL, steps, and observed result, or run the declared test_e2e command. Do not record ui-manual-only when test_e2e is declared. Stage only task-owned files. Commit with a Conventional subject ending (#N). Never use git add -A, git add --all, or the git add . form. If a hook fails because dependencies are missing, run commands.install from .dev/stack.yml, then retry with hooks on. Never pass --no-verify or otherwise skip or disable hooks (including -n, LEFTHOOK=0, or core.hooksPath). If a hook stays red outside approved scope, return blocked naming the hook and failure; do not commit around it.',
    ].join('\n')
  }
  if (input.action === 'attribute-ci') {
    const { ciEvidence } = input
    if (ciEvidence !== undefined) {
      return [
        `Attribute the current CI failures for ${input.scope.target}.`,
        `candidateGitSHA=${ciEvidence.candidateGitSHA}`,
        `scope=${JSON.stringify(ciEvidence.scope)}`,
        `evidenceDigest=${ciEvidence.evidenceDigest}`,
        ciEvidence.acceptedSemanticContext,
        'Use only the retained native failure evidence and the approved change scope facts below. Return structured attribution only. Do not implement a repair.',
        `failures=${JSON.stringify(ciEvidence.failures)}`,
        `supplied=${JSON.stringify(ciEvidence.supplied)}`,
      ].join('\n')
    }
  }
  if (input.action === 'assess-spec') {
    return [
      `Assess canonical Spec change for ${input.scope.target}. Return only the structured classification. Do not implement a semantic repair.`,
      `acceptedVersion=${input.assessExact.accepted.ref.version}`,
      `proposedVersion=${input.assessExact.proposed.snapshot.spec.version}`,
      `acceptedTier=${input.assessExact.accepted.tier}`,
      `proposedTier=${input.assessExact.proposed.tier}`,
      'acceptedCanonicalSpec:',
      JSON.stringify(input.assessExact.accepted.snapshot.spec),
      'proposedCanonicalSpec:',
      JSON.stringify(input.assessExact.proposed.snapshot.spec),
      `acceptedChildren=${JSON.stringify(input.assessExact.accepted.children)}`,
      `proposedChildren=${JSON.stringify(input.assessExact.proposed.children)}`,
      `mechanical=${JSON.stringify(input.assessExact.mechanical)}`,
    ].join('\n')
  }
  return `Perform the named ${input.action} action for ${input.scope.target}. Return only the structured classification. Do not implement a semantic repair.`
}

export function modelAction(input: ModelActionInput): ContinueFeatureResult {
  const { action, start, operationId } = input
  const agent = actionAgent(action)
  const task = actionTask(input)
  return {
    kind: 'action',
    node: action,
    start,
    followUp: batch(operationId, [{ name: agent, agent, task }]),
  }
}
