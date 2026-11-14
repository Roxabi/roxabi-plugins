import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Scope } from '../engine/record-values.ts'
import { criterionIdSchema } from '../engine/uw-spec-schema.ts'
import { prepareCanonicalCheckout } from '../roxabi/prepare-canonical-checkout.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { initialMandateReadiness } from '../skills/feature/epic-initial-mandate.ts'
import { A, B, C, EPIC } from '../skills/feature/testing/goal/goal-scenario-domain.ts'
import { git, moduleGh, sandbox, writeSim } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

export async function parentFixture(setup?: string, nested = false) {
  const world = sandbox()
  for (const key of ['PATH', 'HOME', 'GH_SIM_STATE', 'GH_SIM_ORIGIN'] as const) {
    const value = world.env[key]
    if (value !== undefined) vi.stubEnv(key, value)
  }
  vi.stubEnv('OMP_WORKTREE_DIR', join(world.root, 'checkouts'))
  const { framedBodies, identityAllocation } = roxabiWorkflowFixtures()
  writeSim((state) => {
    if (nested) {
      const middle = state.issues[String(A)]
      if (!middle) throw new Error('Missing nested parent')
      state.issues['5'] = Object.assign({}, middle, { number: 5, comments: [], subIssues: [], blockedBy: [] })
      middle.subIssues = [5]
    }
    for (const number of nested ? [EPIC, A, B, C, 5] : [EPIC, A, B, C]) {
      const issue = state.issues[String(number)]
      if (!issue) throw new Error(`missing issue ${number}`)
      const scope = { repository: 'acme/app', target: `acme/app#${number}` }
      issue.comments.push(
        ...framedBodies([identityAllocation(scope)], 'operator').map((body) => ({ author: 'operator', body })),
      )
    }
  })
  const gh = async (_cwd: string, args: string[]) => {
    const result = moduleGh(args)
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const gitPort: GitRunner = async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) }
    }
  }
  const principal = join(world.root, 'principal')
  if (setup !== undefined) {
    const stack = join(principal, '.dev', 'stack.yml')
    const existing = readFileSync(stack, 'utf8')
    if (!existing.startsWith('worktree:\n')) throw new Error('Fixture worktree configuration is missing')
    writeFileSync(stack, existing.replace('worktree:\n', `worktree:\n  setup: ${JSON.stringify(setup)}\n`))
    git(principal, ['add', '.dev/stack.yml'])
    git(principal, ['commit', '-qm', 'configure worktree setup'])
    git(principal, ['push', '-q', 'origin', 'main'])
  }
  git(world.origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const before = git(principal, ['rev-parse', 'HEAD'])
  const prepared = await prepareCanonicalCheckout({ reference: '#1', sessionCwd: principal, gh, git: gitPort })
  if (prepared.status !== 'move') throw new Error(JSON.stringify(prepared))
  const cwd = prepared.path
  if (cwd === world.epic) throw new Error('Adopted unrelated worktree')
  const operator = {
    async executeConfirmed(): Promise<never> {
      throw new Error('Unexpected operator-only UW mutation')
    },
  }
  const operations = await createInstalledUwOperations({ cwd, readAuthor: 'operator', gh, operator })
  const parent = { repository: 'acme/app', target: 'acme/app#1' }
  const child = { repository: 'acme/app', target: 'acme/app#2' }
  const request = {
    cwd,
    reference: '#1',
    control: 'select' as const,
    principal: false,
    git: gitPort,
    gh,
    uw: operations,
  }
  return { world, principal, before, cwd, operations, parent, child, request }
}

export function driverEffects(operations: UwOperations) {
  return {
    git: (directory: string, args: string[]) => git(directory, args),
    gh: (_directory: string, args: string[], input?: string) => {
      const result = moduleGh(args, input)
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    },
    uw: operations,
    uwReadAuthor: 'operator',
  }
}

/** Epic effects that refuse the driver's first GitHub read, stopping the call after its own first Mandate. */
export function heldEpicStep(operations: UwOperations) {
  return {
    ...driverEffects(operations),
    gh: (): string => {
      throw new Error('fixture holds the epic step')
    },
  }
}

/**
 * Epic effects whose live driver step finds the Parent worktree edited after the engine chose `epic-next`.
 * Only that live step fetches, so the engine's own read still observed a clean worktree.
 */
export function editedBeforeLiveEpicStep(operations: UwOperations) {
  const effects = driverEffects(operations)
  return {
    ...effects,
    git: (directory: string, args: string[]) => {
      if (args[0] === 'fetch') writeFileSync(join(directory, 'concurrent-edit.txt'), 'edited after the engine read\n')
      return effects.git(directory, args)
    },
  }
}

export async function coverageIntent(request: Parameters<typeof continueFeature>[0]) {
  const pending = await continueFeature(request)
  if (pending.kind !== 'blocked' || !pending.coverageRequest) throw new Error(JSON.stringify(pending))
  const [firstChild, ...remainingChildren] = pending.coverageRequest.children
  if (firstChild === undefined) throw new Error('Parent has no committed children')
  const childScopes: [Scope, ...Scope[]] = [firstChild.scope, ...remainingChildren.map((entry) => entry.scope)]
  return {
    parentCoverageBasis: pending.coverageRequest,
    parentCoverage: {
      parent: pending.coverageRequest.parent,
      assignments: pending.coverageRequest.criteria.map((criterion) => ({
        criterion: criterionIdSchema.parse(criterion.id),
        children: childScopes,
      })),
    },
  }
}

export async function observeInitialChild(operations: UwOperations, parent: Scope, child: Scope) {
  const parentRead = await operations.readUw(parent)
  if (!parentRead.observedReader) throw new Error('Expected same-cut observed reader')
  const childRead = await parentRead.observedReader.readUw(child)
  return {
    parent: parentRead,
    child: childRead,
    readiness: await initialMandateReadiness(parentRead, parentRead.admission, childRead),
  }
}
