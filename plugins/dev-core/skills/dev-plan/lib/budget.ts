/**
 * Task budget classifier for /plan Step 2d.
 *
 * Each task is assigned a cost class based on the nature of its work.
 * The class drives an ops-range estimate used to flag tasks that exceed
 * the 50-op threshold and require splitting or a DP decision.
 */

export type CostClass = 'trivial' | 'bounded' | 'judgmental' | 'exploratory'

/** Mid-point estimate used for total roll-up. */
export const OPS_MID: Record<CostClass, number> = {
  trivial: 1.5,
  bounded: 2.5,
  judgmental: 5,
  exploratory: 11.5,
}

export interface TaskBudgetInput {
  /** Short task description or title. */
  name: string
  /** Number of discrete items (files, patterns, criteria) the task covers. */
  items: number
  /** Cost class for one item in the task. */
  costClass: CostClass
}

export interface TaskBudgetRow {
  name: string
  items: number
  costClass: CostClass
  /** Estimated total ops = items * mid-point for the class. */
  estimatedOps: number
  /** Whether this task exceeds the 50-op threshold and must be split or flagged. */
  mustSplit: boolean
}

export const SPLIT_THRESHOLD = 50

/**
 * Classify a single task and compute its budget row.
 */
export function classifyTask(input: TaskBudgetInput): TaskBudgetRow {
  const estimatedOps = Math.round(input.items * OPS_MID[input.costClass])
  return {
    name: input.name,
    items: input.items,
    costClass: input.costClass,
    estimatedOps,
    mustSplit: estimatedOps > SPLIT_THRESHOLD,
  }
}

/**
 * Compute budget rows for a list of tasks and return the grand total.
 */
export function computeBudget(inputs: TaskBudgetInput[]): {
  rows: TaskBudgetRow[]
  totalOps: number
} {
  const rows = inputs.map(classifyTask)
  const totalOps = rows.reduce((sum, r) => sum + r.estimatedOps, 0)
  return { rows, totalOps }
}

/**
 * Render the budget table as a Markdown string for inclusion in the plan
 * artifact's Wave Structure section.
 *
 * Example output:
 *
 * | Task | Items | Class | Est. ops | Split? |
 * |------|-------|-------|----------|--------|
 * | Add classifier | 3 | bounded | 8 | — |
 * | Audit all routes | 12 | exploratory | 138 | YES — split required |
 *
 * **Total estimated ops: 146**
 */
export function renderBudgetTable(rows: TaskBudgetRow[]): string {
  const header = '| Task | Items | Class | Est. ops | Split? |'
  const sep = '|------|-------|-------|----------|--------|'
  const dataRows = rows.map((r) => {
    const split = r.mustSplit ? 'YES — split required' : '—'
    return `| ${r.name} | ${r.items} | ${r.costClass} | ${r.estimatedOps} | ${split} |`
  })
  const totalOps = rows.reduce((sum, r) => sum + r.estimatedOps, 0)
  return [header, sep, ...dataRows, '', `**Total estimated ops: ${totalOps}**`].join('\n')
}
