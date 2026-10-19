import { AssertionError } from 'node:assert'
import assert from 'node:assert/strict'

type FlowValue = string | number | boolean | null | FlowValue[] | FlowMap
type FlowMap = Map<string, FlowValue>

type Finding = {
  group: string
  label: string
  content: string
  structure: string
}

type ExpectedFinding = {
  group: 'Blockers' | 'Warnings'
  label: 'issue:' | 'suggestion:'
  citation: string
  emitter: string
  cause: unknown[]
  witness: unknown[]
  provenance: {
    agent: string
    callsites: readonly { file: string; line: number }[]
  }
}

const EXPECTED_FINDINGS: readonly ExpectedFinding[] = [
  {
    group: 'Blockers',
    label: 'issue:',
    citation: 'src/panel/advance.ts:2',
    emitter: 'fixture-adversarial',
    cause: ['guard', 'src/panel/advance.ts:2', 'or', ['ne', 'approvedAt', null], ['ne', 'status', 'blocked']],
    witness: [
      'witness',
      ['input', 'approvedAt', null],
      ['input', 'status', 'pending'],
      ['result', 'src/panel/advance.ts:2', true],
      ['result', 'src/panel/submit.ts:3', 'published'],
    ],
    provenance: {
      agent: 'fixture-adversarial',
      callsites: [
        { file: 'src/panel/advance.ts', line: 2 },
        { file: 'src/panel/submit.ts', line: 3 },
      ],
    },
  },
  {
    group: 'Warnings',
    label: 'suggestion:',
    citation: 'src/panel/status.ts:2',
    emitter: 'fixture-architect',
    cause: ['mapping', 'src/panel/status.ts:2', 'approved', 'ready', 'local-literal'],
    witness: ['witness', ['mapping', 'src/panel/status.ts:2', 'approved', 'ready'], ['supplied-safety-path', false]],
    provenance: {
      agent: 'fixture-architect',
      callsites: [{ file: 'src/panel/status.ts', line: 2 }],
    },
  },
]

function reject(message: string): never {
  throw new AssertionError({ message })
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) reject(message)
  return value
}

class FlowReader {
  #offset = 0

  constructor(private readonly source: string) {}

  read(): FlowValue {
    const value = this.readValue()
    this.space()
    if (this.#offset !== this.source.length) throw new SyntaxError('trailing metadata syntax')
    return value
  }

  private readValue(): FlowValue {
    this.space()
    const character = this.source[this.#offset]
    if (character === '[') return this.readList()
    if (character === '{') return this.readMap()
    if (character === '"') return this.readDoubleQuoted()
    if (character === "'") return this.readSingleQuoted()
    return this.readPlain()
  }

  private readList(): FlowValue[] {
    this.#offset++
    const values: FlowValue[] = []
    this.space()
    if (this.source[this.#offset] === ']') {
      this.#offset++
      return values
    }
    while (true) {
      values.push(this.readValue())
      this.space()
      const separator = this.source[this.#offset]
      if (separator === ']') {
        this.#offset++
        return values
      }
      if (separator !== ',') throw new SyntaxError('flow list separator expected')
      this.#offset++
      this.space()
    }
  }

  private readMap(): FlowMap {
    this.#offset++
    const values: FlowMap = new Map()
    this.space()
    if (this.source[this.#offset] === '}') {
      this.#offset++
      return values
    }
    while (true) {
      const key = this.readKey()
      this.space()
      if (this.source[this.#offset] !== ':') throw new SyntaxError('flow map key separator expected')
      this.#offset++
      const value = this.readValue()
      if (values.has(key)) throw new SyntaxError(`duplicate decoded metadata key ${JSON.stringify(key)}`)
      values.set(key, value)
      this.space()
      const separator = this.source[this.#offset]
      if (separator === '}') {
        this.#offset++
        return values
      }
      if (separator !== ',') throw new SyntaxError('flow map separator expected')
      this.#offset++
      this.space()
    }
  }

  private readKey(): string {
    this.space()
    const character = this.source[this.#offset]
    if (character === '"') return this.readDoubleQuoted()
    if (character === "'") return this.readSingleQuoted()
    const start = this.#offset
    while (this.#offset < this.source.length && !/[\s:,{}[\]]/.test(this.source[this.#offset])) this.#offset++
    const key = this.source.slice(start, this.#offset)
    if (!key || !/^[A-Za-z0-9_./@-]+$/.test(key)) throw new SyntaxError('unsupported flow map key')
    return key
  }

  private readDoubleQuoted(): string {
    const start = this.#offset++
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset++]
      if (character === '\\') {
        this.#offset++
      } else if (character === '"') {
        return JSON.parse(this.source.slice(start, this.#offset)) as string
      }
    }
    throw new SyntaxError('unterminated double-quoted scalar')
  }

  private readSingleQuoted(): string {
    this.#offset++
    let value = ''
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset++]
      if (character !== "'") {
        value += character
      } else if (this.source[this.#offset] === "'") {
        value += "'"
        this.#offset++
      } else {
        return value
      }
    }
    throw new SyntaxError('unterminated single-quoted scalar')
  }

  private readPlain(): FlowValue {
    const start = this.#offset
    while (this.#offset < this.source.length && !/[\s,}\]]/.test(this.source[this.#offset])) this.#offset++
    const scalar = this.source.slice(start, this.#offset)
    if (!scalar) throw new SyntaxError('flow scalar expected')
    if (scalar === 'null') return null
    if (scalar === 'true') return true
    if (scalar === 'false') return false
    if (/^[1-9]\d*$/.test(scalar)) return Number(scalar)
    if (!/^[A-Za-z0-9_./@-]+$/.test(scalar)) throw new SyntaxError('unsupported flow scalar')
    return scalar
  }

  private space(): void {
    while (/\s/.test(this.source[this.#offset] ?? '')) this.#offset++
  }
}

function parseFlow(source: string): FlowValue {
  return new FlowReader(source).read()
}

function asMap(value: FlowValue, context: string): FlowMap {
  if (!(value instanceof Map)) reject(`${context} is not a metadata map`)
  return value
}

function asList(value: FlowValue, context: string): FlowValue[] {
  if (!Array.isArray(value)) reject(`${context} is not a metadata list`)
  return value
}

function asString(value: FlowValue | undefined, context: string): string {
  if (typeof value !== 'string') reject(`${context} is not a string`)
  return value
}

function asPositiveInteger(value: FlowValue | undefined, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    reject(`${context} is not a positive integer`)
  return value
}

function exactKeys(map: FlowMap, keys: readonly string[], context: string): void {
  if (map.size !== keys.length || keys.some((key) => !map.has(key))) reject(`${context} has unexpected metadata keys`)
}

function callsiteKey(callsite: { file: string; line: number }): string {
  return `${callsite.file}:${callsite.line}`
}

function sameCallsites(
  actual: { file: string; line: number }[],
  expected: readonly { file: string; line: number }[],
  context: string,
): void {
  const counts = new Map<string, number>()
  for (const callsite of expected) {
    const key = callsiteKey(callsite)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const callsite of actual) {
    const key = callsiteKey(callsite)
    const remaining = counts.get(key) ?? 0
    if (!remaining) reject(`${context} has an unexpected or duplicate callsite`)
    counts.set(key, remaining - 1)
  }
  if (actual.length !== expected.length || [...counts.values()].some(Boolean))
    reject(`${context} is missing a callsite`)
}

function parseCallsites(value: FlowValue, context: string): { file: string; line: number }[] {
  return asList(value, context).map((entry, index) => {
    const map = asMap(entry, `${context}[${index}]`)
    exactKeys(map, ['file', 'line'], `${context}[${index}]`)
    return {
      file: asString(map.get('file'), `${context}[${index}].file`),
      line: asPositiveInteger(map.get('line'), `${context}[${index}].line`),
    }
  })
}

function assertMetadata(value: FlowValue, expected: ExpectedFinding): void {
  const provenance = asList(value, `${expected.citation} provenance`)
  if (provenance.length !== 1) reject(`${expected.citation} must have one provenance entry`)
  const entry = asMap(provenance[0], `${expected.citation} provenance`)
  exactKeys(entry, ['agent', 'phase', 'chunk', 'callsites'], `${expected.citation} provenance`)
  if (asString(entry.get('agent'), `${expected.citation} provenance agent`) !== expected.provenance.agent) {
    reject(`${expected.citation} provenance agent is wrong`)
  }
  if (asString(entry.get('phase'), `${expected.citation} provenance phase`) !== 'panel') {
    reject(`${expected.citation} provenance phase is wrong`)
  }
  if (asPositiveInteger(entry.get('chunk'), `${expected.citation} provenance chunk`) !== 1) {
    reject(`${expected.citation} provenance chunk is wrong`)
  }
  sameCallsites(
    parseCallsites(
      requireValue(entry.get('callsites'), `${expected.citation} provenance callsites missing`),
      `${expected.citation} provenance callsites`,
    ),
    expected.provenance.callsites,
    `${expected.citation} provenance callsites`,
  )
}

function unwrapJson(source: string, context: string): unknown {
  const trimmed = source.trim()
  const wrapped = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/.exec(trimmed)
  const json = wrapped ? wrapped[1] : trimmed
  if (!json || (trimmed.startsWith('```') && !wrapped)) reject(`${context} has an unsupported Markdown wrapper`)
  try {
    return JSON.parse(json)
  } catch {
    reject(`${context} is not one complete JSON value`)
  }
}

function structuralText(body: string): string {
  const lines = body.split('\n')
  let fenceMarker = ''
  let fenceLength = 0
  let pendingFactualValue = false
  for (const [index, line] of lines.entries()) {
    const fence = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMarker) {
      lines[index] = ' '.repeat(line.length)
      if (
        fence &&
        indentationWidth(fence[1]) <= 3 &&
        fence[2][0] === fenceMarker &&
        fence[2].length >= fenceLength &&
        fence[3].trim() === ''
      ) {
        fenceMarker = ''
      }
      continue
    }
    if (/^[ \t]+(?:Root cause|Symptoms\/evidence):[ \t]*```(?:json)?[ \t]*$/.test(line)) {
      fenceMarker = '`'
      fenceLength = 3
      pendingFactualValue = false
      continue
    }
    if (fence) {
      const documentFence = indentationWidth(fence[1]) <= 3 && (fence[2][0] === '~' || !fence[3].includes('`'))
      const factualFence = pendingFactualValue && fence[2] === '```' && /^(?:json)?[ \t]*$/.test(fence[3])
      if (documentFence || factualFence) {
        lines[index] = ' '.repeat(line.length)
        fenceMarker = fence[2][0]
        fenceLength = fence[2].length
        pendingFactualValue = false
        continue
      }
    }
    if (line.trim()) pendingFactualValue = /^[ \t]+(?:Root cause|Symptoms\/evidence):[ \t]*$/.test(line)
  }
  return lines.join('\n')
}

function findingSections(body: string): Finding[] {
  const structure = structuralText(body)
  const headings = [...structure.matchAll(/^## Findings[ \t]*$/gm)]
  if (headings.length !== 1 || headings[0].index === undefined) reject('rendered review has no unique Findings section')
  const heading = headings[0]
  const start = heading.index + heading[0].length
  const nextHeading = /^## (?!Findings\b)/gm
  nextHeading.lastIndex = start
  const end = nextHeading.exec(structure)?.index ?? body.length
  const conventional = /^[\t ]*[-*]?[\t ]*(?:issue|suggestion|todo|nitpick|thought|question|praise)(?:\([a-z-]+\))?:/m
  if (conventional.test(structure.slice(0, heading.index)) || conventional.test(structure.slice(end))) {
    reject('rendered review contains a Conventional Comment outside Findings')
  }

  const section = structure.slice(start, end)
  const groupHeaders = [...section.matchAll(/^### ([^\n]+?)[ \t]*$/gm)]
  const groups = new Map<string, { content: string; structure: string }>()
  let cursor = 0
  for (const [index, groupHeader] of groupHeaders.entries()) {
    const groupStart = groupHeader.index ?? 0
    if (conventional.test(section.slice(cursor, groupStart)))
      reject('rendered review contains an ungrouped Conventional Comment')
    const group = groupHeader[1]
    if (groups.has(group)) reject(`rendered review repeats group ${group}`)
    const contentStart = groupStart + groupHeader[0].length
    const contentEnd = groupHeaders[index + 1]?.index ?? section.length
    groups.set(group, {
      content: body.slice(start + contentStart, start + contentEnd),
      structure: section.slice(contentStart, contentEnd),
    })
    cursor = contentEnd
  }
  if (conventional.test(section.slice(cursor))) reject('rendered review contains an ungrouped Conventional Comment')
  if (
    groups.size !== EXPECTED_FINDINGS.length ||
    [...groups.keys()].some((group) => !EXPECTED_FINDINGS.some((expected) => expected.group === group))
  ) {
    reject('rendered review has wrong finding groups')
  }

  const findings: Finding[] = []
  for (const [group, { content, structure }] of groups) {
    const records = [
      ...structure.matchAll(
        /^[\t ]*[-*]?[\t ]*((?:issue|suggestion|todo|nitpick|thought|question|praise)(?:\([a-z-]+\))?):[^\n]*(?:\n|$)/gm,
      ),
    ]
    for (const [index, record] of records.entries()) {
      const start = record.index ?? 0
      const end = records[index + 1]?.index ?? content.length
      findings.push({
        group,
        label: `${record[1]}:`,
        content: content.slice(start, end),
        structure: structure.slice(start, end),
      })
    }
  }
  if (findings.length !== EXPECTED_FINDINGS.length) reject('rendered review has wrong number of findings')
  return findings
}

function indentationWidth(indentation: string): number {
  let width = 0
  for (const character of indentation) width += character === '\t' ? 4 - (width % 4) : 1
  return width
}

function namedFields(content: string, structure: string): Map<string, string[]> {
  const matches = [
    ...structure.matchAll(/^([ \t]+)(Provenance|Root cause|Symptoms\/evidence|Raw callsites):[ \t]*(.*)$/gm),
  ]
  const fields = new Map<string, string[]>()
  for (const [index, match] of matches.entries()) {
    const name = match[2]
    const start = (match.index ?? 0) + match[0].length - match[3].length
    const indentation = indentationWidth(match[1])
    const peers = /\n([ \t]+)(?:-- |[A-Za-z][A-Za-z /-]*:)/g
    peers.lastIndex = start
    let boundary = peers.exec(structure)
    while (boundary && indentationWidth(boundary[1]) > indentation) boundary = peers.exec(structure)
    const value = content.slice(start, boundary?.index).trim()
    const values = fields.get(name) ?? []
    values.push(value)
    fields.set(name, values)
    if (index === matches.length - 1) break
  }
  return fields
}

function oneField(fields: Map<string, string[]>, name: string, citation: string): string {
  const values = fields.get(name)
  if (values?.length !== 1) reject(`${citation} must contain exactly one ${name} field`)
  return values[0]
}

function qualifyFinding(finding: Finding): void {
  const expected = EXPECTED_FINDINGS.find(
    (candidate) => candidate.group === finding.group && candidate.label === finding.label,
  )
  if (!expected) reject(`unexpected finding ${finding.group}/${finding.label}`)

  const citations = [...finding.structure.matchAll(/^[ \t]+([A-Za-z0-9_./-]+:\d+)[ \t]*$/gm)].map((match) => match[1])
  if (citations.length !== 1 || citations[0] !== expected.citation)
    reject(`${expected.citation} must have exactly one matching citation`)
  const emitters = [...finding.structure.matchAll(/^[ \t]+-- ([^\n]+?)[ \t]*$/gm)].map((match) => match[1])
  if (emitters.length !== 1 || emitters[0] !== expected.emitter)
    reject(`${expected.citation} must have exactly one matching emitter`)

  const fields = namedFields(finding.content, finding.structure)
  const cause = unwrapJson(oneField(fields, 'Root cause', expected.citation), `${expected.citation} Root cause`)
  const witness = unwrapJson(
    oneField(fields, 'Symptoms/evidence', expected.citation),
    `${expected.citation} Symptoms/evidence`,
  )
  if (!Array.isArray(cause) || !Array.isArray(witness)) reject(`${expected.citation} factual carriers must be arrays`)
  assert.deepStrictEqual(cause, expected.cause, `${expected.citation} Root cause is wrong`)
  assert.deepStrictEqual(witness, expected.witness, `${expected.citation} Symptoms/evidence is wrong`)

  assertMetadata(parseFlow(oneField(fields, 'Provenance', expected.citation)), expected)
  sameCallsites(
    parseCallsites(
      parseFlow(oneField(fields, 'Raw callsites', expected.citation)),
      `${expected.citation} raw callsites`,
    ),
    expected.provenance.callsites,
    `${expected.citation} raw callsites`,
  )
}

/** Qualifies only the captured Phase 4 baseline; it neither classifies findings nor judges unrestricted prose. */
export function qualifyPhase4Baseline(body: string): void {
  try {
    if (!/^<!-- omp-build:code-review -->[ \t]*(?:\n|$)/.test(body))
      reject('rendered review lacks the OMP code-review marker')
    const findings = findingSections(body)
    const identities = new Set<string>()
    for (const finding of findings) {
      const identity = `${finding.group}\u0000${finding.label}`
      if (identities.has(identity)) reject(`rendered review repeats finding ${finding.group}/${finding.label}`)
      identities.add(identity)
      qualifyFinding(finding)
    }
    if (identities.size !== EXPECTED_FINDINGS.length) reject('rendered review is missing a baseline finding')
  } catch (error) {
    if (error instanceof AssertionError) throw error
    reject(`malformed Phase 4 baseline: ${error instanceof Error ? error.message : String(error)}`)
  }
}
