import { decodeHistory, encodeRecord } from '../../../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../../../engine/action-input.ts'
import { resolveSpecEffective } from '../../../../engine/spec-effective.ts'
import type { UwOperations } from '../../../../roxabi/uw-contract.ts'
import type { GitRunner } from '../../../../roxabi/workflow-checkout.ts'
import { committedFixturePlugin, committedFixtureProjection } from '../../../../testing/committed-plugin-fixture.ts'
import { produceNativeImplementation } from '../../../../testing/native-implementation-producer.ts'
import { produceNativePlan } from '../../../../testing/native-plan-producer.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { authenticatedPlanFixtures } from '../../../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { goalChildOperations } from './goal-scenario-action-ports.ts'
import { nativeComments } from './goal-scenario-approval.ts'
import { A, B, C, type DriverNext, EPIC } from './goal-scenario-domain.ts'
import { childMandate, currentSpec, epicRecord } from './goal-scenario-mandates.ts'
import { git, moduleGh, readSim, runDriver, sandboxEpic, toolingFixture, writeSim } from './goal-scenario-sandbox.ts'

const { framedBodies, historyFrom, identityAllocation } = roxabiWorkflowFixtures()

const transport = async (_cwd: string, args: string[]) => {
  const result = moduleGh(args)
  if (result.status !== 0) throw new Error(`Native goal GitHub request failed: ${result.stderr}`)
  return result.stdout
}

const gitPort: GitRunner = async (directory, args) => {
  try {
    return { code: 0, stdout: git(directory, args), stderr: '' }
  } catch (error) {
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

export function events(issue: number) {
  const comments = readSim().issues[String(issue)]?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: `acme/app#${issue}` },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: nativeComments(issue, comments),
    diagnostics: [],
  }).operations.flatMap((operation) => (operation.record?.kind === 'epic-event' ? [operation.record.payload] : []))
}

function ensureIdentity(number: number): void {
  const scope = { repository: 'acme/app', target: `acme/app#${number}` }
  if (readSim().issues[String(number)]?.comments.some((comment) => comment.body.includes('kind=spec-identity'))) return
  const bodies = framedBodies([identityAllocation(scope)], 'operator')
  writeSim((sim) => {
    const issue = sim.issues[String(number)]
    if (!issue) throw new Error(`missing issue #${number}`)
    issue.comments.push(...bodies.map((body) => ({ author: 'operator', body })))
  })
}

function ensureMandate(): void {
  const state = readSim()
  if (!state.issues[String(EPIC)]?.comments.some((comment) => comment.body.includes('kind=mandate'))) {
    const bodies = framedBodies([epicRecord()], 'operator')
    writeSim((sim) => {
      const issue = sim.issues[String(EPIC)]
      if (!issue) throw new Error('missing epic issue')
      issue.comments.push(...bodies.map((body) => ({ author: 'operator', body })))
    })
  }
  for (const number of [A, B, C]) ensureIdentity(number)
}

/** Publish a genuinely captured parent plan and both specialist reviews in the live Goal world. */
export async function seedGoalParentPlan(operations: UwOperations, cwd: string): Promise<void> {
  const scope = { repository: 'acme/app', target: `acme/app#${EPIC}` }
  const read = await operations.readUw(scope)
  if (read.observation.status !== 'complete' || read.accepted.status !== 'accepted')
    throw new Error('Goal parent plan needs the current authenticated parent')
  const accepted = read.accepted.value
  const mandate = read.histories
    .flatMap((history) => history.operations)
    .map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate' && record.recordId === accepted.ref.sourceAccepted.recordId)
  if (mandate?.kind !== 'mandate') throw new Error('Goal parent mandate is unavailable')
  const effective = await operations.readEffective(scope)
  if (!effective.ok) throw new Error(`Goal parent effective Spec unavailable: ${JSON.stringify(effective.diagnostics)}`)
  const criteria = accepted.snapshot.spec.criteria
  if (criteria.length === 0) throw new Error('Goal parent needs direct criteria')
  const planOutput = {
    steps: [
      {
        id: 'step-1',
        change: 'integrate the accepted children',
        doneWhen: criteria.map((criterion) => criterion.statement).join('; '),
        criterionIds: criteria.map((criterion) => criterion.id),
        evidence: 'the integrated child results are reviewed',
        paths: ['README.md'],
      },
    ],
    resolutions: [],
  }
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}'])
  await produceNativePlan({
    world: { cwd, gh: transport, git: gitPort, operations },
    scope,
    mandate,
    parentScopes: [],
    git: { repository: scope.repository, commit: head, tree },
    output: planOutput,
    reviews: [
      { outcome: 'clear', blockers: [] },
      { outcome: 'clear', blockers: [] },
    ],
  })
}

export function frameGoalChildren(children: readonly { number: number; branch: string; id: string }[]): void {
  ensureMandate()
  const parentHistory = historyFrom([epicRecord()], 'operator')
  for (const child of children) {
    const mandate = childMandate(child.number, child.branch, child.id)
    const bodies = framedBodies([mandate], 'operator', [parentHistory])
    writeSim((sim) => {
      const issue = sim.issues[String(child.number)]
      if (!issue || issue.comments.some((comment) => comment.body.includes('kind=mandate')))
        throw new Error(`Child #${child.number} is missing or already framed`)
      issue.comments.push(...bodies.map((body) => ({ author: 'operator', body })))
    })
  }
}

export async function ensureChildMandate(
  number: number,
  branch: string,
  id: string,
  advance: () => string,
): Promise<string> {
  if (!readSim().issues[String(number)]?.comments.some((comment) => comment.body.includes('kind=mandate')))
    throw new Error(`Child #${number} has not been framed`)
  const epic = epicRecord()
  const current = currentSpec(number)
  const mandate = childMandate(number, branch, id)
  const parentHistory = historyFrom([epic], 'operator')
  const ownHistory = historyFrom([mandate], 'operator', 'operator', [parentHistory])
  const effective = resolveSpecEffective({
    mode: 'historical',
    own: {
      uw: current.scope,
      version: mandate.payload.ownSpec.version,
      sourceAccepted: { scope: current.scope, recordId: mandate.recordId, kind: 'mandate' },
    },
    versionVector: [
      {
        uw: current.scope,
        version: mandate.payload.ownSpec.version,
        sourceAccepted: { scope: current.scope, recordId: mandate.recordId, kind: 'mandate' },
      },
      ...mandate.payload.inheritedOwnSpecRefs,
    ],
    histories: [ownHistory, parentHistory],
  })
  if (!effective.ok) throw new Error('Cannot resolve the declared parent Spec for the child')
  const cwd = sandboxEpic()
  if (!cwd) throw new Error('missing epic checkout')
  const baseCommit = git(cwd, ['rev-parse', 'refs/remotes/origin/main'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const tooling = toolingFixture()
  const { workflow: fixtures } = authenticatedPlanFixtures(mandate, [ownHistory, parentHistory], effective.value, {
    steps: [
      {
        id: 'step-1',
        change: `land child ${number}`,
        doneWhen: current.snapshot.spec.criteria.map((criterion) => criterion.statement).join('; '),
        criterionIds: current.snapshot.spec.criteria.map((criterion) => criterion.id),
        evidence: `child ${number} pull request lands`,
        paths: [`${id}.txt`],
      },
    ],
    resolutions: [],
  })
  const digest = fixtures.publishedPlanDigest()
  const planActionId = `act-plan-${number}`
  const reviewActionId = `act-plan-review-${number}`
  const planRecords = [
    ...fixtures.planDraftRecords(mandate, planActionId),
    fixtures.planReviewStart(mandate, planActionId, digest, reviewActionId),
    fixtures.planReviewRecord(
      mandate,
      planActionId,
      digest,
      [
        fixtures.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        fixtures.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      reviewActionId,
    ),
  ]
  const records = planRecords.map((record) => {
    const input = record.payload.inputs
    const manifest = {
      ...input.manifest,
      code: { repository: current.scope.repository, base: baseCommit, head, referenceCommit: baseCommit },
      plugin: committedFixturePlugin(tooling.cwd, input.manifest.plugin, tooling.commit),
      acceptedSources: [
        ...input.manifest.acceptedSources,
        {
          source: 'record' as const,
          record: {
            scope: { repository: epic.repository, target: epic.target },
            recordId: epic.recordId,
            kind: epic.kind,
          },
          selector: '/payload',
          digest: canonicalValueDigest(epic.payload),
        },
      ],
    }
    return {
      ...record,
      payload: { ...record.payload, inputs: { ...input, manifest, fingerprint: actionInputDigest(manifest) } },
    }
  })
  const action = records.find((record) => record.kind === 'action-receipt')
  if (action?.kind !== 'action-receipt') throw new Error('Missing fixture action receipt')
  const projection = committedFixtureProjection(tooling.cwd, action.payload.inputs)
  writeSim((sim) => {
    const child = sim.issues[String(number)]
    if (!child) throw new Error(`missing child issue #${number}`)
    for (const record of records) {
      const encoded = encodeRecord(
        record,
        {
          scope: current.scope,
          expectedAuthor: 'operator',
          stopAuthor: null,
          complete: true,
          comments: nativeComments(number, child.comments),
          diagnostics: [],
        },
        projection,
        [parentHistory],
      )
      if (!encoded.ok)
        throw new Error(
          `cannot encode ${record.recordId}: ${encoded.diagnostics.map((entry) => entry.code).join(', ')}`,
        )
      child.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
    }
  })
  const operations = await goalChildOperations(cwd, transport, gitPort, tooling, action.payload.inputs)
  const read = await operations.readUw(current.scope)
  if (read.observation.status !== 'complete' || read.accepted.status !== 'accepted')
    throw new Error(
      `Goal implementation preflight: ${JSON.stringify({
        observation: read.observation.status,
        observationDiagnostics: read.observation.status === 'incomplete' ? read.observation.diagnostics : [],
        graph: read.graph.status,
        graphDiagnostics: read.graph.status === 'incomplete' ? read.graph.diagnostics : [],
        accepted: read.accepted.status,
        acceptedDiagnostics: read.accepted.status === 'refused' ? read.accepted.diagnostics : [],
        historyDiagnostics: read.histories.map((entry) => ({
          scope: entry.source.scope,
          diagnostics: entry.diagnostics,
          sourceDiagnostics: entry.source.diagnostics,
        })),
      })}`,
    )
  const parent = read.histories.find(
    (item) => item.source.scope.target === epic.target && item.source.scope.repository === epic.repository,
  )
  if (!parent) throw new Error('Goal implementation lacks its observed ancestor history')
  let committed = ''
  await produceNativeImplementation({
    cwd,
    gh: transport,
    git: gitPort,
    operations,
    read,
    scope: current.scope,
    mandate,
    parents: [parent],
    startHead: head,
    command: `bun test ${id}.test.ts`,
    output: `PASS ${id}`,
    advance() {
      committed = advance()
      return { head: committed, tree: git(cwd, ['rev-parse', `${committed}^{tree}`]) }
    },
  })
  return committed
}

export function drive(args: string[], _run: string, cwd = sandboxEpic()) {
  if (!cwd) throw new Error('no sandbox')
  ensureMandate()
  return runDriver(args, cwd)
}

export function jsonOf(run: { code: number | null; stdout: string; stderr: string }): DriverNext {
  if (run.code !== 0) throw new Error(`driver ${run.code}: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout)
}
