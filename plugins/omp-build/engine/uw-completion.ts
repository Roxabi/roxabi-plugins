import { isWorkflowKind } from './record-references.ts'
import type { Scope } from './record-values.ts'
import { assessManagedCompletion } from './uw-completion-managed.ts'
import { assessNativeOnly } from './uw-completion-native.ts'
import type {
  DependencyBasis,
  DependencyResolution,
  UwCompletion,
  UwCompletionAssessment,
  UwCompletionObservation,
} from './uw-completion-types.ts'
import { buildObservedCommitIndex } from './uw-delivery-lineage.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { sameScope, scopeKey, validateUwGraph } from './uw-graph.ts'
import { projectUwWaits } from './uw-waits.ts'
import { mandatesOf } from './workflow-control.ts'

function issue(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function relevantOperations(history: UwCompletionObservation['histories'][number]) {
  const relevantKind = (kind: string) => isWorkflowKind(kind) || kind === 'debt-receipt'
  return history.operations.filter(
    (operation) =>
      relevantKind(operation.record?.kind ?? operation.kind ?? '') ||
      operation.claimedKinds.some(relevantKind) ||
      (operation.kind === null && operation.claimedKinds.length === 0 && operation.status !== 'complete'),
  )
}

function hasUnconfirmedOperations(relevant: UwCompletionObservation['histories'][number]['operations']): boolean {
  return relevant.some(
    (operation) => operation.authority === 'foreign' || operation.status !== 'complete' || operation.record === null,
  )
}

function uniqueCompleteHistory(uw: Scope, histories: UwCompletionObservation['histories']) {
  const matches = histories.filter((history) => sameScope(history.source.scope, uw))
  const history = matches[0]
  if (
    matches.length !== 1 ||
    history === undefined ||
    !history.source.complete ||
    history.source.diagnostics.length > 0 ||
    history.diagnostics.length > 0
  )
    return null
  return history
}

function refusalRecorder(
  uw: Scope,
  key: string,
  observation: UwCompletionObservation,
  dependencies: Map<string, DependencyResolution>,
  completions: Map<string, UwCompletion>,
) {
  return (
    basis: DependencyBasis,
    state: 'not-complete' | 'indeterminate' | 'abandoned',
    problem: UwDiagnostic,
    managed: boolean,
  ): DependencyResolution => {
    const problems: [UwDiagnostic, ...UwDiagnostic[]] = [problem]
    if (
      managed &&
      state !== 'abandoned' &&
      observation.graph.nodes.some((node) => sameScope(node.uw, uw) && node.native.state === 'CLOSED')
    )
      problems.push(
        issue(
          uw,
          'native-closure-unproven',
          'Native closure does not establish calculated completion; reopen or record abandonment',
        ),
      )
    const completion: UwCompletion | null = managed ? { state, uw, diagnostics: problems } : null
    const resolution: DependencyResolution = { uw, basis, state: 'held', completion, diagnostics: problems }
    if (completion) completions.set(key, completion)
    dependencies.set(key, resolution)
    return resolution
  }
}

export function assessUwCompletion(observation: UwCompletionObservation): UwCompletionAssessment {
  const waits = projectUwWaits(observation)
  const graphProblems = validateUwGraph(observation.graph).diagnostics
  const diagnostics: UwDiagnostic[] = [...graphProblems, ...waits.diagnostics]
  const commitIndex = buildObservedCommitIndex(observation)
  if (!commitIndex.ok && observation.status === 'complete') diagnostics.push(...commitIndex.diagnostics)
  if (observation.status === 'incomplete') diagnostics.push(...observation.diagnostics)
  const dependencies = new Map<string, DependencyResolution>()
  const completions = new Map<string, UwCompletion>()
  const visiting = new Set<string>()
  const assess = (uw: Scope): DependencyResolution => {
    const key = scopeKey(uw)
    const existing = dependencies.get(key)
    if (existing) return existing
    const refuse = refusalRecorder(uw, key, observation, dependencies, completions)
    const unresolved = (code: string, message: string) => {
      const problem = issue(uw, code, message)
      return refuse({ kind: 'unresolved', diagnostics: [problem] }, 'indeterminate', problem, false)
    }
    if (visiting.has(key)) return unresolved('wait-cycle', 'Dependency cycle prevents completion')
    if (
      observation.status !== 'complete' ||
      graphProblems.length ||
      waits.diagnostics.some((d) => d.code === 'wait-cycle')
    )
      return unresolved('observation-incomplete', 'Complete concordant graph and wait closure are required')
    const history = uniqueCompleteHistory(uw, observation.histories)
    if (history === null) return unresolved('history-incomplete', 'A unique complete UW history is required')
    const node = observation.graph.nodes.find((candidate) => sameScope(candidate.uw, uw))
    if (!node) return unresolved('graph-incomplete', 'Dependency native state was not observed')
    const relevant = relevantOperations(history)
    if (hasUnconfirmedOperations(relevant))
      return unresolved(
        'history-unconfirmed',
        'Relevant foreign or incomplete workflow claims prevent an absence witness',
      )
    const mandates = mandatesOf(history)
    const latest = mandates[mandates.length - 1]
    if (!latest)
      return assessNativeOnly({
        uw,
        history,
        node,
        observation,
        waits,
        relevant,
        key,
        dependencies,
        issue,
        refuse,
        unresolved,
      })
    return assessManagedCompletion({
      uw,
      key,
      history,
      node,
      latest,
      observation,
      waits,
      dependencies,
      completions,
      visiting,
      commitIndex,
      issue,
      refuse,
      assess,
    })
  }
  for (const uw of waits.requiredScopes) assess(uw)
  assess(observation.root)
  return { waits, dependencies, completions, diagnostics }
}
