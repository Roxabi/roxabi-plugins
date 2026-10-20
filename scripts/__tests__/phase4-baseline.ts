import { AssertionError } from 'node:assert'
import assert from 'node:assert/strict'

type FlowValue = string | number | boolean | null | FlowValue[] | FlowMap
type FlowMap = Map<string, FlowValue>
type LeafKind = 'active' | 'literal' | 'comment' | 'inline' | 'data'

type Span = { start: number; end: number; kind: LeafKind }
type Block =
  | { kind: 'heading'; level: number; title: string; prefixEnd: number }
  | { kind: 'list'; supported: boolean; prefixEnd: number }
  | {
      kind: 'fence'
      marker: '`' | '~'
      length: number
      column: number
      supported: boolean
      closing: boolean
      prefixEnd: number
    }
  | { kind: 'quote' | 'indent'; prefixEnd: number }
  | { kind: 'blank' | 'prose' }

type Line = {
  index: number
  start: number
  end: number
  text: string
  spans: Span[]
  block: Block
  identity: PeerIdentity | undefined
}

function ownsActive(line: Line, start: number, end: number): boolean {
  return end > start && line.spans.some((span) => span.kind === 'active' && span.start <= start && span.end >= end)
}

function activeMatch(line: Line, pattern: RegExp): RegExpExecArray | undefined {
  const match = pattern.exec(line.text)
  return match && ownsActive(line, match.index, match.index + match[0].length) ? match : undefined
}

function own(line: Line, start: number, end: number, kind: LeafKind): void {
  if (start === end) return
  const previous = line.spans.at(-1)
  if (previous?.kind === kind && previous.end === start) previous.end = end
  else line.spans.push({ start, end, kind })
}

function blockAt(text: string): Block {
  if (!text.trim()) return { kind: 'blank' }
  if (/^ {4}/.test(text)) return { kind: 'indent', prefixEnd: 4 }
  const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(text)
  if (heading) {
    const title = text
      .slice(heading[0].length)
      .replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
      .trimEnd()
    return { kind: 'heading', level: heading[1].length, title, prefixEnd: heading[0].length }
  }
  const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text)
  if (fence) {
    const marker = fence[2][0] as '`' | '~'
    return {
      kind: 'fence',
      marker,
      length: fence[2].length,
      column: fence[1].length,
      supported: marker === '~' || !fence[3].includes('`'),
      closing: /^[ \t]*$/.test(fence[3]),
      prefixEnd: fence[1].length + fence[2].length,
    }
  }
  const quote = /^ {0,3}>/.exec(text)
  if (quote) return { kind: 'quote', prefixEnd: quote[0].length }
  const list = /^( {0,3})([-+*]|\d+[.)])(?:[ \t]+|$)/.exec(text)
  if (list) {
    return {
      kind: 'list',
      supported: list[1].length === 0 && (list[2] === '-' || list[2] === '*') && text[list[2].length] === ' ',
      prefixEnd: list[0].length,
    }
  }
  return { kind: 'prose' }
}

type Heading = {
  line: number
  level: number
  title: string
}

type Field = {
  name: string
  valueStart: number
  end: number
}

type PeerIdentity =
  | { kind: 'field'; name: string; prefixEnd: number }
  | { kind: 'citation'; prefixEnd: number }
  | { kind: 'emitter'; prefixEnd: number }
  | { kind: 'unsupported'; prefixEnd: number }

type PeerNode =
  | Extract<PeerIdentity, { kind: 'field' }>
  | { kind: 'citation'; value: string; line: Line }
  | { kind: 'emitter'; value: string; line: Line }

type RecordNode = {
  group: string
  label: string
  startLine: number
  endLine: number
  fields: Map<string, Field[]>
  citations: Extract<PeerNode, { kind: 'citation' }>[]
  emitters: Extract<PeerNode, { kind: 'emitter' }>[]
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

const CONVENTIONAL_LABEL = '(?:issue|suggestion|todo|nitpick|thought|question|praise)(?:\\([a-z-]+\\))?'
const conventionalLine = new RegExp(`^([ \\t]*)(?:[-*][ \\t]*)?(${CONVENTIONAL_LABEL}):`)
const recordLine = new RegExp(`^ *(?:[-*] )?((?:${CONVENTIONAL_LABEL})):[^\\n]*$`)
const FIELD_NAME = '[A-Za-z][A-Za-z /-]*'
const CITATION_IDENTITY = '[A-Za-z0-9_./-]+:\\d+'
const fieldPrefix = new RegExp(`^ +(${FIELD_NAME}):[ \\t]*`)
const citationPrefix = new RegExp(`^ +${CITATION_IDENTITY}`)
const citationIdentity = new RegExp(`^ +(${CITATION_IDENTITY})[ \\t]*$`)
const emitterPrefix = /^ +-- /
const decoratedPeerPrefix = new RegExp(
  `^ {2}(?! )[*_~]+(?:${FIELD_NAME}(?:[*_~]+[ \\t]*:|:[*_~]+)|${CITATION_IDENTITY}[*_~]+)`,
)

function reject(message: string): never {
  throw new AssertionError({ message })
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) reject(message)
  return value
}

function located(line: Line, message: string): never {
  reject(`unsupported presentation at line ${line.index + 1}: ${message}`)
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
      if (character === '\\') this.#offset++
      else if (character === '"') return JSON.parse(this.source.slice(start, this.#offset)) as string
    }
    throw new SyntaxError('unterminated double-quoted scalar')
  }

  private readSingleQuoted(): string {
    this.#offset++
    let value = ''
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset++]
      if (character !== "'") value += character
      else if (this.source[this.#offset] === "'") {
        value += "'"
        this.#offset++
      } else return value
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
  if (asString(entry.get('agent'), `${expected.citation} provenance agent`) !== expected.provenance.agent)
    reject(`${expected.citation} provenance agent is wrong`)
  if (asString(entry.get('phase'), `${expected.citation} provenance phase`) !== 'panel')
    reject(`${expected.citation} provenance phase is wrong`)
  if (asPositiveInteger(entry.get('chunk'), `${expected.citation} provenance chunk`) !== 1)
    reject(`${expected.citation} provenance chunk is wrong`)
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

function escaped(text: string, offset: number): boolean {
  let slashes = 0
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index--) slashes++
  return slashes % 2 === 1
}

function isParagraphBoundary(line: Line): boolean {
  return line.block.kind !== 'prose'
}

function closingCodeSpan(
  lines: readonly Line[],
  startLine: number,
  offset: number,
  length: number,
): { line: number; end: number } | undefined {
  const delimiter = '`'.repeat(length)
  for (let index = startLine; index < lines.length; index++) {
    const line = lines[index]
    if (index > startLine) {
      if (/^\s*<!--/.test(line.text)) located(line, 'inline code cannot continue across a comment-opening line')
      if (isParagraphBoundary(line)) return undefined
    }
    let cursor = index === startLine ? offset + length : 0
    while (cursor < line.text.length) {
      const found = line.text.indexOf(delimiter, cursor)
      if (found === -1) break
      const before = line.text[found - 1]
      const after = line.text[found + length]
      if (!escaped(line.text, found) && before !== '`' && after !== '`') return { line: index, end: found + length }
      cursor = found + length
    }
  }
  return undefined
}

function headerStartsJsonFence(line: string): boolean {
  return /^ +(?! )(?:Root cause|Symptoms\/evidence):[ \t]*```(?:json)?[ \t]*$/.test(line)
}

function buildDocument(body: string): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const [index, text] of body.split('\n').entries()) {
    lines.push({
      index,
      start: offset,
      end: offset + text.length,
      text,
      spans: [],
      block: blockAt(text),
      identity: peerIdentity(text),
    })
    offset += text.length + 1
  }

  let commentOpen = false
  let fence: { marker: '`' | '~'; length: number } | undefined
  let dataFence = false
  let pendingData = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const block = line.block
    let cursor = line.spans.at(-1)?.end ?? 0
    if (cursor === line.text.length && cursor > 0) continue
    if (cursor === 0 && !commentOpen) {
      if (fence) {
        own(line, 0, line.text.length, 'literal')
        if (block.kind === 'fence' && block.marker === fence.marker && block.length >= fence.length && block.closing)
          fence = undefined
        continue
      }
      if (dataFence) {
        own(line, 0, line.text.length, 'data')
        if (block.kind === 'fence' && block.marker === '`' && block.length === 3 && block.column === 0 && block.closing)
          dataFence = false
        continue
      }
      if (pendingData) {
        if (block.kind === 'blank' || block.kind === 'indent') {
          own(line, 0, line.text.length, 'data')
          continue
        }
        pendingData = false
      }
      if (block.kind === 'fence' && block.supported) {
        own(line, 0, line.text.length, 'literal')
        fence = { marker: block.marker, length: block.length }
        continue
      }
      if (block.kind === 'indent') {
        own(line, 0, line.text.length, 'literal')
        continue
      }
    }

    while (cursor < line.text.length) {
      if (commentOpen) {
        const close = line.text.indexOf('-->', cursor)
        const end = close === -1 ? line.text.length : close + 3
        own(line, cursor, end, 'comment')
        cursor = end
        if (close === -1) break
        commentOpen = false
        continue
      }
      const comment = line.text.indexOf('<!--', cursor)
      const tick = line.text.indexOf('`', cursor)
      const next = comment >= 0 && (tick < 0 || comment < tick) ? comment : tick
      if (next < 0) {
        own(line, cursor, line.text.length, 'active')
        break
      }
      own(line, cursor, next, 'active')
      if (next === comment) {
        if (escaped(line.text, next)) {
          own(line, next, next + 4, 'active')
          cursor = next + 4
        } else {
          commentOpen = true
          cursor = next
        }
        continue
      }
      let length = 1
      while (line.text[next + length] === '`') length++
      const close = escaped(line.text, next) ? undefined : closingCodeSpan(lines, index, next, length)
      if (!close) {
        own(line, next, next + length, 'active')
        cursor = next + length
        continue
      }
      own(line, next, close.line === index ? close.end : line.text.length, 'inline')
      for (let covered = index + 1; covered <= close.line; covered++) {
        own(lines[covered], 0, covered === close.line ? close.end : lines[covered].text.length, 'inline')
      }
      cursor = close.line === index ? close.end : line.text.length
    }
    const identity = line.identity
    if (identity?.kind === 'field' && ownsActive(line, 0, identity.prefixEnd)) {
      if (headerStartsJsonFence(line.text)) dataFence = true
      else if (identity.prefixEnd === line.text.length) pendingData = true
    }
  }
  if (commentOpen) located(lines[lines.length - 1], 'HTML comment is not closed')
  if (fence) located(lines[lines.length - 1], 'literal fence is not closed')
  if (dataFence) located(lines[lines.length - 1], 'JSON fence is not closed')

  for (const line of lines) {
    if (activeMatch(line, new RegExp(`^(?:[-*] )?(?:\\*\\*|__|\`)(?:${CONVENTIONAL_LABEL})(?:\\*\\*|__|\`):`)))
      located(line, 'finding identities cannot be decorated')
    if (activeMatch(line, new RegExp(`^ {1,3}(?! )(?:[-*] )?${CONVENTIONAL_LABEL}:`)))
      located(line, 'finding identities must be plain or column-zero bullets')
    const identity = line.identity
    if (
      identity &&
      identity.kind !== 'unsupported' &&
      ownsActive(line, 0, identity.prefixEnd) &&
      (line.text[1] !== ' ' || line.text[2] === ' ')
    )
      located(line, 'record fields require two-space indentation')
    for (const span of line.spans) {
      if (span.kind !== 'active') continue
      const tab = line.text.indexOf('\t', span.start)
      if (tab >= 0 && tab < span.end) located(line, 'structural tabs are not supported')
    }
    if (line.block.kind === 'quote' && ownsActive(line, 0, line.block.prefixEnd))
      located(line, 'blockquotes are not supported')
    if (line.block.kind === 'list' && !line.block.supported && ownsActive(line, 0, line.block.prefixEnd))
      located(line, 'ordered, plus and indented active lists are not supported')
    if (activeMatch(line, /^(?:=+|-+)[ \t]*$/)) located(line, 'alternate heading forms are not supported')
    if (activeMatch(line, /^\s*\|/) || activeMatch(line, /\|\s*$/)) located(line, 'tables are not supported')
    const html = /<\/?[A-Za-z]/g
    for (const match of line.text.matchAll(html)) {
      if (ownsActive(line, match.index, match.index + match[0].length) && !escaped(line.text, match.index))
        located(line, 'raw HTML elements are not supported')
    }
  }
  return lines
}

function activeHeading(line: Line): { level: number; title: string } | undefined {
  return line.block.kind === 'heading' && ownsActive(line, 0, line.block.prefixEnd) ? line.block : undefined
}

function peerIdentity(text: string): PeerIdentity | undefined {
  const decorated = decoratedPeerPrefix.exec(text)
  if (decorated) return { kind: 'unsupported', prefixEnd: decorated[0].length }
  const citation = citationPrefix.exec(text)
  if (citation) return { kind: 'citation', prefixEnd: citation[0].length }
  const emitter = emitterPrefix.exec(text)
  if (emitter) return { kind: 'emitter', prefixEnd: emitter[0].length }
  const field = fieldPrefix.exec(text)
  return field ? { kind: 'field', name: field[1], prefixEnd: field[0].length } : undefined
}

function peer(line: Line): PeerNode | undefined {
  const identity = line.identity
  if (!identity || !ownsActive(line, 0, identity.prefixEnd)) return undefined
  if (identity.kind === 'unsupported') located(line, 'factual identities require a supported plain shape')
  if (identity.kind === 'citation') {
    const citation = citationIdentity.exec(line.text)
    if (!citation) located(line, 'citation requires one complete plain identity')
    return { kind: 'citation', value: citation[1], line }
  }
  if (identity.kind === 'emitter') {
    const emitter = /^ +-- ([^\n]*?)[ \t]*$/.exec(line.text)
    if (!emitter) located(line, 'emitter requires one complete plain identity')
    return { kind: 'emitter', value: emitter[1], line }
  }
  return identity
}

function conventionalAt(line: Line): RegExpExecArray | undefined {
  return activeMatch(line, conventionalLine)
}

function recordAt(line: Line): RegExpExecArray | undefined {
  return conventionalAt(line) ? (recordLine.exec(line.text) ?? undefined) : undefined
}

function findRecordNodes(body: string, lines: readonly Line[]): RecordNode[] {
  const headings: Heading[] = []
  for (const line of lines) {
    const heading = activeHeading(line)
    if (heading) headings.push({ line: line.index, ...heading })
  }

  let ordinaryPlanBulletsAllowed = false
  for (const line of lines) {
    const heading = activeHeading(line)
    if (heading && heading.level <= 2)
      ordinaryPlanBulletsAllowed = heading.level === 2 && heading.title === 'Root causes'
    if (
      line.block.kind === 'list' &&
      ownsActive(line, 0, line.block.prefixEnd) &&
      !recordAt(line) &&
      !ordinaryPlanBulletsAllowed
    )
      located(line, 'only finding headers may be list items')
  }
  const findings = headings.filter((heading) => heading.level === 2 && heading.title === 'Findings')
  if (findings.length !== 1) {
    const groupLine = lines.findIndex(
      (line) => line.block.kind === 'heading' && ['Blockers', 'Warnings'].includes(line.block.title),
    )
    const parent = lines.findLast(
      (line) => (groupLine < 0 || line.index < groupLine) && line.block.kind === 'heading' && line.block.level <= 2,
    )
    located(
      findings.length > 1 ? lines[findings[1].line] : (parent ?? lines[0]),
      'rendered review has no unique Findings section',
    )
  }
  const findingsHeading = findings[0]
  const sectionEnd =
    headings.find((heading) => heading.line > findingsHeading.line && heading.level <= 2)?.line ?? lines.length
  const groups = headings.filter(
    (heading) => heading.line > findingsHeading.line && heading.line < sectionEnd && heading.level === 3,
  )
  if (
    groups.length !== EXPECTED_FINDINGS.length ||
    new Set(groups.map((group) => group.title)).size !== groups.length ||
    groups.some((group) => !EXPECTED_FINDINGS.some((expected) => expected.group === group.title))
  ) {
    located(lines[sectionEnd] ?? lines[findingsHeading.line], 'rendered review has wrong finding groups')
  }

  const groupAt = new Map<number, string>()
  for (const group of groups) {
    const end = groups.find((candidate) => candidate.line > group.line)?.line ?? sectionEnd
    for (let line = group.line + 1; line < end; line++) groupAt.set(line, group.title)
  }
  for (const line of lines) {
    const conventional = conventionalAt(line)
    if (!conventional) continue
    const group = groupAt.get(line.index)
    const record = recordAt(line)
    if (!group) located(line, 'rendered review contains a Conventional Comment outside Findings')
    if (!record) located(line, 'finding identities must be plain or column-zero bullets')
  }

  const records: RecordNode[] = []
  for (const group of groups) {
    const groupEnd = groups.find((candidate) => candidate.line > group.line)?.line ?? sectionEnd
    const starts: { line: number; label: string }[] = []
    for (let index = group.line + 1; index < groupEnd; index++) {
      const match = recordAt(lines[index])
      if (match) starts.push({ line: index, label: `${match[1]}:` })
    }
    for (const [position, start] of starts.entries()) {
      const endLine = starts[position + 1]?.line ?? groupEnd
      const peers: { line: Line; node: PeerNode }[] = []
      for (let index = start.line + 1; index < endLine; index++) {
        const node = peer(lines[index])
        if (node) peers.push({ line: lines[index], node })
      }
      const fields = new Map<string, Field[]>()
      const citations: Extract<PeerNode, { kind: 'citation' }>[] = []
      const emitters: Extract<PeerNode, { kind: 'emitter' }>[] = []
      for (const [position, entry] of peers.entries()) {
        if (!entry.node) continue
        if (entry.node.kind === 'citation') citations.push(entry.node)
        else if (entry.node.kind === 'emitter') emitters.push(entry.node)
        else {
          const boundary = peers[position + 1]?.line.start ?? lines[endLine]?.start ?? body.length
          const values = fields.get(entry.node.name) ?? []
          values.push({ name: entry.node.name, valueStart: entry.line.start + entry.node.prefixEnd, end: boundary })
          fields.set(entry.node.name, values)
        }
      }
      records.push({
        group: group.title,
        label: start.label,
        startLine: start.line,
        endLine,
        fields,
        citations,
        emitters,
      })
    }
  }
  if (records.length !== EXPECTED_FINDINGS.length) reject('rendered review has wrong number of findings')
  return records
}

function oneField(record: RecordNode, body: string, name: string, citation: string): string {
  const fields = record.fields.get(name)
  if (fields?.length !== 1) reject(`${citation} must contain exactly one ${name} field`)
  return body.slice(fields[0].valueStart, fields[0].end).trim()
}

function qualifyRecord(record: RecordNode, body: string): void {
  const expected = EXPECTED_FINDINGS.find(
    (candidate) => candidate.group === record.group && candidate.label === record.label,
  )
  if (!expected) reject(`unexpected finding ${record.group}/${record.label}`)
  if (record.citations.length !== 1) reject(`${expected.citation} must have exactly one matching citation`)
  if (record.citations[0].value !== expected.citation)
    located(record.citations[0].line, 'citation does not match the complete expected identity')
  if (record.emitters.length !== 1) reject(`${expected.citation} must have exactly one matching emitter`)
  if (record.emitters[0].value !== expected.emitter)
    located(record.emitters[0].line, 'emitter does not match the complete expected identity')

  const cause = unwrapJson(oneField(record, body, 'Root cause', expected.citation), `${expected.citation} Root cause`)
  const witness = unwrapJson(
    oneField(record, body, 'Symptoms/evidence', expected.citation),
    `${expected.citation} Symptoms/evidence`,
  )
  if (!Array.isArray(cause) || !Array.isArray(witness)) reject(`${expected.citation} factual carriers must be arrays`)
  assert.deepStrictEqual(cause, expected.cause, `${expected.citation} Root cause is wrong`)
  assert.deepStrictEqual(witness, expected.witness, `${expected.citation} Symptoms/evidence is wrong`)
  assertMetadata(parseFlow(oneField(record, body, 'Provenance', expected.citation)), expected)
  sameCallsites(
    parseCallsites(
      parseFlow(oneField(record, body, 'Raw callsites', expected.citation)),
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
    const lines = buildDocument(body)
    const records = findRecordNodes(body, lines)
    const identities = new Set<string>()
    for (const record of records) {
      const identity = `${record.group}\u0000${record.label}`
      if (identities.has(identity)) reject(`rendered review repeats finding ${record.group}/${record.label}`)
      identities.add(identity)
      qualifyRecord(record, body)
    }
    if (identities.size !== EXPECTED_FINDINGS.length) reject('rendered review is missing a baseline finding')
  } catch (error) {
    if (error instanceof AssertionError) throw error
    reject(`malformed Phase 4 baseline: ${error instanceof Error ? error.message : String(error)}`)
  }
}
