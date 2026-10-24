import type { ContractProvenance } from './proof-semctx-protocol'

/** Native close sorts flat file links; no other source formatting is equivalent here. */
function sortFileLinkRuns(lines: string[]): void {
  const fileLink = /^ {2}link: file:\S[^\r\n]*\r?$/
  for (let start = 0; start < lines.length; ) {
    if (!fileLink.test(lines[start] ?? '')) {
      start++
      continue
    }
    let end = start + 1
    while (end < lines.length && fileLink.test(lines[end] ?? '')) end++
    if (end - start > 1) {
      const sorted = lines.slice(start, end).sort()
      for (let index = start; index < end; index++) lines[index] = sorted[index - start] as string
    }
    start = end
  }
}

type StatusTransition = { line: number; replacement: string }
type RetainedFields = { status: StatusTransition; provenance: ContractProvenance }
type RetainedFieldState = Partial<RetainedFields>
type ParsedRetainedLine = {
  header: boolean
  field: StatusTransition | ContractProvenance | null
}

function isIgnorable(line: string): boolean {
  const content = line.trim()
  return content === '' || content.startsWith('#')
}

function isChangeHeader(line: string, id: string): boolean {
  return /^change\s+(\S+)\s*$/.exec(line)?.[1] === id
}

function isIndented(line: string): boolean {
  return line[0] === ' ' || line[0] === '\t'
}

function statusTransition(line: string, colon: number, index: number): StatusTransition | undefined | null {
  const raw = line.slice(colon + 1)
  const value = raw.trim()
  if (line.slice(0, colon).trim() !== 'status') return null
  if (value !== 'active' && value !== 'partial' && value !== 'verified') return undefined
  return { line: index, replacement: line.slice(0, colon + 1) + raw.replace(value, 'superseded') }
}

function provenanceOf(line: string, colon: number): ContractProvenance | undefined | null {
  if (line.slice(0, colon).trim() !== 'provenance') return null
  const value = line.slice(colon + 1).trim()
  return value === 'author' || value === 'agent' || value === 'derived' ? value : undefined
}

function retainedField(
  line: string,
  colon: number,
  index: number,
): StatusTransition | ContractProvenance | undefined | null {
  const status = statusTransition(line, colon, index)
  return status === null ? provenanceOf(line, colon) : status
}

function readRetainedLine(
  line: string,
  index: number,
  id: string,
  headerSeen: boolean,
): ParsedRetainedLine | undefined {
  if (isIgnorable(line)) return { header: false, field: null }
  if (!headerSeen) return isChangeHeader(line, id) ? { header: true, field: null } : undefined
  if (!isIndented(line)) return undefined
  const colon = line.indexOf(':')
  if (colon < 0) return { header: false, field: null }
  const field = retainedField(line, colon, index)
  return field === undefined ? undefined : { header: false, field }
}

function retainField(state: RetainedFieldState, field: StatusTransition | ContractProvenance): boolean {
  if (typeof field === 'string') {
    if (state.provenance !== undefined) return false
    state.provenance = field
    return true
  }
  if (state.status) return false
  state.status = field
  return true
}

function retainedFields(lines: string[], id: string): RetainedFields | undefined {
  let headerSeen = false
  const retained: RetainedFieldState = {}
  for (const [index, line] of lines.entries()) {
    const parsed = readRetainedLine(line, index, id, headerSeen)
    if (parsed === undefined) return undefined
    if (parsed.header) {
      headerSeen = true
      continue
    }
    if (parsed.field !== null && !retainField(retained, parsed.field)) return undefined
  }
  return retained.status && retained.provenance !== undefined
    ? { status: retained.status, provenance: retained.provenance }
    : undefined
}

/** A bounded source transition, not a replacement Semctx parser or transmission claim. */
export function retainedProvenance(before: string, after: string, id: string): ContractProvenance | undefined {
  const original = before.split('\n')
  const candidate = after.split('\n')
  if (original.length !== candidate.length) return undefined
  const retained = retainedFields(original, id)
  if (!retained) return undefined
  original[retained.status.line] = retained.status.replacement
  sortFileLinkRuns(original)
  sortFileLinkRuns(candidate)
  return original.every((line, index) => line === candidate[index]) ? retained.provenance : undefined
}
