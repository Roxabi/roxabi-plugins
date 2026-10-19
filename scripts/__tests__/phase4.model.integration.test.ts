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
    '  Root cause: The changed guard treats every non-blocked status as eligible without requiring approval.',
    '  Symptoms/evidence: A pending panel has approvedAt=null and status=pending, so advance.ts:2 returns true; submit.ts:3 then publishes it. The changed guard is on that caller path.',
    '  Raw callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]',
    '  Confidence: 96%',
    '',
    'suggestion: The changed status formatter keeps the legacy ready spelling inline',
    '  src/panel/status.ts:2',
    '  -- fixture-architect',
    '  Provenance: [{agent: fixture-architect, phase: panel, chunk: 1, callsites: [{file: src/panel/status.ts, line: 2}]}]',
    '  Root cause: The presentation mapping remains a local literal rather than the status vocabulary.',
    '  Symptoms/evidence: status.ts:2 maps approved to ready. The supplied snapshot establishes no publication, permission, deployment, or other safety path for this presentation-only inconsistency.',
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

  qualifyPhase4Baseline(result.body)

  const record = reviewRecords([{ body: result.body, author: { login: 'omp-build[bot]' } }], { me: 'omp-build[bot]' })
  expect(record, `Rendered Phase 4 review:\\n${result.body}`).toMatchObject({ reviews: 1, verdict: 'Request changes' })
})
