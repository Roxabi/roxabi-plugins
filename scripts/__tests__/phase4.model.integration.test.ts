import { expect, it } from 'vitest'
import { reviewRecords } from '../../plugins/omp-build/skills/feature/workflow.js'
import { type Phase4Fixture, readPhase4Programme, runPhase4Model } from '../phase4-model'
import { qualifyPhase4Baseline } from './phase4-baseline'

const fixture: Phase4Fixture = {
  id: 'two-independent-panel-findings',
  snapshot: [
    'Review binding: local-only. There is no PR, REVIEWED_HEAD, posting operation, recall worker, or additional source beyond this snapshot.',
    '',
    'Complete changed paths and their supplied caller/contract context:',
    '```diff',
    'diff --git a/src/panel/advance.ts b/src/panel/advance.ts',
    '@@',
    '+export function mayAdvance(panel) {',
    "+  return panel.approvedAt !== null || panel.status !== 'blocked'",
    '+}',
    'diff --git a/src/panel/status.ts b/src/panel/status.ts',
    '@@',
    '+export function panelStatus(panel) {',
    "+  return panel.status === 'approved' ? 'ready' : panel.status",
    '+}',
    '```',
    '',
    '```ts src/panel/advance.ts',
    'export function mayAdvance(panel: { approvedAt: string | null; status: string }) {',
    "  return panel.approvedAt !== null || panel.status !== 'blocked'",
    '}',
    '```',
    '```ts src/panel/submit.ts',
    "import { mayAdvance } from './advance.ts'",
    'export function submit(panel) {',
    "  if (!mayAdvance(panel)) return 'held'",
    "  return 'published'",
    '}',
    '```',
    '```ts src/panel/status.ts',
    'export function panelStatus(panel: { status: string }) {',
    "  return panel.status === 'approved' ? 'ready' : panel.status",
    '}',
    '```',
    '',
    'The supplied caller demonstrates that a pending panel has approvedAt=null and status=pending, so the changed OR condition returns true and submit publishes it. The status formatter has no caller or safety path in this fixture.',
    '',
    'Captured Phase 3 panel reports, in actual emission order:',
    '',
    'issue: Pending panels can publish through the changed advance guard',
    '  src/panel/advance.ts:2',
    '  -- fixture-adversarial',
    '  Provenance: [{agent: fixture-adversarial, phase: panel, chunk: 1, callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]}]',
    '  Root cause: ["guard","src/panel/advance.ts:2","or",["ne","approvedAt",null],["ne","status","blocked"]]',
    '  Symptoms/evidence: ["witness",["input","approvedAt",null],["input","status","pending"],["result","src/panel/advance.ts:2",true],["result","src/panel/submit.ts:3","published"]]',
    '  Raw callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]',
    '  Confidence: 96%',
    '',
    'suggestion: The changed status formatter keeps the legacy ready spelling inline',
    '  src/panel/status.ts:2',
    '  -- fixture-architect',
    '  Provenance: [{agent: fixture-architect, phase: panel, chunk: 1, callsites: [{file: src/panel/status.ts, line: 2}]}]',
    '  Root cause: ["mapping","src/panel/status.ts:2","approved","ready","local-literal"]',
    '  Symptoms/evidence: ["witness",["mapping","src/panel/status.ts:2","approved","ready"],["supplied-safety-path",false]]',
    '  Raw callsites: [{file: src/panel/status.ts, line: 2}]',
    '  Confidence: 72%',
    '',
    'No spec findings, recall reports, roster caps, or roster warnings were emitted. The fixture does not supply expected rendered labels or a verdict.',
  ].join('\n'),
}

it('renders both independent panel findings and sends the declared record to the candidate consumer', async ({
  annotate,
}) => {
  const programme = readPhase4Programme()
  const result = await runPhase4Model(programme, fixture)
  await annotate(JSON.stringify(result.provenance), 'phase4-model-provenance')
  await annotate(result.body, 'phase4-model-body')

  expect(result.provenance.programme.map((source) => source.path)).toEqual([
    'plugins/omp-build/skills/dev-review/SKILL.md',
    'plugins/omp-build/skills/dev-review/root-causes.md',
    'plugins/omp-build/skills/dev-review/review-smells.md',
    'plugins/omp-build/skills/dev-review/review-classes.yml',
  ])
  expect(result.provenance.programme).toEqual(
    expect.arrayContaining([expect.objectContaining({ commitSHA: programme.commitSHA, atCommit: true })]),
  )
  expect(result.provenance.programme.every((source) => source.atCommit)).toBe(true)
  expect(result.provenance.runtime).toMatchObject({
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    requestedThinking: 'low',
  })

  qualifyPhase4Baseline(result.body)

  const record = reviewRecords([{ body: result.body, author: { login: 'omp-build[bot]' } }], { me: 'omp-build[bot]' })
  expect(record, `Rendered Phase 4 review:\n${result.body}`).toMatchObject({ reviews: 1, verdict: 'Request changes' })
})
