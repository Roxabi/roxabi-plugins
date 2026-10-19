import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function detail(finding: RenderedFinding, name: string): string {
  const prefix = `  ${name}:`
  const lines = finding.body.split('\n')
  const start = lines.findIndex((line) => line.startsWith(prefix))
  if (start < 0) return ''
  const value = [lines[start].slice(prefix.length)]
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S[^:]*:/.test(line)) break
    value.push(line.trim())
  }
  return value.join(' ').trim().replaceAll('`', '')
}

function parseFindingFields(findings: RenderedFinding[], body: string) {
  const input = findings.map((finding) => ({
    provenance: detail(finding, 'Provenance') || 'null',
    rawCallsites: detail(finding, 'Raw callsites') || 'null',
  }))
  const cwd = mkdtempSync(join(tmpdir(), 'phase4-provenance-'))
  try {
    const parsed = spawnSync(
      'bun',
      [
        '--no-env-file',
        '-e',
        [
          'const input = JSON.parse(await Bun.stdin.text())',
          'process.stdout.write(JSON.stringify(input.map(row => ({',
          '  provenance: Bun.YAML.parse(row.provenance),',
          '  rawCallsites: Bun.YAML.parse(row.rawCallsites),',
          '}))))',
        ].join('\n'),
      ],
      { cwd, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1_000 },
    )
    if (parsed.status !== 0 || parsed.error) {
      throw new Error(`could not parse finding fields (${parsed.status}):\n${body}`)
    }
    return JSON.parse(parsed.stdout) as { provenance: unknown; rawCallsites: unknown }[]
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const expected = [
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
    rawCallsites: [
      { file: 'src/panel/advance.ts', line: 2 },
      { file: 'src/panel/submit.ts', line: 3 },
    ],
    mechanism: { disjunctiveEligibility: true, approval: true },
    evidence: { pendingWithoutApproval: true, guardAccepted: true, publishes: true },
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
    rawCallsites: [{ file: 'src/panel/status.ts', line: 2 }],
    mechanism: { localLiteral: true, statusVocabulary: true },
    evidence: { approvedToReady: true, noSafetyPath: true },
  },
]

/** Qualifies this fixture only; it neither classifies findings nor judges arbitrary prose. */
export function qualifyPhase4Baseline(body: string) {
  assert.match(body, /^<!-- omp-build:code-review -->/)
  const findings = renderedFindings(body)
  const parsed = parseFindingFields(findings, body)
  const actual = findings.map((finding, index) => {
    const cause = detail(finding, 'Root cause')
    const evidence = detail(finding, 'Symptoms/evidence')
    return {
      group: finding.group,
      label: finding.label,
      citation: /^ {2}([^\n]+:\d+)$/m.exec(finding.body)?.[1],
      agent: /^ {2}-- ([^\n]+)$/m.exec(finding.body)?.[1],
      ...parsed[index],
      mechanism:
        index === 0
          ? {
              disjunctiveEligibility: /\b(?:non[- ]blocked|not blocked|OR|disjunctive|disjunction)\b|\|\|/i.test(cause),
              approval: /approv(?:al|ed)/i.test(cause),
            }
          : {
              localLiteral: /\b(?:local|inline|literal)\b/i.test(cause),
              statusVocabulary: /vocabulary|mapping|status|formatter/i.test(cause),
            },
      evidence:
        index === 0
          ? {
              pendingWithoutApproval: /approvedAt\s*(?:=|:|is)\s*null/.test(evidence) && /\bpending\b/.test(evidence),
              guardAccepted: /advance(?:\.ts)?(?::2)?.*\btrue\b/i.test(evidence),
              publishes: /submit(?:\.ts)?(?::3)?.*\bpublish(?:es|ed|ing)?\b/i.test(evidence),
            }
          : {
              approvedToReady:
                /status(?:\.ts)?(?::2)?|panelStatus/i.test(evidence) &&
                /\bapproved\b/.test(evidence) &&
                /\bready\b/.test(evidence),
              noSafetyPath: /\b(?:no|not|without)\b.*\b(?:safety|publication|permission|caller|path)\b/i.test(evidence),
            },
    }
  })
  assert.deepStrictEqual(actual, expected, `Rendered Phase 4 baseline:\n${body}`)
  return actual
}
