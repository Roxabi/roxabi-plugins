import type { OperationRead } from './history-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { ObservedComment } from './review-schema.ts'

export type UnclaimedOperation = Omit<OperationRead, 'authority' | 'claimedKinds'> & { parsedKind?: string }
export type ClaimedOperation = Omit<OperationRead, 'authority'>
export type Frame = {
  comment: ObservedComment
  version: string
  kind: string
  recordId: string
  operationId: string
  part: number
  total: number
  data: string
}
export type FrameFailure = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
  diagnostic: Diagnostic
}
export type LooseHeaderClue = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
}

export const WIRE_PREFIX = '<!-- omp-build-record '
export const HEADER =
  /^<!-- omp-build-record v=(1) kind=([a-z][a-z0-9-]*) id=([^\s<>]+) operationId=([^\s<>]+) part=([1-9][0-9]*)\/([1-9][0-9]*) data=([A-Za-z0-9_-]+) -->\n[\s\S]*$/
export const encoder = new TextEncoder()
export const decoder = new TextDecoder('utf-8', { fatal: true })
export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}
export function utf8Bytes(value: string): number {
  return utf8(value).byteLength
}
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}
export function canonicalUtf8(value: string): boolean {
  try {
    return decoder.decode(utf8(value)) === value
  } catch {
    return false
  }
}
export function decodeHeaderIdentifier(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 && encodeURIComponent(decoded) === value ? decoded : null
  } catch {
    return null
  }
}
