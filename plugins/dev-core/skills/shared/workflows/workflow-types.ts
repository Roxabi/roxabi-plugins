export type WorkflowTestRunner = 'vitest' | 'jest' | 'pytest' | 'bun' | 'none'

/** Release train mode (#371). `staging-train` = the default staging→main flow;
 * `trunk` = version+tag+release derived on every merge-to-main (Model B). */
export type ReleaseModel = 'staging-train' | 'trunk'

export interface WorkflowRelease {
  model: ReleaseModel
  /** `<component>` half of the `<component>/vX.Y.Z` tag — baked into auto-release.yml. */
  component: string
}

export interface WorkflowOpts {
  stack: 'bun' | 'node' | 'python'
  test: WorkflowTestRunner
  /** Verbatim σ.commands.test — preferred for the CI `run:` line when set. */
  testCommand?: string
  deploy: 'vercel' | 'cloudflare' | 'none'
  /** merge-on-green for private free-plan repos; default auto-merge */
  merge?: 'auto-merge' | 'merge-on-green'
  e2e?: 'playwright' | 'none'
  lint?: boolean
  typecheck?: boolean
  /** Release mode + component. Absent → staging-train (existing behavior). */
  release?: WorkflowRelease
}

export function normalizeWorkflowOpts(opts: WorkflowOpts): Required<WorkflowOpts> {
  return {
    stack: opts.stack,
    test: opts.test,
    testCommand: opts.testCommand ?? '',
    deploy: opts.deploy,
    merge: opts.merge ?? 'auto-merge',
    e2e: opts.e2e ?? 'none',
    lint: opts.lint ?? true,
    typecheck: opts.typecheck ?? true,
    release: opts.release ?? { model: 'staging-train', component: '' },
  }
}

/** YAML list for `on.*.branches`. Trunk has no staging branch. */
export function triggerBranches(opts?: Pick<WorkflowOpts, 'release'>): string {
  return (opts?.release?.model ?? 'staging-train') === 'trunk' ? '[main]' : '[main, staging]'
}

/** Flag wins; else stack.yml; else staging-train. Empty flag is absent. */
export function resolveRelease(
  flag?: { model?: string; component?: string },
  stack?: { model?: string | null; component?: string | null } | null,
): WorkflowRelease {
  const model: ReleaseModel =
    flag?.model === 'trunk' || flag?.model === 'staging-train'
      ? flag.model
      : stack?.model === 'trunk' || stack?.model === 'staging-train'
        ? stack.model
        : 'staging-train'
  return { model, component: flag?.component || stack?.component || '' }
}
