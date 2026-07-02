export interface WorkflowOpts {
  stack: 'bun' | 'node' | 'python'
  test: 'vitest' | 'jest' | 'pytest' | 'none'
  deploy: 'vercel' | 'cloudflare' | 'none'
  /** merge-on-green for private free-plan repos; default auto-merge */
  merge?: 'auto-merge' | 'merge-on-green'
  e2e?: 'playwright' | 'none'
  lint?: boolean
  typecheck?: boolean
}

export function normalizeWorkflowOpts(opts: WorkflowOpts): Required<WorkflowOpts> {
  return {
    stack: opts.stack,
    test: opts.test,
    deploy: opts.deploy,
    merge: opts.merge ?? 'auto-merge',
    e2e: opts.e2e ?? 'none',
    lint: opts.lint ?? true,
    typecheck: opts.typecheck ?? true,
  }
}
