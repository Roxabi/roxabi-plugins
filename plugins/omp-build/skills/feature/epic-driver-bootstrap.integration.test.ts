import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { continueFeature } from '../../roxabi/workflow.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { gather } from './epic-driver-gather'
import { withEpicEffects } from './epic-driver-runtime'
import { nextStep } from './epic-next-step'
import { A, B, EPIC, RUN_A } from './testing/goal/goal-scenario-domain.ts'
import { frameGoalChildren } from './testing/goal/goal-scenario-records.ts'
import { dispose, gh, git, sandbox, writeSim } from './testing/goal/goal-scenario-sandbox.ts'

afterEach(dispose)

it('continues an allocated child through its real first mandate while pre-mandate dependencies remain held', async () => {
  const world = sandbox()
  frameGoalChildren([])
  const repository = gh(['repo', 'view', '--json', 'defaultBranchRef'])
  if (repository.status !== 0) throw new Error(repository.stderr)
  const metadata: unknown = JSON.parse(repository.stdout)
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    !('defaultBranchRef' in metadata) ||
    metadata.defaultBranchRef === null ||
    typeof metadata.defaultBranchRef !== 'object' ||
    !('name' in metadata.defaultBranchRef) ||
    typeof metadata.defaultBranchRef.name !== 'string'
  )
    throw new Error('Native repository default branch is unavailable')
  const branchRef = `refs/heads/${metadata.defaultBranchRef.name}`
  git(world.origin, ['rev-parse', '--verify', `${branchRef}^{commit}`])
  git(world.origin, ['symbolic-ref', 'HEAD', branchRef])
  git(world.epic, ['remote', 'set-head', 'origin', metadata.defaultBranchRef.name])
  expect(git(world.epic, ['branch', '--show-current'])).toBe('')
  expect(git(world.epic, ['rev-parse', 'HEAD'])).toBe(
    git(world.epic, ['rev-parse', `refs/remotes/origin/${metadata.defaultBranchRef.name}`]),
  )
  expect(git(world.epic, ['branch', '--list', 'feature/1-parent'])).toBe('')
  const transport = (_cwd: string, args: string[], input?: string): string => {
    const result = gh([...args], input)
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const ghPort = async (cwd: string, args: string[]) => transport(cwd, args)
  const gitPort: GitRunner = async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) }
    }
  }
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: {
      async confirm() {
        return true
      },
    },
    localProtocolOptions: { getArtifactsDir: () => world.root },
  } as unknown as ExtensionContext)
  const operations = await createInstalledUwOperations({
    cwd: world.epic,
    readAuthor: 'operator',
    gh: ghPort,
    operator,
  })
  const parent = { repository: 'acme/app', target: `acme/app#${EPIC}` }
  const child = { repository: 'acme/app', target: `acme/app#${A}` }
  const sibling = { repository: 'acme/app', target: `acme/app#${B}` }
  const before = await operations.readUw(parent)
  if (before.observation.status !== 'complete' || before.accepted.status !== 'accepted' || !before.observedReader)
    throw new Error('Expected complete accepted Parent observation')
  const parentMandate = before.histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.authority !== 'foreign' &&
        operation.record?.kind === 'mandate' &&
        operation.record.target === parent.target,
    )?.record
  if (parentMandate?.kind !== 'mandate') throw new Error('Parent mandate missing from authenticated history')
  expect(parentMandate.payload.branch).toBeNull()
  expect((await before.observedReader.readUw(child)).accepted.status).toBe('absent')
  expect(before.completion.dependencies.get(`${child.repository}\0${child.target}`)?.state).toBe('held')
  expect(before.completion.dependencies.get(`${sibling.repository}\0${sibling.target}`)?.state).toBe('held')
  const effects = {
    git: (cwd: string, args: string[]) => git(cwd, args),
    gh: transport,
    uw: operations,
    uwReadAuthor: 'operator',
  }
  const initial = await withEpicEffects(
    effects,
    async () => (await gather(world.epic, EPIC, RUN_A, 'main', { dashboard: false, reviews: false })).facts,
  )
  expect(nextStep(initial)).toMatchObject({ action: 'start', ticket: A })
  const result = await withEpicEffects(effects, () =>
    continueFeature({
      cwd: world.epic,
      reference: `#${EPIC}`,
      control: 'continue',
      principal: false,
      git: gitPort,
      gh: ghPort,
      uw: operations,
    }),
  )
  const after = await operations.readUw(child)
  expect(after.accepted.status, JSON.stringify(result)).toBe('accepted')
  if (after.accepted.status !== 'accepted') throw new Error('Child mandate was not confirmed by readback')
  expect(after.accepted.value.inheritedOwnSpecRefs[0]).toEqual(before.accepted.value.ref)
  expect(
    after.histories
      .flatMap((history) => history.operations)
      .filter(
        (operation) =>
          operation.authority !== 'foreign' &&
          operation.record?.kind === 'mandate' &&
          operation.record.target === child.target &&
          operation.status === 'complete',
      ),
  ).toHaveLength(1)
})

it('never schedules native closure as completion for an allocated unmandated blocker', async () => {
  const world = sandbox()
  frameGoalChildren([])
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing allocated child')
    issue.state = 'CLOSED'
    issue.stateReason = 'COMPLETED'
  })
  const transport = (_cwd: string, args: string[], input?: string) => {
    const result = gh([...args], input)
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: {
      async confirm() {
        return true
      },
    },
    localProtocolOptions: { getArtifactsDir: () => world.root },
  } as unknown as ExtensionContext)
  const operations = await createInstalledUwOperations({
    cwd: world.epic,
    readAuthor: 'operator',
    gh: async (cwd, args) => transport(cwd, args),
    operator,
  })
  const parent = await operations.readUw({ repository: 'acme/app', target: `acme/app#${EPIC}` })
  const resolution = parent.completion.dependencies.get(`acme/app\0acme/app#${A}`)
  expect(resolution).toMatchObject({ state: 'held', basis: { kind: 'uw-before-mandate' } })
  expect(parent.completion.completions.get(`acme/app\0acme/app#${EPIC}`)?.state).not.toBe('complete')
  const facts = await withEpicEffects(
    { git: (cwd, args) => git(cwd, args), gh: transport, uw: operations, uwReadAuthor: 'operator' },
    async () => (await gather(world.epic, EPIC, RUN_A, 'main', { dashboard: false, reviews: false })).facts,
  )
  const step = nextStep(facts)
  expect(step.action === 'start' || step.action === 'resume' ? step.ticket : null).not.toBe(A)
  expect(step.action === 'start' || step.action === 'resume' ? step.ticket : null).not.toBe(B)
})

it('holds initialization when a native child tier diverges from the accepted Parent commitment', async () => {
  const world = sandbox()
  frameGoalChildren([])
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing allocated child')
    const updated = { ...issue, labels: ['size:S'] }
    state.issues[String(A)] = updated
  })
  const transport = (_cwd: string, args: string[], input?: string) => {
    const result = gh([...args], input)
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: {
      async confirm() {
        return true
      },
    },
    localProtocolOptions: { getArtifactsDir: () => world.root },
  } as unknown as ExtensionContext)
  const operations = await createInstalledUwOperations({
    cwd: world.epic,
    readAuthor: 'operator',
    gh: async (cwd, args) => transport(cwd, args),
    operator,
  })
  const facts = await withEpicEffects(
    { git: (cwd, args) => git(cwd, args), gh: transport, uw: operations, uwReadAuthor: 'operator' },
    async () => (await gather(world.epic, EPIC, RUN_A, 'main', { dashboard: false, reviews: false })).facts,
  )
  expect(facts.children.find((child) => child.number === A)?.initialMandate).toMatchObject({ status: 'held' })
  const step = nextStep(facts)
  expect(step.action === 'start' || step.action === 'resume' ? step.ticket : null).not.toBe(A)
})
