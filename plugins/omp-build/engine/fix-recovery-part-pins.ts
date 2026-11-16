import { createHash } from 'node:crypto'
import type { PartPin } from './fix-recovery-identities.ts'
import type { OperationRead } from './history-schema.ts'

const PART_HEADER =
  /^<!-- omp-build-record v=1 kind=[a-z][a-z0-9-]* id=[^\s<>]+ operationId=[^\s<>]+ part=([1-9][0-9]*)\/([1-9][0-9]*) data=[A-Za-z0-9_-]+ -->\n/

export function commentAsPartPin(comment: OperationRead['parts'][number]): PartPin | null {
  const match = PART_HEADER.exec(comment.body)
  if (match === null || !comment.author || !comment.nativeId || !comment.locator) return null
  const part = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || part > total) return null
  return {
    locator: comment.locator,
    nativeId: comment.nativeId,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    bodyDigest: createHash('sha256').update(comment.body, 'utf8').digest('hex'),
    part,
    total,
  }
}

export function partPinsEqual(left: PartPin, right: PartPin): boolean {
  return (
    left.locator === right.locator &&
    left.nativeId === right.nativeId &&
    left.author === right.author &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.bodyDigest === right.bodyDigest &&
    left.part === right.part &&
    left.total === right.total
  )
}

export function observedPartsMatch(expected: readonly PartPin[], operation: OperationRead, exact = true): boolean {
  const observed = operation.parts.map(commentAsPartPin)
  if ((exact && observed.length !== expected.length) || observed.some((entry) => entry === null)) return false
  const remaining = [...observed]
  for (const pin of expected) {
    const index = remaining.findIndex((entry) => entry !== null && partPinsEqual(entry, pin))
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return true
}
