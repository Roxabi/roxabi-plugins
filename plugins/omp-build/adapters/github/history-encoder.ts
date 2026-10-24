import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { Result } from '../../engine/result.ts'
import { base64url, canonicalUtf8, diagnostic, utf8, utf8Bytes } from './types.ts'

function failure<T>(diagnostics: Diagnostic[]): Result<T> {
  return { ok: false, diagnostics }
}

function header(record: CanonicalRecord, part: number, total: number, data: string): string {
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${encodeURIComponent(record.recordId)} operationId=${encodeURIComponent(record.operationId)} part=${part}/${total} data=${data} -->`
}

function textPrefix(value: string, offset: number, byteLimit: number): { text: string; next: number } | null {
  if (byteLimit < 0) return null

  let bytes = 0
  let next = offset
  for (const character of value.slice(offset)) {
    const width = utf8Bytes(character)
    if (bytes + width > byteLimit) break
    bytes += width
    next += character.length
  }

  return { text: value.slice(offset, next), next }
}

export function encodeParts(record: CanonicalRecord, projection: string, maxCommentBytes: number): Result<string[]> {
  if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 1)
    return failure([diagnostic('invalid-limit', 'Comment byte limit must be a positive safe integer')])

  try {
    encodeURIComponent(record.recordId)
    encodeURIComponent(record.operationId)
  } catch {
    return failure([diagnostic('invalid-framing', 'Record and operation IDs must be valid Unicode identifiers')])
  }

  const serialized = JSON.stringify(record)
  if (!canonicalUtf8(serialized) || !canonicalUtf8(projection))
    return failure([diagnostic('invalid-encoding', 'Record projection is not canonical UTF-8')])

  const encoded = base64url(utf8(serialized))
  const maximumParts = encoded.length + utf8Bytes(projection) + 1
  for (let total = 1; total <= maximumParts; total += 1) {
    const parts: string[] = []
    let dataOffset = 0
    let projectionOffset = 0
    let valid = true

    for (let part = 1; part <= total; part += 1) {
      const remainingParts = total - part + 1
      const dataLength = Math.ceil((encoded.length - dataOffset) / remainingParts)
      const data = encoded.slice(dataOffset, dataOffset + dataLength)
      const frame = header(record, part, total, data)
      const text = textPrefix(projection, projectionOffset, maxCommentBytes - utf8Bytes(frame) - 1)
      if (text === null || utf8Bytes(frame) + 1 + utf8Bytes(text.text) > maxCommentBytes) {
        valid = false
        break
      }

      parts.push(`${frame}\n${text.text}`)
      dataOffset += data.length
      projectionOffset = text.next
    }

    if (valid && dataOffset === encoded.length && projectionOffset === projection.length)
      return { ok: true, value: parts }
  }

  return failure([
    diagnostic(
      'comment-too-large',
      'The record and complete human projection cannot fit the requested comment byte limit',
    ),
  ])
}
