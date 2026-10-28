import {
  type CanonicalRecord,
  decodeHistory,
  encodeRecord,
  parseIssueSpecBody,
  rawSource,
} from '../../../../contracts.ts'
import { reviewRoot } from '../../../../testing/record-builders.ts'
import { epicReviewGraph } from '../../../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { A, B, C, type Comment, type DriverNext, EPIC, RUN_A, RUN_B } from './goal-scenario-domain.ts'
import { callWorkflow, gh, readSim, runDriver, sandboxEpic, writeSim } from './goal-scenario-sandbox.ts'

const { encodedAdmissionReviewGraph, projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { epicMandate, featureMandate, framedBodies, historyFrom, identityAllocation, mandateRef, ownSpecFromSnapshot } =
  roxabiWorkflowFixtures()

function nativeComments(issue: number, comments: Comment[]) {
  return comments.map((comment, index) => ({
    locator: `acme/app#${issue}:comment:${index + 1}`,
    nativeId: String(index + 1),
    body: comment.body,
    author: comment.author,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }))
}
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
  const head = range.slice(range.indexOf('..') + 2)
  const graph = epicReviewGraph({ prefix: `goal-${RUN_B}`, head, empty: true })
  const subject: { kind: 'epic-range'; range: string } = { kind: 'epic-range', range }
  const root = {
    ...reviewRoot({ id: graph.root.recordId, head, subject }),
    repository: 'acme/app',
    target: `acme/app#${EPIC}`,
  }
  const records: CanonicalRecord[] = []
  for (const record of graph.records) {
    records.push(
      record.recordId === root.recordId ? root : { ...record, repository: 'acme/app', target: `acme/app#${EPIC}` },
    )
  }
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
  const issue = readSim().issues[String(number)]
  if (!issue) throw new Error(`missing child issue #${number}`)
  const encoded = encodeRecord(
    mandate,
    {
      scope: { repository: 'acme/app', target: `acme/app#${number}` },
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments: nativeComments(number, issue.comments),
      diagnostics: [],
    },
    TEST_PROJECTION_CONFIG,
    [parentHistory],
  )
  if (!encoded.ok) throw new Error(encoded.diagnostics.map((entry) => entry.code).join(', '))
  writeSim((sim) => {
    const child = sim.issues[String(number)]
    if (!child) throw new Error(`missing child issue #${number}`)
    if (!child.comments.some((comment) => comment.body.includes('kind=mandate')))
      child.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
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

export function approve(pr: number, sha: string, cwd: string): void {
  const captured = callWorkflow<{ ok: boolean; input?: string | null; error?: string }>('captureReviewInput', cwd, {
    pr,
    head: sha,
  })
  if (!captured.ok || typeof captured.input !== 'string' || !/^[0-9a-f]{64}$/.test(captured.input))
    throw new Error(`approve #${pr}: captureReviewInput failed ${JSON.stringify(captured)}`)
  const comments = encodedAdmissionReviewGraph({
    scope: { repository: 'acme/app', target: `acme/app#${pr}` },
    head: sha,
    input: captured.input,
    prefix: `scenario-${pr}-${sha.slice(0, 8)}`,
  }).comments
  for (const comment of comments) {
    const review = gh(['pr', 'comment', String(pr), '--body', comment.body])
    if (review.status !== 0) throw new Error(`approve #${pr}: ${review.stderr}`)
  }
}
