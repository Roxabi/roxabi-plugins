import type { AppliedCauseContext } from './correction-action'
import type {
  CorrectionEffectResult,
  NativeCorrectionExecutionOptions,
  NativeDispatchResult,
} from './correction-execution-contract'
import type { CorrectionGitState } from './correction-git-state'

export type CorrectionNativeRuntime = {
  options: NativeCorrectionExecutionOptions
  git: CorrectionGitState
  expectedHead(): string | null
  setExpectedHead(head: string): void
  ownedCommits: string[]
  appliedByCause: Map<string, AppliedCauseContext>
  abortFence<T>(): CorrectionEffectResult<T> | null
  dispatch(
    binding: Parameters<NativeCorrectionExecutionOptions['bindAction']>[0],
  ): Promise<CorrectionEffectResult<NativeDispatchResult>>
}

export function correctionAbortFence<T>(signal: AbortSignal): CorrectionEffectResult<T> | null {
  return signal.aborted ? { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] } : null
}
