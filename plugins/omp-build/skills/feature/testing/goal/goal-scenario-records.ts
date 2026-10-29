import { decodeHistory, encodeRecord, parseIssueSpecBody, rawSource } from '../../../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../../../engine/action-input.ts'
import { acceptedActionInputs } from '../../../../testing/action-input-fixtures.ts'
import { criterionImplementationRecords } from '../../../../testing/criterion-accepted-plan.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { createWorkflowActionFixtures } from '../../../../testing/workflow-actions.ts'
import { nativeComments } from './goal-scenario-approval.ts'
import { A, B, C, type DriverNext, EPIC, RUN_A, RUN_B } from './goal-scenario-domain.ts'
import { bindImplementationIdentity } from './goal-scenario-implementation.ts'
import { git, readSim, runDriver, sandboxEpic, writeSim } from './goal-scenario-sandbox.ts'

const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { epicMandate, featureMandate, framedBodies, historyFrom, identityAllocation, mandateRef, ownSpecFromSnapshot } =
  roxabiWorkflowFixtures()

function currentSpec(number: number) {
  const issue = readSim().issues[String(number)]
  if (!issue) throw new Error(`missing issue #${number}`)
  const scope = { repository: 'acme/app', target: `acme/app#${number}` }
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, issue.body, '2026-01-01T00:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec #${number} is ${parsed.status}`)
  return { scope, snapshot: parsed.snapshot }
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

export function seedEpicDecision(range: string): string {
  ensureMandate()
  const [baseCommit, head] = range.split('..')
  if (!baseCommit || !head) throw new Error(`invalid epic range ${range}`)
  const comments = readSim().issues[String(EPIC)]?.comments
  if (!comments) throw new Error('missing epic issue')
  const scope = { repository: 'acme/app', target: `acme/app#${EPIC}` }
  const mandate = decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: nativeComments(EPIC, comments),
    diagnostics: [],
  })
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('goal review fixture needs its accepted parent mandate')
  const base = acceptedActionInputs(mandate, 'review')
  const manifest = {
    ...base.manifest,
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope, recordId: mandate.recordId, kind: mandate.kind },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
    code: { repository: scope.repository, base: baseCommit, head, referenceCommit: head },
    plugin: { ...base.manifest.plugin, commit: git(import.meta.dirname, ['rev-parse', 'HEAD']) },
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = criterionEpicReviewGraph({ mandate, prefix: `goal-${RUN_B}`, head, range, inputs })
  const records = [...graph.issueRecords.filter((record) => record.kind !== 'mandate'), ...graph.records]
  writeSim((state) => {
    const issue = state.issues[String(EPIC)]
    if (!issue) throw new Error('missing epic issue')
    for (const record of records) {
      const encoded = encodeRecord(
        record,
        {
          scope: { repository: 'acme/app', target: `acme/app#${EPIC}` },
          expectedAuthor: 'operator',
          stopAuthor: null,
          complete: true,
          comments: nativeComments(EPIC, issue.comments),
          diagnostics: [],
        },
        TEST_PROJECTION_CONFIG,
      )
      if (!encoded.ok) throw new Error(encoded.diagnostics.map((entry) => entry.code).join(', '))
      issue.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
    }
  })
  return graph.decision.recordId
}

function epicRecord() {
  const current = currentSpec(EPIC)
  const children = [A, B, C].map((number) => {
    const child = currentSpec(number)
    return {
      scope: child.scope,
      specVersion: child.snapshot.spec.version,
      snapshot: child.snapshot,
      tier: 'F-lite' as const,
    }
  })
  return epicMandate(current.scope, children, {
    runId: RUN_A,
    run: RUN_A,
    body: current.snapshot.raw.body,
    ownSpec: ownSpecFromSnapshot(current.scope, current.snapshot),
    tier: 'F-lite',
  })
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

export function ensureChildMandate(number: number, branch: string, id: string): void {
  ensureMandate()
  if (readSim().issues[String(number)]?.comments.some((comment) => comment.body.includes('kind=mandate'))) return
  const epic = epicRecord()
  const current = currentSpec(number)
  const mandate = featureMandate(current.scope, {
    recordId: `mandate-feature-${id}`,
    operationId: `op-mandate-feature-${id}`,
    runId: RUN_A,
    run: RUN_A,
    body: current.snapshot.raw.body,
    branch,
    base: 'main',
    lineageHead: null,
    parent: mandateRef(epic),
    ownSpec: ownSpecFromSnapshot(current.scope, current.snapshot),
    tier: 'F-lite',
  })
  const parentHistory = historyFrom([epic], 'operator')
  const cwd = sandboxEpic()
  if (!cwd) throw new Error('missing epic checkout')
  const baseCommit = git(cwd, ['rev-parse', 'refs/remotes/origin/main'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const pluginCommit = git(import.meta.dirname, ['rev-parse', 'HEAD'])
  const fixtures = createWorkflowActionFixtures({
    planOutput: {
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
    },
    planSlots: [
      { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' },
      { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' },
    ],
    nativeOutcome: { completion: 'completed', strict: 'valid', raw: null },
    head,
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
  const records = [
    mandate,
    ...planRecords.map((record) => {
      const input = record.payload.inputs
      const manifest = {
        ...input.manifest,
        code: { repository: current.scope.repository, base: baseCommit, head, referenceCommit: baseCommit },
        plugin: { ...input.manifest.plugin, commit: pluginCommit },
        acceptedSources: [
          {
            source: 'record' as const,
            record: { scope: current.scope, recordId: mandate.recordId, kind: mandate.kind },
            selector: '/payload',
            digest: canonicalValueDigest(mandate.payload),
          },
        ],
      }
      return {
        ...record,
        payload: { ...record.payload, inputs: { ...input, manifest, fingerprint: actionInputDigest(manifest) } },
      }
    }),
    ...criterionImplementationRecords(mandate, head)
      .slice(-2)
      .map((record) => bindImplementationIdentity(record, number, planActionId)),
  ]
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
        TEST_PROJECTION_CONFIG,
        [parentHistory],
      )
      if (!encoded.ok)
        throw new Error(
          `cannot encode ${record.recordId}: ${encoded.diagnostics.map((entry) => entry.code).join(', ')}`,
        )
      child.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
    }
  })
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
