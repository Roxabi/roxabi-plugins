/**
 * Injectable, complete-read issue writer.
 *
 * This is deliberately independent from argv, console output, process exit,
 * repository discovery and UW policy. Consumers supply the repository and the
 * complete reader/mutation primitives explicitly.
 */
const REPOSITORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export type IssueRef = {
  repository: string
  number: number
}

export type NativeIssueWritePlan = {
  repository: string
  title?: string
  body: string
  labels: { add: readonly string[]; remove: readonly string[] }
  relations: {
    parent?: IssueRef | null
    addChildren: readonly IssueRef[]
    removeChildren: readonly IssueRef[]
    addBlockers: readonly IssueRef[]
    removeBlockers: readonly IssueRef[]
  }
}

export type IssueWriteObservation = {
  issue: IssueRef
  title: string
  body: string
  updatedAt: string
  labels: readonly string[]
  parent: IssueRef | null
  children: readonly IssueRef[]
  blockers: readonly IssueRef[]
}

export type WriteDiagnostic = {
  code: string
  message: string
  issue?: IssueRef
}

export type IssueWriteResult =
  | { status: 'written'; observed: IssueWriteObservation }
  | { status: 'partial'; issue: IssueRef; completed: readonly string[]; diagnostics: readonly WriteDiagnostic[] }
  | { status: 'uncertain'; completed: readonly string[]; diagnostics: readonly WriteDiagnostic[] }
  | { status: 'refused'; diagnostics: readonly WriteDiagnostic[] }

/**
 * Ports are deliberately small mutation primitives. `read` must return complete
 * title/body/labels/parent/children/blockers facts for the one native issue.
 */
export interface IssueWritePorts {
  read(issue: IssueRef): Promise<IssueWriteObservation>
  create(input: { repository: string; title: string; body: string }): Promise<IssueRef>
  patch(issue: IssueRef, input: { title?: string; body: string }): Promise<void>
  updateLabels(issue: IssueRef, input: { add: readonly string[]; remove: readonly string[] }): Promise<void>
  addChild(parent: IssueRef, child: IssueRef): Promise<void>
  removeChild(parent: IssueRef, child: IssueRef): Promise<void>
  addBlocker(issue: IssueRef, blocker: IssueRef): Promise<void>
  removeBlocker(issue: IssueRef, blocker: IssueRef): Promise<void>
}

export interface IssueWriter {
  create(plan: NativeIssueWritePlan): Promise<IssueWriteResult>
  update(issue: IssueRef, plan: NativeIssueWritePlan, expected: IssueWriteObservation): Promise<IssueWriteResult>
}

const keyOf = (ref: IssueRef): string => `${ref.repository}#${ref.number}`

function sameRef(left: IssueRef, right: IssueRef): boolean {
  return left.repository === right.repository && left.number === right.number
}

function sameRefSet(left: readonly IssueRef[], right: readonly IssueRef[]): boolean {
  if (left.length !== right.length) return false
  const rightKeys = new Set(right.map(keyOf))
  return left.every((ref) => rightKeys.has(keyOf(ref)))
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightValues = new Set(right)
  return left.every((value) => rightValues.has(value))
}

/**
 * `updatedAt` is descriptive native metadata, deliberately not a write
 * precondition. A durable identity comment can advance it while every asserted
 * native issue fact remains unchanged.
 */
function sameAssertedObservation(left: IssueWriteObservation, right: IssueWriteObservation): boolean {
  return (
    sameRef(left.issue, right.issue) &&
    left.title === right.title &&
    left.body === right.body &&
    sameStringSet(left.labels, right.labels) &&
    ((left.parent === null && right.parent === null) ||
      (left.parent !== null && right.parent !== null && sameRef(left.parent, right.parent))) &&
    sameRefSet(left.children, right.children) &&
    sameRefSet(left.blockers, right.blockers)
  )
}

function diagnostic(code: string, message: string, issue?: IssueRef): WriteDiagnostic {
  return issue ? { code, message, issue } : { code, message }
}

function validateRef(ref: IssueRef, field: string): WriteDiagnostic | undefined {
  if (!ref || typeof ref !== 'object' || !REPOSITORY_SLUG.test(ref.repository)) {
    return diagnostic('write-invalid-reference', `${field} has an invalid repository reference`)
  }
  if (!Number.isSafeInteger(ref.number) || ref.number < 1) {
    return diagnostic('write-invalid-reference', `${field} has an invalid issue number`)
  }
  return undefined
}

function validateList(refs: readonly IssueRef[], field: string): WriteDiagnostic | undefined {
  const seen = new Set<string>()
  for (const ref of refs) {
    const invalid = validateRef(ref, field)
    if (invalid) return invalid
    const key = keyOf(ref)
    if (seen.has(key)) return diagnostic('write-invalid-reference', `${field} repeats ${key}`)
    seen.add(key)
  }
  return undefined
}

function validateLabels(labels: NativeIssueWritePlan['labels']): WriteDiagnostic | undefined {
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const label of labels.add) {
    if (typeof label !== 'string' || label.trim() === '') {
      return diagnostic('write-invalid-label', 'Added labels must be non-empty strings')
    }
    if (added.has(label)) return diagnostic('write-invalid-label', `Added label repeats ${label}`)
    added.add(label)
  }
  for (const label of labels.remove) {
    if (typeof label !== 'string' || label.trim() === '') {
      return diagnostic('write-invalid-label', 'Removed labels must be non-empty strings')
    }
    if (removed.has(label)) return diagnostic('write-invalid-label', `Removed label repeats ${label}`)
    if (added.has(label)) return diagnostic('write-invalid-label', `Label is both added and removed: ${label}`)
    removed.add(label)
  }
  return undefined
}

function validatePlan(plan: NativeIssueWritePlan, requiresTitle: boolean): WriteDiagnostic | undefined {
  if (!plan || typeof plan !== 'object' || !REPOSITORY_SLUG.test(plan.repository)) {
    return diagnostic('write-invalid-plan', 'Plan repository must be an owner/repository slug')
  }
  if (typeof plan.body !== 'string') return diagnostic('write-invalid-plan', 'Plan body must be a string')
  if (requiresTitle && (typeof plan.title !== 'string' || plan.title.trim() === '')) {
    return diagnostic('write-invalid-plan', 'Create plans require a non-empty title')
  }
  if (plan.title !== undefined && (typeof plan.title !== 'string' || plan.title.trim() === '')) {
    return diagnostic('write-invalid-plan', 'Plan title must be a non-empty string when supplied')
  }
  if (
    !plan.labels ||
    typeof plan.labels !== 'object' ||
    !Array.isArray(plan.labels.add) ||
    !Array.isArray(plan.labels.remove)
  ) {
    return diagnostic('write-invalid-plan', 'Plan labels must contain add and remove arrays')
  }
  const labels = validateLabels(plan.labels)
  if (labels) return labels
  const { relations } = plan
  if (!relations || typeof relations !== 'object')
    return diagnostic('write-invalid-plan', 'Plan relations are required')
  if (relations.parent !== undefined && relations.parent !== null) {
    const parent = validateRef(relations.parent, 'parent')
    if (parent) return parent
  }
  for (const [field, refs] of [
    ['addChildren', relations.addChildren],
    ['removeChildren', relations.removeChildren],
    ['addBlockers', relations.addBlockers],
    ['removeBlockers', relations.removeBlockers],
  ] as const) {
    if (!Array.isArray(refs)) return diagnostic('write-invalid-plan', `${field} must be an array`)
    const invalid = validateList(refs, field)
    if (invalid) return invalid
  }
  for (const [kind, added, removed] of [
    ['child', relations.addChildren, relations.removeChildren],
    ['blocker', relations.addBlockers, relations.removeBlockers],
  ] as const) {
    if (added.some((ref) => removed.some((other) => sameRef(ref, other)))) {
      return diagnostic('write-invalid-reference', `Plan both adds and removes the same ${kind}`)
    }
  }
  return undefined
}

function planReferences(plan: NativeIssueWritePlan): readonly IssueRef[] {
  const refs = [
    ...(plan.relations.parent === null || plan.relations.parent === undefined ? [] : [plan.relations.parent]),
    ...plan.relations.addChildren,
    ...plan.relations.removeChildren,
    ...plan.relations.addBlockers,
    ...plan.relations.removeBlockers,
  ]
  return [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()]
}

function hasRef(refs: readonly IssueRef[], wanted: IssueRef): boolean {
  return refs.some((ref) => sameRef(ref, wanted))
}

function applyRefChanges(
  base: readonly IssueRef[],
  add: readonly IssueRef[],
  remove: readonly IssueRef[],
): readonly IssueRef[] {
  return [...base.filter((ref) => !hasRef(remove, ref)), ...add.filter((ref) => !hasRef(base, ref))]
}

function applyLabelChanges(
  base: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): readonly string[] {
  return [...base.filter((label) => !remove.includes(label)), ...add.filter((label) => !base.includes(label))]
}

function desiredObservation(
  issue: IssueRef,
  baseline: IssueWriteObservation,
  plan: NativeIssueWritePlan,
): Omit<IssueWriteObservation, 'updatedAt'> {
  return {
    issue,
    title: plan.title ?? baseline.title,
    body: plan.body,
    labels: applyLabelChanges(baseline.labels, plan.labels.add, plan.labels.remove),
    parent: plan.relations.parent === undefined ? baseline.parent : plan.relations.parent,
    children: applyRefChanges(baseline.children, plan.relations.addChildren, plan.relations.removeChildren),
    blockers: applyRefChanges(baseline.blockers, plan.relations.addBlockers, plan.relations.removeBlockers),
  }
}

function matchesDesired(observed: IssueWriteObservation, desired: Omit<IssueWriteObservation, 'updatedAt'>): boolean {
  return (
    sameRef(observed.issue, desired.issue) &&
    observed.title === desired.title &&
    observed.body === desired.body &&
    sameStringSet(observed.labels, desired.labels) &&
    ((observed.parent === null && desired.parent === null) ||
      (observed.parent !== null && desired.parent !== null && sameRef(observed.parent, desired.parent))) &&
    sameRefSet(observed.children, desired.children) &&
    sameRefSet(observed.blockers, desired.blockers)
  )
}

async function preflightReferences(
  ports: IssueWritePorts,
  plan: NativeIssueWritePlan,
): Promise<WriteDiagnostic | undefined> {
  for (const reference of planReferences(plan)) {
    try {
      const observed = await ports.read(reference)
      if (!sameRef(observed.issue, reference)) {
        return diagnostic(
          'write-conflict',
          `Reference read returned a different issue for ${keyOf(reference)}`,
          reference,
        )
      }
    } catch (error) {
      return diagnostic(
        'reference-unreadable',
        `Cannot read ${keyOf(reference)}: ${(error as Error).message}`,
        reference,
      )
    }
  }
  return undefined
}

async function applyPlan(
  ports: IssueWritePorts,
  issue: IssueRef,
  plan: NativeIssueWritePlan,
  baseline: IssueWriteObservation,
  completed: string[],
): Promise<IssueWriteResult> {
  try {
    if (plan.labels.add.length || plan.labels.remove.length) {
      await ports.updateLabels(issue, plan.labels)
      completed.push('labels')
    }
    for (const blocker of plan.relations.addBlockers) {
      await ports.addBlocker(issue, blocker)
      completed.push(`add-blocker:${keyOf(blocker)}`)
    }
    for (const blocker of plan.relations.removeBlockers) {
      await ports.removeBlocker(issue, blocker)
      completed.push(`remove-blocker:${keyOf(blocker)}`)
    }
    if (plan.relations.parent !== undefined) {
      if (baseline.parent) {
        await ports.removeChild(baseline.parent, issue)
        completed.push(`remove-parent:${keyOf(baseline.parent)}`)
      }
      if (plan.relations.parent) {
        await ports.addChild(plan.relations.parent, issue)
        completed.push(`set-parent:${keyOf(plan.relations.parent)}`)
      }
    }
    for (const child of plan.relations.addChildren) {
      await ports.addChild(issue, child)
      completed.push(`add-child:${keyOf(child)}`)
    }
    for (const child of plan.relations.removeChildren) {
      await ports.removeChild(issue, child)
      completed.push(`remove-child:${keyOf(child)}`)
    }
    await ports.patch(issue, { title: plan.title, body: plan.body })
    completed.push('patch')
  } catch (error) {
    return {
      status: 'partial',
      issue,
      completed,
      diagnostics: [
        diagnostic(
          'write-failed',
          `Write failed after ${completed.join(', ') || 'no steps'}: ${(error as Error).message}`,
          issue,
        ),
      ],
    }
  }

  try {
    const observed = await ports.read(issue)
    if (!matchesDesired(observed, desiredObservation(issue, baseline, plan))) {
      return {
        status: 'partial',
        issue,
        completed,
        diagnostics: [
          diagnostic('write-conflict', `Readback did not match the asserted write plan for ${keyOf(issue)}`, issue),
        ],
      }
    }
    return { status: 'written', observed }
  } catch (error) {
    return {
      status: 'partial',
      issue,
      completed,
      diagnostics: [
        diagnostic('readback-unconfirmed', `Cannot read back ${keyOf(issue)}: ${(error as Error).message}`, issue),
      ],
    }
  }
}

/** Construct a writer that refuses stale observations and reports partial effects exactly. */
export function createIssueWriter(ports: IssueWritePorts): IssueWriter {
  return {
    async create(plan): Promise<IssueWriteResult> {
      const invalid = validatePlan(plan, true)
      if (invalid) return { status: 'refused', diagnostics: [invalid] }
      const unreadable = await preflightReferences(ports, plan)
      if (unreadable) return { status: 'refused', diagnostics: [unreadable] }
      const title = plan.title
      if (title === undefined) {
        return { status: 'refused', diagnostics: [diagnostic('write-invalid-plan', 'Create plan title is required')] }
      }

      let issue: IssueRef
      try {
        issue = await ports.create({ repository: plan.repository, title, body: plan.body })
      } catch (error) {
        return {
          status: 'uncertain',
          completed: [],
          diagnostics: [
            diagnostic(
              'create-unconfirmed',
              `Create may have reached GitHub but did not return a usable issue reference: ${(error as Error).message}`,
            ),
          ],
        }
      }
      const invalidIssue = validateRef(issue, 'created issue')
      if (invalidIssue) return { status: 'partial', issue, completed: ['create'], diagnostics: [invalidIssue] }
      if (issue.repository !== plan.repository) {
        return {
          status: 'partial',
          issue,
          completed: ['create'],
          diagnostics: [diagnostic('write-conflict', `Create returned ${keyOf(issue)} for ${plan.repository}`, issue)],
        }
      }

      const baseline: IssueWriteObservation = {
        issue,
        title,
        body: plan.body,
        updatedAt: '',
        labels: [],
        parent: null,
        children: [],
        blockers: [],
      }
      return applyPlan(ports, issue, plan, baseline, ['create'])
    },

    async update(issue, plan, expected): Promise<IssueWriteResult> {
      const invalidIssue = validateRef(issue, 'issue')
      if (invalidIssue) return { status: 'refused', diagnostics: [invalidIssue] }
      const invalid = validatePlan(plan, false)
      if (invalid) return { status: 'refused', diagnostics: [invalid] }
      if (plan.repository !== issue.repository) {
        return {
          status: 'refused',
          diagnostics: [
            diagnostic(
              'write-invalid-plan',
              `Plan repository ${plan.repository} does not match ${keyOf(issue)}`,
              issue,
            ),
          ],
        }
      }
      if (!sameRef(expected.issue, issue)) {
        return {
          status: 'refused',
          diagnostics: [diagnostic('write-conflict', `Expected observation is not for ${keyOf(issue)}`, issue)],
        }
      }

      let current: IssueWriteObservation
      try {
        current = await ports.read(issue)
      } catch (error) {
        return {
          status: 'refused',
          diagnostics: [
            diagnostic('read-unavailable', `Cannot read ${keyOf(issue)}: ${(error as Error).message}`, issue),
          ],
        }
      }
      if (!sameAssertedObservation(current, expected)) {
        return {
          status: 'refused',
          diagnostics: [diagnostic('write-conflict', `Current observation is stale for ${keyOf(issue)}`, issue)],
        }
      }
      const unreadable = await preflightReferences(ports, plan)
      if (unreadable) return { status: 'refused', diagnostics: [unreadable] }
      return applyPlan(ports, issue, plan, current, [])
    },
  }
}
