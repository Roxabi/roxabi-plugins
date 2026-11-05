import type { DecodedHistory, GitHubOptions } from '../dist/contracts.js'
import { validateDecisionBindings, validateRecordGraph } from '../dist/contracts.js'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { defaultGh } from './feature-engine.ts'
import type {
  FixActionResult,
  FixRecord,
  FixRequestInput,
  NativePort,
  RecordPublisher,
  ReviewAuthority,
  TargetResolver,
} from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { actionTask } from './fix-native-dispatch.ts'
import { nativeFixProfileByAction } from './native-review-profiles'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { readReviewInputHistories } from './uw-input-readers.ts'
export type DefaultFixRequest = Omit<FixRequestInput, 'nativeTasks'>

export type DefaultFixWorkflow = {
  resolver: TargetResolver
  publisher: RecordPublisher
  dispositionStore: FixDispositionStore
  readHistory(): Promise<DecodedHistory>
  github: GitHubOptions
  workflow?: ReviewAuthority
  native: NativePort
  runtime: FixWorkflowRuntime
}

export function admitDecisionExecution(
  decision: Extract<FixRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): FixActionResult<void> {
  const graph = validateRecordGraph(history)
  if (!graph.ok)
    return failure(
      `correction-execution-admission-invalid:${graph.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  const bindings = validateDecisionBindings(decision, history, catalogues)
  if (!bindings.admissible)
    return failure(
      `correction-synthesis-bindings-invalid:${bindings.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join(',')}`,
    )
  return { ok: true, value: undefined }
}

/** Load evidence for this exact root and its typed external closure. */
export async function executionCatalogues(
  history: DecodedHistory,
  github: GitHubOptions,
): Promise<FixActionResult<ReviewClassCatalogues>> {
  const gh = github.gh ?? defaultGh()
  const external = await readReviewInputHistories(history, { cwd: github.cwd, gh, readAuthor: github.readAuthor })
  if (!external.ok) return failure(...external.diagnostics.map((item) => `${item.code}:${item.message}`))
  const catalogues = await loadReviewClassCatalogues({ histories: [history, ...external.value], cwd: github.cwd, gh })
  return { ok: true, value: catalogues }
}

export function defaultIntakeTask(input: DefaultFixRequest): Omit<NativeTask, 'action'> {
  return actionTask(
    'fix-intake',
    nativeFixProfileByAction.intake,
    `Inspect only correction scope ${input.scope} for ${input.reference ?? input.contextTarget?.target ?? 'bound target'}. Preserve each original finding unchanged and return structured findings; do not classify final labels, merge causes, edit, commit, push, arm, or land.`,
    'bounded correction evidence intake',
  )
}

export function defaultSynthesisTask(): Omit<NativeTask, 'action'> {
  return actionTask(
    'fix-synthesis',
    nativeFixProfileByAction.synthesis,
    'Synthesize one correction-purpose decision from the confirmed contribution records named by the index. Preserve source IDs, original raw associations, exact policy and seven-field causes; do not edit, commit, push, arm, or land.',
    'one correction decision from admitted intake records',
  )
}
