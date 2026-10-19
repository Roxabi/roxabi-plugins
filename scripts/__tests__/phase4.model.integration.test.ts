import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reviewRecords } from '../../plugins/omp-build/skills/feature/workflow.js'
import { type Phase4Fixture, readPhase4Programme, runPhase4Model } from '../phase4-model'

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

type RenderedFinding = {
  group: string
  label: string
  body: string
}

function renderedFindings(body: string): RenderedFinding[] {
  const heading = /^## Findings[\t ]*$/m.exec(body)
  if (!heading || heading.index === undefined) throw new Error(`rendered review has no Findings section:\n${body}`)
  const start = heading.index + heading[0].length
  const nextHeading = /^## (?!Findings\b)/gm
  nextHeading.lastIndex = start
  const end = nextHeading.exec(body)?.index ?? body.length
  const conventional = /^[\t ]*[-*]?[\t ]*(issue|suggestion|todo|nitpick|thought|question|praise)(?:\([a-z-]+\))?:/m
  if (conventional.test(body.slice(0, heading.index)) || conventional.test(body.slice(end))) {
    throw new Error(`rendered review contains a Conventional Comment outside Findings:\n${body}`)
  }
  const section = body.slice(start, end)
  const headers = [...section.matchAll(/^### ([^\n]+)$/gm)]
  const findings: RenderedFinding[] = []
  let cursor = 0
  for (const [index, header] of headers.entries()) {
    const headingIndex = header.index ?? 0
    if (conventional.test(section.slice(cursor, headingIndex))) {
      throw new Error(`rendered review contains an ungrouped Conventional Comment:\n${body}`)
    }
    const group = header[1]
    const groupStart = headingIndex + header[0].length
    const groupEnd = headers[index + 1]?.index ?? section.length
    const groupBody = section.slice(groupStart, groupEnd)
    const records = [
      ...groupBody.matchAll(
        /^[\t ]*[-*]?[\t ]*((?:issue|suggestion|todo|nitpick|thought|question|praise)(?:\([a-z-]+\))?):/gm,
      ),
    ]
    if (!['Blockers', 'Warnings', 'Suggestions', 'Praise'].includes(group) && records.length > 0) {
      throw new Error(`rendered review contains a Conventional Comment in unknown group ${group}:\n${body}`)
    }
    for (const [recordIndex, record] of records.entries()) {
      const recordStart = record.index ?? 0
      const tail = groupBody.slice(recordStart, records[recordIndex + 1]?.index)
      const lines = tail.split('\n')
      const detail = [lines[0]]
      for (const line of lines.slice(1)) {
        if (line.trim() === '' || /^ {2}/.test(line)) detail.push(line)
        else break
      }
      findings.push({ group, label: `${record[1]}:`, body: detail.join('\n').trim() })
    }
    cursor = groupEnd
  }
  if (conventional.test(section.slice(cursor))) {
    throw new Error(`rendered review contains an ungrouped Conventional Comment:\n${body}`)
  }
  return findings
}

function parseProvenance(finding: RenderedFinding, body: string): unknown {
  const raw = /^ {2}Provenance: (\[.+\])$/m.exec(finding.body)?.[1]
  if (!raw) throw new Error(`finding ${finding.label} omitted flow-YAML provenance:\n${body}`)
  const cwd = mkdtempSync(join(tmpdir(), 'phase4-provenance-'))
  try {
    const parsed = spawnSync(
      'bun',
      [
        '--no-env-file',
        '-e',
        'const input = await Bun.stdin.text()\nprocess.stdout.write(JSON.stringify(Bun.YAML.parse(input)))',
      ],
      { cwd, input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1_000 },
    )
    if (parsed.status !== 0 || parsed.error) {
      throw new Error(`could not parse finding provenance (${parsed.status}):\n${body}`)
    }
    return JSON.parse(parsed.stdout)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

it('renders both independent panel findings and sends the declared record to the candidate consumer', async ({
  annotate,
}) => {
  const programme = readPhase4Programme()
  const result = await runPhase4Model(programme, fixture)
  await annotate(JSON.stringify(result.provenance), 'phase4-model-provenance')

  expect(result.body, result.body).toMatch(/^<!-- omp-build:code-review -->/)
  const findings = renderedFindings(result.body)
  const actual = findings.map((finding) => ({
    group: finding.group,
    label: finding.label,
    citation: /^ {2}([^\n]+:\d+)$/m.exec(finding.body)?.[1],
    agent: /^ {2}-- ([^\n]+)$/m.exec(finding.body)?.[1],
    provenance: parseProvenance(finding, result.body),
    evidence: {
      changedPath: finding.body.includes('changed guard') && finding.body.includes('submit.ts:3'),
      pending: finding.body.includes('pending'),
      presentation: finding.body.includes('presentation'),
      warningDoesNotBorrowBlocker: finding.label !== 'suggestion:' || !finding.body.includes('fixture-adversarial'),
    },
  }))
  expect(actual, `Rendered Phase 4 review:\\n${result.body}`).toEqual([
    {
      group: 'Blockers',
      label: 'issue:',
      citation: 'src/panel/advance.ts:2',
      agent: 'fixture-adversarial',
      provenance: [
        {
          agent: 'fixture-adversarial',
          phase: 'panel',
          chunk: 1,
          callsites: [
            { file: 'src/panel/advance.ts', line: 2 },
            { file: 'src/panel/submit.ts', line: 3 },
          ],
        },
      ],
      evidence: { changedPath: true, pending: true, presentation: false, warningDoesNotBorrowBlocker: true },
    },
    {
      group: 'Warnings',
      label: 'suggestion:',
      citation: 'src/panel/status.ts:2',
      agent: 'fixture-architect',
      provenance: [
        {
          agent: 'fixture-architect',
          phase: 'panel',
          chunk: 1,
          callsites: [{ file: 'src/panel/status.ts', line: 2 }],
        },
      ],
      evidence: { changedPath: false, pending: false, presentation: true, warningDoesNotBorrowBlocker: true },
    },
  ])

  const record = reviewRecords([{ body: result.body, author: { login: 'omp-build[bot]' } }], { me: 'omp-build[bot]' })
  expect(record, `Rendered Phase 4 review:\\n${result.body}`).toMatchObject({ reviews: 1, verdict: 'Request changes' })
})
