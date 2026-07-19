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
